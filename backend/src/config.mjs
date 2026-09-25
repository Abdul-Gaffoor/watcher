import { verifyPassword } from './crypto-utils.mjs';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function seconds(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Users are configured as JSON, which keeps the MVP self-contained. Passwords
 * are only ever stored as scrypt hashes — see scripts/hash-password.mjs.
 * Swap this for Cognito or a user table when the roster outgrows a handful.
 */
function loadUsers() {
  // Absent when Cognito owns the directory. getConfig checks that one of the
  // two is present, so an empty map here is never the whole story.
  if (!process.env.USERS_JSON) return new Map();
  const parsed = JSON.parse(process.env.USERS_JSON);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('USERS_JSON must be a non-empty array');
  }
  return new Map(
    parsed.map((user) => [
      String(user.username).toLowerCase(),
      {
        username: user.username,
        name: user.name ?? user.username,
        roles: user.roles ?? ['viewer'],
        passwordHash: user.passwordHash,
      },
    ]),
  );
}

let cached;

/** Parsed once per container and reused across invocations. */
export function getConfig() {
  if (!cached) {
    cached = {
      users: loadUsers(),
      sessionSecret: required('SESSION_SECRET'),
      // Optional as a set. With CloudFront the signed cookies are how /media/*
      // opens; behind API Gateway there is no key group to sign for, and the
      // session JWT alone gates media. Leaving these unset selects the second
      // mode, so one build of this handler serves both.
      keyPairId: process.env.CLOUDFRONT_KEY_PAIR_ID || null,
      // Newlines survive the Lambda console and CloudFormation more reliably
      // when escaped, so accept both forms.
      privateKey: process.env.CLOUDFRONT_PRIVATE_KEY
        ? process.env.CLOUDFRONT_PRIVATE_KEY.replace(/\\n/g, '\n')
        : null,
      mediaResource: process.env.MEDIA_RESOURCE || null,
      // The managed directory. Configured as a set, like the signer: present
      // and Cognito verifies credentials and enforces MFA; absent and the
      // local scrypt roster does, which is what the dev server and the
      // end-to-end suite run against.
      cognitoUserPoolId: process.env.COGNITO_USER_POOL_ID || null,
      cognitoClientId: process.env.COGNITO_CLIENT_ID || null,
      cognitoRegion: process.env.COGNITO_REGION || process.env.AWS_REGION || null,
      cognitoIssuerLabel: process.env.COGNITO_ISSUER_LABEL || 'Watcher',
      cookieDomain: process.env.COOKIE_DOMAIN || undefined,
      sessionTtlSeconds: seconds('SESSION_TTL_SECONDS', 12 * 60 * 60),
      mediaTtlSeconds: seconds('MEDIA_TTL_SECONDS', 60 * 60),
    };

    const signerParts = [cached.keyPairId, cached.privateKey, cached.mediaResource];
    const configured = signerParts.filter(Boolean).length;
    if (configured !== 0 && configured !== signerParts.length) {
      cached = undefined;
      throw new Error(
        'CLOUDFRONT_KEY_PAIR_ID, CLOUDFRONT_PRIVATE_KEY and MEDIA_RESOURCE must be set together or not at all',
      );
    }
    cached.signsMediaCookies = configured === signerParts.length;

    const cognitoParts = [cached.cognitoUserPoolId, cached.cognitoClientId, cached.cognitoRegion];
    const cognitoConfigured = cognitoParts.filter(Boolean).length;
    if (cognitoConfigured !== 0 && cognitoConfigured !== cognitoParts.length) {
      cached = undefined;
      throw new Error(
        'COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID and COGNITO_REGION must be set together or not at all',
      );
    }
    cached.usesCognito = cognitoConfigured === cognitoParts.length;

    // Exactly one directory has to be in charge. Neither leaves nobody able to
    // sign in; both would make it ambiguous which password is authoritative.
    if (!cached.usesCognito && cached.users.size === 0) {
      cached = undefined;
      throw new Error('Configure either COGNITO_* or USERS_JSON');
    }
    if (cached.usesCognito && cached.users.size > 0) {
      cached = undefined;
      throw new Error('Configure either COGNITO_* or USERS_JSON, not both');
    }
  }
  return cached;
}

export function authenticate(username, password) {
  const { users } = getConfig();
  const user = users.get(String(username ?? '').toLowerCase());

  // Always run a verification so a missing user and a wrong password take
  // comparable time.
  const hash = user?.passwordHash ?? 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  const ok = verifyPassword(String(password ?? ''), hash);

  if (!user || !ok) return null;
  return { username: user.username, name: user.name, roles: user.roles };
}
