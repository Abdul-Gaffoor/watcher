import {
  CATALOG_VERSION,
  ID_PATTERN,
  isOwnedMediaKey,
  migrateFromV1,
  posterKeyFor,
  sourceKeyFor,
  validateCatalog,
} from './catalog.mjs';
import { credentialsFromEnv, presignS3 } from './sigv4.mjs';

/**
 * The dashboard's API. Two jobs, and it is careful to do only those.
 *
 * It edits the catalog, which now lives in the media bucket rather than in git,
 * because a dashboard that could not write it would be a viewer.
 *
 * And it mints presigned URLs so the browser can upload straight to S3. Video
 * cannot pass through Lambda: the response and request limits are megabytes and
 * a lesson is gigabytes. So the bytes never touch this service, and what it
 * controls instead is the only thing that matters — which key may be written,
 * and by whom.
 */

const CATALOG_KEY = 'media/catalog.json';
const UPLOAD_URL_TTL = 60 * 60;
const CATALOG_URL_TTL = 60;
const MAX_PARTS_PER_REQUEST = 100;

/** Extensions we are willing to store and later serve as a video source. */
const ALLOWED_EXTENSIONS = new Map([
  ['mp4', 'video/mp4'],
  ['m4v', 'video/mp4'],
  ['mov', 'video/quicktime'],
  ['webm', 'video/webm'],
]);

export class AdminError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.name = 'AdminError';
    this.status = status;
    this.extra = extra;
  }
}

export function isAdmin(user) {
  return Array.isArray(user?.roles) && user.roles.includes('admin');
}

/**
 * The dev server has no bucket. Rather than make the dashboard undevelopable,
 * it points at a file on disk, so structure editing behaves identically
 * locally. Uploading still needs real storage and says so.
 */
function localCatalogPath(config) {
  return config.localCatalogPath ?? null;
}

function mediaConfig(config) {
  if (!config.mediaBucket || !config.mediaRegion) {
    throw new AdminError(
      'Uploading needs object storage, which this deployment has not got. Structure editing still works.',
      501,
    );
  }
  return {
    bucket: config.mediaBucket,
    region: config.mediaRegion,
    credentials: credentialsFromEnv(),
  };
}

/** Reads the catalog through a short-lived presigned GET, as the edge does. */
export async function readCatalog(config, { fetchImpl = fetch, fs = null } = {}) {
  const local = localCatalogPath(config);
  if (local) {
    const nodeFs = fs ?? (await import('node:fs/promises'));
    try {
      const parsed = JSON.parse(await nodeFs.readFile(local, 'utf8'));
      return parsed.version === CATALOG_VERSION ? parsed : migrateFromV1(parsed);
    } catch {
      return { version: CATALOG_VERSION, revision: 0, collections: [], titles: [] };
    }
  }

  const { bucket, region, credentials } = mediaConfig(config);
  const url = presignS3({
    method: 'GET',
    bucket,
    key: CATALOG_KEY,
    region,
    credentials,
    expiresIn: CATALOG_URL_TTL,
  });

  const response = await fetchImpl(url);
  if (response.status === 404) {
    // An empty library is a legitimate starting state, not an error.
    return { version: CATALOG_VERSION, revision: 0, collections: [], titles: [] };
  }
  if (!response.ok) throw new AdminError('Could not read the catalog.', 502);

  const parsed = JSON.parse(await response.text());
  return parsed.version === CATALOG_VERSION ? parsed : migrateFromV1(parsed);
}

/**
 * Writes the catalog, refusing if somebody else has written since this copy was
 * read. Compared by revision rather than by S3's own preconditions, so the rule
 * is visible in the document itself and does not depend on which conditional
 * headers survive a presigned request.
 */
export async function writeCatalog(config, { catalog, baseRevision }, { fetchImpl = fetch, fs = null } = {}) {
  const errors = validateCatalog(catalog);
  if (errors.length > 0) throw new AdminError('That catalog is not valid.', 422, { errors });

  const current = await readCatalog(config, { fetchImpl, fs });
  if (Number(baseRevision) !== Number(current.revision ?? 0)) {
    throw new AdminError(
      'Somebody else changed the catalog while you were editing. Reload and reapply your change.',
      409,
      { revision: current.revision ?? 0 },
    );
  }

  const next = {
    ...catalog,
    version: CATALOG_VERSION,
    revision: Number(current.revision ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  };

  const local = localCatalogPath(config);
  if (local) {
    const nodeFs = fs ?? (await import('node:fs/promises'));
    await nodeFs.writeFile(local, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }

  const { bucket, region, credentials } = mediaConfig(config);
  const url = presignS3({
    method: 'PUT',
    bucket,
    key: CATALOG_KEY,
    region,
    credentials,
    expiresIn: CATALOG_URL_TTL,
  });

  const response = await fetchImpl(url, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Short, because the dashboard edits it and a stale copy is confusing.
      'cache-control': 'public, max-age=30',
    },
    body: JSON.stringify(next),
  });
  if (!response.ok) throw new AdminError('Could not save the catalog.', 502);

  return next;
}

