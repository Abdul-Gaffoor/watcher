#!/usr/bin/env node
/**
 * Local stand-in for the CloudFront + Lambda + S3 stack.
 *
 *   node scripts/dev-api.mjs      # then `npm run dev` in web/
 *
 * It runs the REAL Lambda handler (so auth, JWT and cookie behaviour are the
 * production code paths) against a throwaway RSA key, and serves `content/` at
 * `/media/*` the way the media bucket does. Nothing here validates the
 * CloudFront signature — that is CloudFront's job in production.
 */
import { createServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, extname, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../backend/src/crypto-utils.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contentDir = resolve(root, 'content');
const port = Number(process.env.PORT ?? 8787);
// Overridable so the smoke test (and any staging experiment) can serve an
// alternative catalog without touching the checked-in one.
const catalogPath = process.env.CATALOG_PATH
  ? resolve(process.cwd(), process.env.CATALOG_PATH)
  : resolve(contentDir, 'catalog.json');

const DEV_USERNAME = process.env.DEV_USERNAME ?? 'demo';
const DEV_PASSWORD = process.env.DEV_PASSWORD ?? 'demo1234';

// A per-run key pair: dev cookies are never verified by anything.
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

process.env.USERS_JSON = JSON.stringify([
  { username: DEV_USERNAME, name: 'Demo Viewer', roles: ['viewer'], passwordHash: hashPassword(DEV_PASSWORD) },
]);
process.env.SESSION_SECRET = 'local-development-secret-not-for-production';
process.env.CLOUDFRONT_KEY_PAIR_ID = 'LOCALDEVKEYPAIR';
process.env.CLOUDFRONT_PRIVATE_KEY = privateKey;
process.env.MEDIA_RESOURCE = `http://localhost:${port}/media/*`;

const { handler } = await import('../backend/src/index.mjs');

const MIME_TYPES = {
  '.json': 'application/json; charset=utf-8',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.vtt': 'text/vtt; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : undefined;
}

/** Serves `content/media/...`, refusing anything outside the content directory. */
async function serveMedia(pathname, request, response) {
  // `normalize` plus the prefix check keeps `..` from escaping the content dir.
  const filePath = normalize(resolve(contentDir, `.${decodeURIComponent(pathname)}`));
  if (!filePath.startsWith(contentDir)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  await serveFile(filePath, request, response);
}

/** Streams one file, honouring range requests so seeking works. */
async function serveFile(filePath, request, response) {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    return;
  }
  if (!info.isFile()) {
    response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    return;
  }

  const contentType = MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  const range = request.headers.range;
  const match = range && /^bytes=(\d*)-(\d*)$/.exec(range);

  if (match) {
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Number(match[2]) : info.size - 1;
    if (start >= info.size || end >= info.size || start > end) {
      response.writeHead(416, { 'content-range': `bytes */${info.size}` }).end();
      return;
    }
    response.writeHead(206, {
      'content-type': contentType,
      'content-length': end - start + 1,
      'content-range': `bytes ${start}-${end}/${info.size}`,
      'accept-ranges': 'bytes',
    });
    createReadStream(filePath, { start, end }).pipe(response);
    return;
  }

  response.writeHead(200, {
    'content-type': contentType,
    'content-length': info.size,
    'accept-ranges': 'bytes',
    'cache-control': 'no-cache',
  });
  createReadStream(filePath).pipe(response);
}

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://localhost:${port}`);

  if (url.pathname.startsWith('/media/')) {
    // upload-content.sh puts content/catalog.json at the media key
    // `media/catalog.json`, so mirror that mapping here.
    if (url.pathname === '/media/catalog.json') {
      await serveFile(catalogPath, request, response);
      return;
    }
    await serveMedia(url.pathname, request, response);
    return;
  }

  if (!url.pathname.startsWith('/api/')) {
    response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    return;
  }

  // Shape the request the way a Lambda Function URL (payload v2) would.
  const result = await handler({
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    headers: request.headers,
    cookies: (request.headers.cookie ?? '').split(';').map((part) => part.trim()).filter(Boolean),
    body: await readRequestBody(request),
    isBase64Encoded: false,
    requestContext: { http: { method: request.method ?? 'GET', sourceIp: '127.0.0.1' } },
  });

  const headers = { ...result.headers };
  // `Secure` cookies are dropped by browsers over plain http://localhost.
  const cookies = (result.cookies ?? []).map((value) => value.replace('; Secure', ''));
  if (cookies.length > 0) headers['set-cookie'] = cookies;

  response.writeHead(result.statusCode, headers).end(result.body);
}).listen(port, () => {
  console.log(`Watcher dev API  http://localhost:${port}`);
  console.log(`Media root       ${contentDir}/media`);
  console.log(`Sign in with     ${DEV_USERNAME} / ${DEV_PASSWORD}`);
});
