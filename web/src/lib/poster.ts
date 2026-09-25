/**
 * A poster frame, taken from the video itself, in the browser, before the
 * bytes ever leave.
 *
 * The alternative is MediaConvert: a job, a queue, a role, a completion hook,
 * and a minute of waiting before a title has any artwork. All of that to get
 * one frame the browser already has decoded. So the admin's own machine takes
 * it, and a lesson has a real thumbnail the moment it finishes uploading.
 *
 * Everything here degrades to null rather than throwing. A poster is a nicety;
 * a video that will not decode in this particular browser must still upload.
 */

/** Wide enough to stay sharp on a television, small enough to stay under 200KB. */
const TARGET_WIDTH = 960;

/**
 * Ten percent in, which skips the fade-ups, title cards and black frames that
 * open most recordings, without landing so late that it spoils anything.
 */
const SEEK_FRACTION = 0.1;
const MIN_SEEK_SECONDS = 1;
const DECODE_TIMEOUT_MS = 20_000;

export interface CapturedPoster {
  blob: Blob;
  width: number;
  height: number;
  /** Seconds, read off the same element — saves asking the admin to type it. */
  durationSec: number;
}

function once<T extends Event>(target: EventTarget, event: string): Promise<T> {
  return new Promise((resolve) => target.addEventListener(event, resolve as EventListener, { once: true }));
}

/**
 * A frame that is entirely one colour is a frame worth skipping: it is the
 * black before the first cut, or a white flash. Sampled coarsely, because this
 * is a "did we get anything at all" check rather than image analysis.
 */
function looksBlank(context: CanvasRenderingContext2D, width: number, height: number): boolean {
  const { data } = context.getImageData(0, 0, width, height);
  let min = 255;
  let max = 0;

  for (let i = 0; i < data.length; i += 4 * 97) {
    const luma = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
    if (luma < min) min = luma;
    if (luma > max) max = luma;
  }
  return max - min < 12;
}

export async function capturePoster(file: File): Promise<CapturedPoster | null> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  // Required by Safari, which will not decode into a canvas from a file it
  // considers cross-origin without it.
  video.crossOrigin = 'anonymous';
  video.src = url;

  const timeout = new Promise<null>((resolve) => window.setTimeout(() => resolve(null), DECODE_TIMEOUT_MS));

  try {
    const ready = (async (): Promise<CapturedPoster | null> => {
      await Promise.race([once(video, 'loadedmetadata'), once(video, 'error')]);
      if (!video.videoWidth || !Number.isFinite(video.duration)) return null;

      const width = Math.min(TARGET_WIDTH, video.videoWidth);
      const height = Math.round((width / video.videoWidth) * video.videoHeight);

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return null;

      // Two attempts: the preferred moment, then a later one if that frame
      // turned out to be a black lead-in.
      for (const fraction of [SEEK_FRACTION, 0.35]) {
        video.currentTime = Math.max(MIN_SEEK_SECONDS, video.duration * fraction);
        await Promise.race([once(video, 'seeked'), once(video, 'error')]);

        context.drawImage(video, 0, 0, width, height);
        if (!looksBlank(context, width, height)) break;
      }

      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', 0.82),
      );
      if (!blob) return null;

      return { blob, width, height, durationSec: Math.round(video.duration) };
    })();

    return await Promise.race([ready, timeout]);
  } catch {
    // A codec this browser cannot decode, or a tainted canvas. Neither is a
    // reason to refuse the upload.
    return null;
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}
