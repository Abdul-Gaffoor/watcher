import { strict as assert } from 'node:assert';
import test from 'node:test';

import { signJwt } from '../src/crypto-utils.mjs';

const SESSION_SECRET = 'edge-test-secret';

process.env.AWS_REGION = 'us-east-1';
process.env.APP_BUCKET = 'watcher-app-test';
process.env.MEDIA_BUCKET = 'watcher-media-test';
process.env.SESSION_SECRET = SESSION_SECRET;
process.env.MEDIA_TTL_SECONDS = '600';
process.env.AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

const { handler } = await import('../src/edge.mjs');

function validSession() {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({ sub: 'alex', name: 'Alex', roles: ['viewer'], iat: now, exp: now + 3600 }, SESSION_SECRET);
}

function request(path, { cookies = [] } = {}) {
  return { rawPath: path, cookies, requestContext: { http: { method: 'GET' } } };
}

/** Replaces the S3 round trip so the tests stay offline. */
function withStubbedFetch(responses, run) {
  const original = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(url);
    const next = responses.shift() ?? { status: 404 };
    return {
      ok: next.status === 200,
      status: next.status,
      arrayBuffer: async () => new TextEncoder().encode(next.body ?? '').buffer,
    };
  };
  return Promise.resolve(run(requested)).finally(() => {
    globalThis.fetch = original;
  });
}

test('refuses media to a request with no session', async () => {
  const response = await handler(request('/media/titles/x/hls/seg0.ts'));

  assert.equal(response.statusCode, 403);
  assert.ok(!('location' in (response.headers ?? {})));
});

test('refuses media when the session cookie is forged', async () => {
  const forged = signJwt({ sub: 'mallory', exp: Math.floor(Date.now() / 1000) + 60 }, 'wrong-secret');
  const response = await handler(request('/media/x.ts', { cookies: [`watcher_session=${forged}`] }));

  assert.equal(response.statusCode, 403);
});

test('refuses media when the session has expired', async () => {
  const stale = signJwt({ sub: 'alex', exp: Math.floor(Date.now() / 1000) - 1 }, SESSION_SECRET);
  const response = await handler(request('/media/x.ts', { cookies: [`watcher_session=${stale}`] }));

  assert.equal(response.statusCode, 403);
});

test('redirects a signed-in viewer to a presigned segment URL', async () => {
  const response = await handler(
    request('/media/titles/x/hls/seg0.ts', { cookies: [`watcher_session=${validSession()}`] }),
  );

  assert.equal(response.statusCode, 302);
  const location = response.headers.location;
  assert.ok(location.startsWith('https://watcher-media-test.s3.us-east-1.amazonaws.com/media/titles/x/hls/seg0.ts?'));
  assert.ok(location.includes('X-Amz-Signature='));
  assert.ok(location.includes('X-Amz-Expires=600'));
  // A redirect that got cached would outlive its own signature.
  assert.equal(response.headers['cache-control'], 'private, no-store');
});

test('serves playlists inline so segment paths stay on this origin', async () => {
  const playlist = '#EXTM3U\n#EXTINF:6,\nseg0.ts\n';
  await withStubbedFetch([{ status: 200, body: playlist }], async () => {
    const response = await handler(
      request('/media/titles/x/hls/index.m3u8', { cookies: [`watcher_session=${validSession()}`] }),
    );

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'application/vnd.apple.mpegurl');
    assert.equal(response.body, playlist);
    assert.ok(!response.isBase64Encoded);
    // Redirecting this would rebase seg0.ts onto S3, where it is unsigned.
    assert.ok(!('location' in response.headers));
  });
});

test('does not read the playlist from S3 without a session', async () => {
  await withStubbedFetch([], async (requested) => {
    const response = await handler(request('/media/titles/x/hls/index.m3u8'));

    assert.equal(response.statusCode, 403);
    assert.equal(requested.length, 0);
  });
});

test('serves the app shell for an extensionless route', async () => {
  await withStubbedFetch([{ status: 200, body: '<!doctype html><title>Watcher</title>' }], async (requested) => {
    const response = await handler(request('/watch/harmonic-foundations'));

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
    assert.ok(requested[0].includes('/index.html?'));
    assert.ok(requested[0].startsWith('https://watcher-app-test.s3.'));
  });
});

test('serves a hashed asset with a year-long immutable cache', async () => {
  await withStubbedFetch([{ status: 200, body: 'console.log(1)' }], async () => {
    const response = await handler(request('/assets/index-abc123.js'));

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(response.headers['content-type'], 'text/javascript; charset=utf-8');
  });
});

test('never lets the shell be cached, since it names the hashed bundles', async () => {
  await withStubbedFetch([{ status: 200, body: '<!doctype html>' }], async () => {
    const response = await handler(request('/index.html'));

    assert.equal(response.headers['cache-control'], 'no-cache, must-revalidate');
  });
});

test('base64-encodes binary assets', async () => {
  await withStubbedFetch([{ status: 200, body: 'not really a png' }], async () => {
    const response = await handler(request('/assets/poster-abc.png'));

    assert.equal(response.statusCode, 200);
    assert.ok(response.isBase64Encoded);
    assert.equal(Buffer.from(response.body, 'base64').toString('utf8'), 'not really a png');
  });
});

test('falls back to the shell when a missing path looks like a file', async () => {
  await withStubbedFetch(
    [{ status: 404 }, { status: 200, body: '<!doctype html>' }],
    async (requested) => {
      const response = await handler(request('/titles/x.y'));

      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
      assert.ok(requested[1].includes('/index.html?'));
    },
  );
});

test('carries the baseline security headers', async () => {
  await withStubbedFetch([{ status: 200, body: '<!doctype html>' }], async () => {
    const response = await handler(request('/'));

    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['referrer-policy'], 'same-origin');
    assert.ok(response.headers['strict-transport-security'].startsWith('max-age=63072000'));
  });
});
