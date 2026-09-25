import { adminApi } from './api';

/**
 * Uploads a video from the browser straight into S3.
 *
 * It never passes through our own API, because it cannot: a request body
 * through Lambda is capped in megabytes and a lesson is gigabytes. The server's
 * only role is to sign each step, which is also where the security lives — it
 * decides the key, so the browser cannot choose where its bytes land.
 *
 * Multipart rather than a single PUT, because a single request for a multi
 * gigabyte file is one dropped connection away from starting over.
 */

/** S3 requires at least 5 MB per part except the last; 16 gives a 160 GB ceiling. */
const PART_SIZE = 16 * 1024 * 1024;
const MAX_URLS_PER_REQUEST = 100;

export interface UploadResult {
  /** The path to put in the title's sources, once the catalog is saved. */
  mediaPath: string;
}

export interface UploadHandle {
  promise: Promise<UploadResult>;
  cancel: () => void;
}

function tagFrom(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(xml);
  if (!match) throw new Error(`S3 did not return a ${tag}.`);
  return match[1];
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export function uploadVideo(
  file: File,
  titleId: string,
  onProgress: (fraction: number) => void,
): UploadHandle {
  const controller = new AbortController();

  const run = async (): Promise<UploadResult> => {
    const begin = await adminApi.signUpload({ op: 'begin', titleId, filename: file.name });

    const created = await fetch(begin.url, { method: 'POST', signal: controller.signal });
    if (!created.ok) throw new Error(`S3 refused to start the upload (${created.status}).`);
    const uploadId = tagFrom(await created.text(), 'UploadId');

    try {
      const partCount = Math.max(1, Math.ceil(file.size / PART_SIZE));
      const parts: { partNumber: number; etag: string }[] = [];

      for (let first = 1; first <= partCount; first += MAX_URLS_PER_REQUEST) {
        const batch: number[] = [];
        for (let n = first; n < first + MAX_URLS_PER_REQUEST && n <= partCount; n += 1) batch.push(n);

        const { urls } = await adminApi.signUpload({
          op: 'parts',
          key: begin.key,
          uploadId,
          partNumbers: batch,
        });

        // Sequential on purpose: parallel parts saturate a home connection and
        // make the progress bar lie about what has actually landed.
        for (const { partNumber, url } of urls) {
          const start = (partNumber - 1) * PART_SIZE;
          const slice = file.slice(start, Math.min(start + PART_SIZE, file.size));

          const put = await fetch(url, { method: 'PUT', body: slice, signal: controller.signal });
          if (!put.ok) throw new Error(`Part ${partNumber} failed (${put.status}).`);

          // Readable only because the bucket's CORS rule exposes it, and
          // finishing the upload is impossible without every part's tag.
          const etag = put.headers.get('etag');
          if (!etag) throw new Error('S3 did not return an ETag for that part.');

          parts.push({ partNumber, etag });
          onProgress(parts.length / partCount);
        }
      }

      const { url: completeUrl } = await adminApi.signUpload({
        op: 'complete',
        key: begin.key,
        uploadId,
      });

      const body = [
        '<CompleteMultipartUpload>',
        ...parts.map(
          ({ partNumber, etag }) =>
            `<Part><PartNumber>${partNumber}</PartNumber><ETag>${escapeXml(etag)}</ETag></Part>`,
        ),
        '</CompleteMultipartUpload>',
      ].join('');

      const completed = await fetch(completeUrl, { method: 'POST', body });
      const text = await completed.text();
      // S3 can answer 200 and still describe a failure in the body, so the
      // status alone is not enough to call this done.
      if (!completed.ok || text.includes('<Error>')) {
        throw new Error('S3 could not assemble the upload.');
      }

      return { mediaPath: begin.mediaPath };
    } catch (error) {
      // Abandoned parts are billed until they are cleaned up, so a failure
      // tidies after itself rather than leaving them behind.
      try {
        const { url } = await adminApi.signUpload({ op: 'abort', key: begin.key, uploadId });
        await fetch(url, { method: 'DELETE' });
      } catch {
        /* The original failure is the one worth reporting. */
      }
      throw error;
    }
  };

  return { promise: run(), cancel: () => controller.abort() };
}

/**
 * The poster frame, as a single PUT. Small enough that multipart would be
 * wrong for it — S3 requires five-megabyte parts, and this is a couple of
 * hundred kilobytes.
 *
 * Returns null on failure rather than throwing: the video is already in the
 * bucket by this point, and losing the whole upload over its thumbnail would
 * be a poor trade.
 */
export async function uploadPoster(titleId: string, blob: Blob): Promise<string | null> {
  try {
    const signed = await adminApi.signUpload({ op: 'poster', titleId });
    const response = await fetch(signed.url, {
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg' },
      body: blob,
    });
    return response.ok ? signed.mediaPath : null;
  } catch {
    return null;
  }
}
