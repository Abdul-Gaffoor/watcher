import { verifyJwt } from './crypto-utils.mjs';
import { credentialsFromEnv, presignGetObject } from './sigv4.mjs';

/**
 * Everything CloudFront used to do, minus the edge.
 *
 * This function stands in for the distribution when the account cannot create
 * one. It serves the app shell out of the private app bucket, and it is the
 * gate on /media/*: no trusted key group exists here, so the session JWT is
 * checked in code and access is granted by handing back a presigned S3 URL.
 *
 * Two things are deliberately different from the CloudFront path:
 *
 *  - Playlists are served inline rather than redirected. A player resolves the
 *    segment names inside a playlist against the URL it was finally fetched
 *    from, so redirecting a .m3u8 to S3 would make every segment resolve to an
 *    unsigned S3 URL and 403. Keeping the playlist on this origin keeps the
 *    segment paths pointing back here, where they get gated.
 *  - Nothing is cached anywhere. Every segment is an invocation plus an S3
 *    read, for every viewer. That is the cost of losing the edge.
 */

const SESSION_COOKIE = 'watcher_session';
const SHORT_FETCH_TTL = 60;

const CONTENT_TYPES = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8',
  vtt: 'text/vtt',
  m3u8: 'application/vnd.apple.mpegurl',
  ts: 'video/mp2t',
  m4s: 'video/iso.segment',
  mp4: 'video/mp4',
};

const TEXT_TYPES = new Set(['html', 'js', 'mjs', 'css', 'json', 'svg', 'txt', 'vtt', 'm3u8']);

function extensionOf(path) {
  const last = path.slice(path.lastIndexOf('/') + 1);
  const dot = last.lastIndexOf('.');
  return dot === -1 ? '' : last.slice(dot + 1).toLowerCase();
}

function getConfig() {
  const region = process.env.AWS_REGION;
  const appBucket = process.env.APP_BUCKET;
  const mediaBucket = process.env.MEDIA_BUCKET;
  const sessionSecret = process.env.SESSION_SECRET;
  if (!region || !appBucket || !mediaBucket || !sessionSecret) {
    throw new Error('Missing required environment variables');
  }
  const mediaTtl = Number(process.env.MEDIA_TTL_SECONDS);
  return {
    region,
    appBucket,
    mediaBucket,
    sessionSecret,
    mediaTtlSeconds: Number.isFinite(mediaTtl) && mediaTtl > 0 ? mediaTtl : 3600,
  };
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  };
}

function signedIn(event, sessionSecret) {
  const jar = {};
  for (const raw of event.cookies ?? []) {
    const index = raw.indexOf('=');
    if (index > 0) jar[raw.slice(0, index).trim()] = raw.slice(index + 1);
  }
  return verifyJwt(jar[SESSION_COOKIE], sessionSecret) !== null;
}

/** Presigns, then fetches, so one primitive covers both serving and granting. */
async function readObject({ bucket, key, region, credentials }) {
  const url = presignGetObject({ bucket, key, region, credentials, expiresIn: SHORT_FETCH_TTL });
  const response = await fetch(url);
  if (!response.ok) return { status: response.status, body: null };
  return { status: 200, body: Buffer.from(await response.arrayBuffer()) };
}

function bodyResponse(key, buffer, cacheControl) {
  const extension = extensionOf(key);
  const isText = TEXT_TYPES.has(extension);
  return {
    statusCode: 200,
    headers: {
      'content-type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
      'cache-control': cacheControl,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
      'strict-transport-security': 'max-age=63072000; includeSubDomains',
    },
    body: isText ? buffer.toString('utf8') : buffer.toString('base64'),
    isBase64Encoded: !isText,
  };
}

/**
 * The gate. An unsigned-in request never reaches S3, and a signed-in one is
 * handed a URL that expires on the same clock the session would have.
 */
async function serveMedia(event, path, config, credentials) {
  if (!signedIn(event, config.sessionSecret)) {
    return json(403, { error: 'Not signed in.' });
  }

  const key = decodeURIComponent(path.slice(1));

  if (extensionOf(key) === 'm3u8') {
    const object = await readObject({
      bucket: config.mediaBucket,
      key,
      region: config.region,
      credentials,
    });
    if (object.status !== 200) return json(object.status === 404 ? 404 : 502, { error: 'Not found' });
    // Playlists are rewritten often enough that a long TTL would hide edits.
    return bodyResponse(key, object.body, 'private, max-age=300');
  }

  const url = presignGetObject({
    bucket: config.mediaBucket,
    key,
    region: config.region,
    credentials,
    expiresIn: config.mediaTtlSeconds,
  });

  return {
    statusCode: 302,
    headers: { location: url, 'cache-control': 'private, no-store' },
    body: '',
  };
}

/**
 * The public shell. No gate, exactly as the CloudFront default behaviour had
 * none, and the same extensionless-path rewrite the CloudFront Function did.
 */
async function serveApp(path, config, credentials) {
  const last = path.slice(path.lastIndexOf('/') + 1);
  const key = last.includes('.') ? decodeURIComponent(path.slice(1)) : 'index.html';

  const object = await readObject({
    bucket: config.appBucket,
    key,
    region: config.region,
    credentials,
  });

  if (object.status === 404 && key !== 'index.html') {
    const shell = await readObject({
      bucket: config.appBucket,
      key: 'index.html',
      region: config.region,
      credentials,
    });
    if (shell.status !== 200) return json(404, { error: 'Not found' });
    return bodyResponse('index.html', shell.body, 'no-cache, must-revalidate');
  }
  if (object.status !== 200) return json(object.status === 404 ? 404 : 502, { error: 'Not found' });

  // Hashed filenames change on every build; the shell points at them.
  const cacheControl = key.startsWith('assets/')
    ? 'public, max-age=31536000, immutable'
    : 'no-cache, must-revalidate';

  return bodyResponse(key, object.body, cacheControl);
}

export async function handler(event) {
  try {
    const config = getConfig();
    const credentials = credentialsFromEnv();
    const path = event.rawPath ?? '/';

    if (path === '/media' || path.startsWith('/media/')) {
      return await serveMedia(event, path, config, credentials);
    }
    return await serveApp(path, config, credentials);
  } catch (error) {
    console.error('Unhandled error', error);
    return json(500, { error: 'Something went wrong.' });
  }
}
