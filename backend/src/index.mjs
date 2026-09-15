import { authenticate, getConfig } from './config.mjs';
import { createSignedCookies } from './cloudfront.mjs';
import { signJwt, verifyJwt } from './crypto-utils.mjs';

const SESSION_COOKIE = 'watcher_session';
const CF_COOKIES = ['CloudFront-Policy', 'CloudFront-Signature', 'CloudFront-Key-Pair-Id'];

/**
 * Best-effort brute-force throttle. It is per-container, so it is a speed bump
 * rather than a guarantee — put AWS WAF in front of the distribution before
 * opening the platform to the public.
 */
const MAX_ATTEMPTS = 8;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const attempts = new Map();

function tooManyAttempts(key) {
  const now = Date.now();
  const record = attempts.get(key);
  if (!record || now - record.first > ATTEMPT_WINDOW_MS) return false;
  return record.count >= MAX_ATTEMPTS;
}

function recordFailure(key) {
  const now = Date.now();
  const record = attempts.get(key);
  if (!record || now - record.first > ATTEMPT_WINDOW_MS) {
    attempts.set(key, { count: 1, first: now });
  } else {
    record.count += 1;
  }
  // Keep the map from growing without bound in a long-lived container.
  if (attempts.size > 1000) attempts.clear();
}

function json(statusCode, body, cookies = []) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Auth responses must never be cached, by CloudFront or the browser.
      'cache-control': 'no-store, private',
    },
    cookies,
    body: JSON.stringify(body),
  };
}

function cookie(name, value, { maxAge, domain }) {
  const parts = [`${name}=${value}`, 'Path=/', 'Secure', 'HttpOnly', 'SameSite=Lax'];
  if (typeof maxAge === 'number') parts.push(`Max-Age=${maxAge}`);
  if (domain) parts.push(`Domain=${domain}`);
  return parts.join('; ');
}

function readCookies(event) {
  const jar = {};
  for (const raw of event.cookies ?? []) {
    const index = raw.indexOf('=');
    if (index > 0) jar[raw.slice(0, index).trim()] = raw.slice(index + 1);
  }
  return jar;
}

/** Issues the session JWT plus the CloudFront cookies that unlock `/media/*`. */
function issueSession(user) {
  const config = getConfig();
  const now = Math.floor(Date.now() / 1000);
  const sessionExpiresAt = now + config.sessionTtlSeconds;
  const mediaExpiresAt = now + config.mediaTtlSeconds;

  const token = signJwt(
    { sub: user.username, name: user.name, roles: user.roles, iat: now, exp: sessionExpiresAt },
    config.sessionSecret,
  );

  const signed = createSignedCookies({
    resource: config.mediaResource,
    expiresAt: mediaExpiresAt,
    keyPairId: config.keyPairId,
    privateKey: config.privateKey,
  });

  const cookies = [
    cookie(SESSION_COOKIE, token, { maxAge: config.sessionTtlSeconds, domain: config.cookieDomain }),
    ...CF_COOKIES.map((name) =>
      cookie(name, signed[name], { maxAge: config.mediaTtlSeconds, domain: config.cookieDomain }),
    ),
  ];

  return {
    cookies,
    body: {
      user: { username: user.username, name: user.name, roles: user.roles },
      mediaAccessExpiresAt: mediaExpiresAt,
    },
  };
}

function currentUser(event) {
  const token = readCookies(event)[SESSION_COOKIE];
  const payload = verifyJwt(token, getConfig().sessionSecret);
  if (!payload) return null;
  return { username: payload.sub, name: payload.name, roles: payload.roles ?? ['viewer'] };
}

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function handler(event) {
  const method = event.requestContext?.http?.method ?? 'GET';
  const path = (event.rawPath ?? '/').replace(/\/+$/, '') || '/';

  try {
    if (method === 'POST' && path === '/api/login') {
      const { username, password } = parseBody(event);
      const sourceIp = event.requestContext?.http?.sourceIp ?? 'unknown';
      const throttleKey = `${sourceIp}:${String(username ?? '').toLowerCase()}`;

      if (tooManyAttempts(throttleKey)) {
        return json(429, { error: 'Too many sign-in attempts. Try again later.' });
      }

      const user = authenticate(username, password);
      if (!user) {
        recordFailure(throttleKey);
        return json(401, { error: 'Incorrect username or password.' });
      }

      const session = issueSession(user);
      return json(200, session.body, session.cookies);
    }

    if (method === 'GET' && path === '/api/session') {
      const user = currentUser(event);
      if (!user) return json(401, { error: 'Not signed in.' });
      // Reissuing here means a returning viewer with a valid session always
      // lands on the catalog with working media cookies.
      const session = issueSession(user);
      return json(200, session.body, session.cookies);
    }

    if (method === 'POST' && path === '/api/refresh') {
      const user = currentUser(event);
      if (!user) return json(401, { error: 'Not signed in.' });
      const session = issueSession(user);
      return json(200, session.body, session.cookies);
    }

    if (method === 'POST' && path === '/api/logout') {
      const { cookieDomain } = getConfig();
      const cleared = [SESSION_COOKIE, ...CF_COOKIES].map((name) =>
        cookie(name, '', { maxAge: 0, domain: cookieDomain }),
      );
      return json(200, { ok: true }, cleared);
    }

    if (method === 'GET' && path === '/api/health') {
      return json(200, { ok: true });
    }

    return json(404, { error: 'Not found' });
  } catch (error) {
    // Never leak configuration details to the client.
    console.error('Unhandled error', error);
    return json(500, { error: 'Something went wrong.' });
  }
}
