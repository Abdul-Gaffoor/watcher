import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { hashPassword } from '../src/crypto-utils.mjs';

const PASSWORD = 'demo-password-1234';
let handler;

before(async () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  process.env.USERS_JSON = JSON.stringify([
    { username: 'Demo', name: 'Demo Viewer', roles: ['viewer'], passwordHash: hashPassword(PASSWORD) },
  ]);
  process.env.SESSION_SECRET = 'test-secret-that-is-at-least-32-chars-long';
  process.env.CLOUDFRONT_KEY_PAIR_ID = 'K123EXAMPLE';
  process.env.CLOUDFRONT_PRIVATE_KEY = privateKey;
  process.env.MEDIA_RESOURCE = 'https://example.cloudfront.net/media/*';
  process.env.MEDIA_TTL_SECONDS = '3600';

  ({ handler } = await import('../src/index.mjs'));
});

function request(method, path, { body, cookies = [], sourceIp = '203.0.113.10' } = {}) {
  return handler({
    rawPath: path,
    headers: {},
    cookies,
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { http: { method, sourceIp } },
  });
}

/** Turns a response's Set-Cookie strings into the jar a browser would send back. */
function jarFrom(response) {
  return (response.cookies ?? [])
    .map((value) => value.split(';')[0])
    .filter((pair) => !pair.endsWith('='));
}

describe('login', () => {
  test('correct credentials return the user and media cookies', async () => {
    const response = await request('POST', '/api/login', {
      body: { username: 'Demo', password: PASSWORD },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.user.username, 'Demo');
    assert.deepEqual(body.user.roles, ['viewer']);
    assert.ok(body.mediaAccessExpiresAt > Math.floor(Date.now() / 1000));

    const names = response.cookies.map((cookie) => cookie.split('=')[0]);
    assert.deepEqual(names.sort(), [
      'CloudFront-Key-Pair-Id',
      'CloudFront-Policy',
      'CloudFront-Signature',
      'watcher_session',
    ]);
  });

  test('the username is matched case-insensitively', async () => {
    const response = await request('POST', '/api/login', {
      body: { username: 'DEMO', password: PASSWORD },
    });
    assert.equal(response.statusCode, 200);
  });

  test('every auth cookie is HttpOnly, Secure and SameSite', async () => {
    const response = await request('POST', '/api/login', {
      body: { username: 'demo', password: PASSWORD },
    });
    for (const cookie of response.cookies) {
      assert.match(cookie, /HttpOnly/, cookie);
      assert.match(cookie, /Secure/, cookie);
      assert.match(cookie, /SameSite=Lax/, cookie);
      assert.match(cookie, /Path=\//, cookie);
    }
  });

  test('auth responses are never cached', async () => {
    const response = await request('POST', '/api/login', {
      body: { username: 'demo', password: PASSWORD },
    });
    assert.match(response.headers['cache-control'], /no-store/);
  });

  test('a wrong password is rejected without leaking which field was wrong', async () => {
    const wrongPassword = await request('POST', '/api/login', {
      body: { username: 'demo', password: 'nope' },
    });
    const unknownUser = await request('POST', '/api/login', {
      body: { username: 'nobody', password: 'nope' },
    });

    assert.equal(wrongPassword.statusCode, 401);
    assert.equal(unknownUser.statusCode, 401);
    assert.equal(JSON.parse(wrongPassword.body).error, JSON.parse(unknownUser.body).error);
    assert.equal(wrongPassword.cookies.length, 0);
  });

  test('a missing or malformed body is rejected, not crashed on', async () => {
    assert.equal((await request('POST', '/api/login')).statusCode, 401);
    const malformed = await handler({
      rawPath: '/api/login',
      body: 'not json',
      headers: {},
      requestContext: { http: { method: 'POST', sourceIp: '203.0.113.99' } },
    });
    assert.equal(malformed.statusCode, 401);
  });

  test('repeated failures from one source are throttled', async () => {
    const ip = '198.51.100.7';
    let last;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      last = await request('POST', '/api/login', {
        body: { username: 'demo', password: 'wrong' },
        sourceIp: ip,
      });
    }
    assert.equal(last.statusCode, 429);
  });
});

describe('session', () => {
  test('a valid session cookie returns the user and fresh media cookies', async () => {
    const login = await request('POST', '/api/login', {
      body: { username: 'demo', password: PASSWORD },
    });
    const session = await request('GET', '/api/session', { cookies: jarFrom(login) });

    assert.equal(session.statusCode, 200);
    assert.equal(JSON.parse(session.body).user.username, 'Demo');
    assert.equal(session.cookies.length, 4);
  });

  test('no cookie means 401', async () => {
    assert.equal((await request('GET', '/api/session')).statusCode, 401);
  });

  test('a forged session cookie means 401', async () => {
    const forged = await request('GET', '/api/session', {
      cookies: ['watcher_session=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.notasignature'],
    });
    assert.equal(forged.statusCode, 401);
  });

  test('refresh reissues media access for a signed-in viewer', async () => {
    const login = await request('POST', '/api/login', {
      body: { username: 'demo', password: PASSWORD },
    });
    const refreshed = await request('POST', '/api/refresh', { cookies: jarFrom(login) });

    assert.equal(refreshed.statusCode, 200);
    assert.ok(JSON.parse(refreshed.body).mediaAccessExpiresAt > Math.floor(Date.now() / 1000));
  });

  test('refresh without a session is refused', async () => {
    assert.equal((await request('POST', '/api/refresh')).statusCode, 401);
  });
});

describe('logout and routing', () => {
  test('logout clears every auth cookie', async () => {
    const response = await request('POST', '/api/logout');
    assert.equal(response.statusCode, 200);
    assert.equal(response.cookies.length, 4);
    for (const cookie of response.cookies) {
      assert.match(cookie, /Max-Age=0/, cookie);
    }
  });

  test('health check responds', async () => {
    assert.equal((await request('GET', '/api/health')).statusCode, 200);
  });

  test('unknown paths and wrong methods are 404, not 500', async () => {
    assert.equal((await request('GET', '/api/nope')).statusCode, 404);
    assert.equal((await request('GET', '/api/login')).statusCode, 404);
  });

  test('a trailing slash resolves to the same route', async () => {
    assert.equal((await request('GET', '/api/health/')).statusCode, 200);
  });
});