function extensionOf(filename) {
  const dot = String(filename ?? '').lastIndexOf('.');
  return dot === -1 ? '' : String(filename).slice(dot + 1).toLowerCase();
}

/**
 * Signs one step of a multipart upload.
 *
 * The key is derived from the title id on `begin` and re-derived on every later
 * step, never taken from the request. That is the whole security boundary here:
 * an admin can upload, but only into the layout this service chose, and a
 * tampered key is refused rather than signed.
 */
export function signUpload(config, body) {
  const { bucket, region, credentials } = mediaConfig(config);
  const op = String(body.op ?? '');

  if (op === 'begin') {
    const titleId = String(body.titleId ?? '');
    if (!ID_PATTERN.test(titleId)) {
      throw new AdminError('That title id must be lowercase letters, digits and hyphens.');
    }
    const extension = extensionOf(body.filename);
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      throw new AdminError(
        `That file type is not supported. Use one of: ${[...ALLOWED_EXTENSIONS.keys()].join(', ')}.`,
      );
    }

    const key = sourceKeyFor(titleId, extension);
    return {
      key,
      contentType: ALLOWED_EXTENSIONS.get(extension),
      // The path the player will use once the catalog points at it.
      mediaPath: `/${key}`,
      url: presignS3({
        method: 'POST',
        bucket,
        key,
        region,
        credentials,
        extraQuery: { uploads: '' },
        expiresIn: UPLOAD_URL_TTL,
      }),
    };
  }

  if (op === 'poster') {
    // One PUT, not a multipart exchange: a poster is a couple of hundred
    // kilobytes, and the five-megabyte minimum part size makes multipart
    // actively wrong for it.
    const titleId = String(body.titleId ?? '');
    if (!ID_PATTERN.test(titleId)) {
      throw new AdminError('That title id must be lowercase letters, digits and hyphens.');
    }

    const key = posterKeyFor(titleId);
    return {
      key,
      contentType: 'image/jpeg',
      mediaPath: `/${key}`,
      url: presignS3({
        method: 'PUT',
        bucket,
        key,
        region,
        credentials,
        expiresIn: UPLOAD_URL_TTL,
      }),
    };
  }

  const key = String(body.key ?? '');
  if (!isOwnedMediaKey(key)) throw new AdminError('That is not an upload this service started.');
  const uploadId = String(body.uploadId ?? '');
  if (op !== 'parts' && uploadId === '') throw new AdminError('Missing uploadId.');

  if (op === 'parts') {
    const numbers = Array.isArray(body.partNumbers) ? body.partNumbers : [];
    if (numbers.length === 0 || numbers.length > MAX_PARTS_PER_REQUEST) {
      throw new AdminError(`Ask for between 1 and ${MAX_PARTS_PER_REQUEST} parts at a time.`);
    }
    if (!numbers.every((n) => Number.isInteger(n) && n >= 1 && n <= 10000)) {
      throw new AdminError('Part numbers must be whole numbers between 1 and 10000.');
    }
    if (uploadId === '') throw new AdminError('Missing uploadId.');

    return {
      urls: numbers.map((partNumber) => ({
        partNumber,
        url: presignS3({
          method: 'PUT',
          bucket,
          key,
          region,
          credentials,
          extraQuery: { partNumber: String(partNumber), uploadId },
          expiresIn: UPLOAD_URL_TTL,
        }),
      })),
    };
  }

  if (op === 'complete' || op === 'abort') {
    return {
      url: presignS3({
        method: op === 'complete' ? 'POST' : 'DELETE',
        bucket,
        key,
        region,
        credentials,
        extraQuery: { uploadId },
        expiresIn: UPLOAD_URL_TTL,
      }),
    };
  }

  throw new AdminError(`Unknown upload step: ${op}`);
}
