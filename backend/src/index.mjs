import { authenticate, getConfig } from './config.mjs';
import { createSignedCookies } from './cloudfront.mjs';
import { signJwt, verifyJwt } from './crypto-utils.mjs';
import { AdminError, isAdmin, readCatalog, signUpload, writeCatalog } from './admin.mjs';
import {
  DeviceError,
  decidePairing,
  describePairing,
  normaliseUserCode,
  pollPairing,
  startPairing,
} from './devices.mjs';
import {
  beginLogin,
  describeCognitoError,
  readChallengeToken,
  submitMfaCode,
  submitNewPassword,
  verifyMfaSetup,
} from './auth-flow.mjs';

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

/**
 * Read from the raw query string rather than the parsed map. Both are present
 * in a payload v2 event, but only this one is unambiguous about repeats and
 * encoding, and it keeps the dev server on the identical code path.
 */
function queryOf(event, name) {
  return new URLSearchParams(event.rawQueryString ?? '').get(name) ?? '';
}

function headerOf(event, name) {
  const headers = event.headers ?? {};
  // API Gateway lowercases header names; a Function URL does not always.
  return headers[name] ?? headers[name.toLowerCase()] ?? '';
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

  const cookies = [
    cookie(SESSION_COOKIE, token, { maxAge: config.sessionTtlSeconds, domain: config.cookieDomain }),
  ];

  // Behind API Gateway there is no key group to sign against, and media is
  // gated by checking this same session on each request instead. Issuing
  // cookies no edge will ever verify would only mislead.
  if (config.signsMediaCookies) {
    const signed = createSignedCookies({
      resource: config.mediaResource,
      expiresAt: mediaExpiresAt,
      keyPairId: config.keyPairId,
      privateKey: config.privateKey,
    });
    cookies.push(
      ...CF_COOKIES.map((name) =>
        cookie(name, signed[name], { maxAge: config.mediaTtlSeconds, domain: config.cookieDomain }),
      ),
    );
  }

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

/**
 * The Cognito steps after the password, keyed by path. Each names the challenge
 * it answers, so a token from one step cannot be replayed into another.
 */
const CHALLENGE_ROUTES = new Map([
  [
    '/api/login/new-password',
    {
      expects: 'NEW_PASSWORD_REQUIRED',
      run: ({ config, challenge, body }) =>
        submitNewPassword({ config, challenge, password: String(body.password ?? '') }),
    },
  ],
  [
    '/api/login/mfa-setup',
    {
      expects: 'MFA_SETUP',
      run: ({ config, challenge, body }) =>
        verifyMfaSetup({ config, challenge, code: String(body.code ?? '').trim() }),
    },
  ],
  [
    '/api/login/mfa',
    {
      expects: 'SOFTWARE_TOKEN_MFA',
      run: ({ config, challenge, body }) =>
        submitMfaCode({ config, challenge, code: String(body.code ?? '').trim() }),
    },
  ],
]);

/**
 * Runs one step and turns its outcome into a response. A step that finishes the
 * sign-in gets cookies; one that raises another challenge gets the token for it
 * and nothing else. Only a genuine credential rejection counts against the
 * throttle, so mistyping a new password does not lock anyone out.
 */
async function runFlow(throttleKey, step) {
  try {
    const outcome = await step();

    if (outcome.status === 'authenticated') {
      const session = issueSession(outcome.user);
      return json(200, { status: 'authenticated', ...session.body }, session.cookies);
    }

    return json(200, outcome);
  } catch (error) {
    const described = describeCognitoError(error);
    if (!described) throw error;
    if (described.status === 401) recordFailure(throttleKey);
    return json(described.status, { error: described.message });
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

      const config = getConfig();

      if (config.usesCognito) {
        return await runFlow(throttleKey, () =>
          beginLogin({ config, username: String(username ?? ''), password: String(password ?? '') }),
        );
      }

      const user = await authenticate(username, password);
      if (!user) {
        recordFailure(throttleKey);
        return json(401, { error: 'Incorrect username or password.' });
      }

      const session = issueSession(user);
      return json(200, { status: 'authenticated', ...session.body }, session.cookies);
    }

    // The remaining steps of a Cognito sign-in. Each takes the challenge token
    // the previous step handed back, so none of them can be reached cold.
    if (method === 'POST' && CHALLENGE_ROUTES.has(path)) {
      const config = getConfig();
      if (!config.usesCognito) return json(404, { error: 'Not found' });

      const body = parseBody(event);
      const challenge = readChallengeToken(body.challengeToken, config.sessionSecret);
      if (!challenge) {
        return json(401, { error: 'That sign-in attempt expired. Start again.' });
      }

      const sourceIp = event.requestContext?.http?.sourceIp ?? 'unknown';
      const throttleKey = `${sourceIp}:${challenge.username.toLowerCase()}`;
      if (tooManyAttempts(throttleKey)) {
        return json(429, { error: 'Too many sign-in attempts. Try again later.' });
      }

      const step = CHALLENGE_ROUTES.get(path);
      if (challenge.challengeName !== step.expects) {
        return json(409, { error: 'That step does not apply to this sign-in.' });
      }

      return await runFlow(throttleKey, () => step.run({ config, challenge, body }));
    }

    if (method === 'GET' && path === '/api/session') {
      const user = currentUser(event);
      if (!user) return json(401, { error: 'Not signed in.' });
      // Reissuing here means a returning viewer with a valid session always
      // lands on the catalog with working media cookies.
      const session = issueSession(user);
      return json(200, { status: 'authenticated', ...session.body }, session.cookies);
    }

    if (method === 'POST' && path === '/api/refresh') {
      const user = currentUser(event);
      if (!user) return json(401, { error: 'Not signed in.' });
      const session = issueSession(user);
      return json(200, { status: 'authenticated', ...session.body }, session.cookies);
    }

    if (method === 'POST' && path === '/api/logout') {
      const { cookieDomain } = getConfig();
      const cleared = [SESSION_COOKIE, ...CF_COOKIES].map((name) =>
        cookie(name, '', { maxAge: 0, domain: cookieDomain }),
      );
      return json(200, { ok: true }, cleared);
    }

    // ------------------------------------------------------------ admin --
    // Gated here, on the server, by the role in the signed session. The
    // dashboard hiding its own link is presentation; this is the boundary.
    if (path === '/api/admin/catalog' || path === '/api/admin/uploads') {
      const user = currentUser(event);
      if (!user) return json(401, { error: 'Not signed in.' });
      if (!isAdmin(user)) {
        // Deliberately the same answer a viewer gets for anything else they
        // may not have, so the dashboard's existence is not advertised.
        return json(404, { error: 'Not found' });
      }

      const config = getConfig();
      try {
        if (method === 'GET' && path === '/api/admin/catalog') {
          return json(200, { catalog: await readCatalog(config) });
        }
        if (method === 'PUT' && path === '/api/admin/catalog') {
          const { catalog, baseRevision } = parseBody(event);
          return json(200, { catalog: await writeCatalog(config, { catalog, baseRevision }) });
        }
        if (method === 'POST' && path === '/api/admin/uploads') {
          return json(200, signUpload(config, parseBody(event)));
        }
        return json(405, { error: 'Method not allowed' });
      } catch (error) {
        if (error instanceof AdminError) {
          return json(error.status, { error: error.message, ...error.extra });
        }
        throw error;
      }
    }

    // ------------------------------------------------- pairing a device --
    // Signing in a television by scanning its code with an already-trusted
    // phone. start and poll are unauthenticated by necessity: they are what a
    // device calls before anyone has proved anything, and an unapproved
    // pairing is worth nothing. The two that grant something require a
    // session, and it is that session's identity the device inherits.
    if (path.startsWith('/api/device/')) {
      const config = getConfig();
      const sourceIp = event.requestContext?.http?.sourceIp ?? 'unknown';

      try {
        if (method === 'POST' && path === '/api/device/start') {
          if (tooManyAttempts(`device-start:${sourceIp}`)) {
            return json(429, { error: 'Too many pairing attempts. Try again later.' });
          }
          // Counted on every call rather than on failure: nothing here can
          // fail, so unmetered it would be a free way to fill the table.
          recordFailure(`device-start:${sourceIp}`);

          const started = await startPairing(config, {
            userAgent: headerOf(event, 'user-agent'),
            sourceIp,
          });

          // The device code never leaves in a form anyone but this device
          // sees, and the QR carries only the short code.
          return json(200, started);
        }

        if (method === 'POST' && path === '/api/device/poll') {
          const body = parseBody(event);
          const outcome = await pollPairing(config, {
            userCode: normaliseUserCode(body.userCode),
            deviceCode: String(body.deviceCode ?? ''),
          });

          if (outcome.status !== 'approved') return json(200, outcome);

          // The device is signed in as whoever approved it, with their roles.
          const session = issueSession(outcome.user);
          return json(200, { status: 'approved', ...session.body }, session.cookies);
        }

        // Both of these speak for a signed-in viewer, so both need one.
        const user = currentUser(event);
        if (!user) return json(401, { error: 'Not signed in.' });

        if (method === 'GET' && path === '/api/device/pending') {
          return json(200, await describePairing(config, normaliseUserCode(queryOf(event, 'code'))));
        }

        if (method === 'POST' && path === '/api/device/decide') {
          const body = parseBody(event);
          return json(
            200,
            await decidePairing(config, {
              userCode: normaliseUserCode(body.userCode),
              approve: body.approve === true,
              user,
            }),
          );
        }

        return json(404, { error: 'Not found' });
      } catch (error) {
        if (error instanceof DeviceError) return json(error.status, { error: error.message });
        throw error;
      }
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
