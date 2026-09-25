import { authenticateAgainst, loadRoster, rosterFromArray } from './roster.mjs';

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
 * An inline roster, which is how the dev server and the test suite run: no
 * AWS account, no secret to fetch, everything in one environment variable.
 *
 * Deployments use USERS_SECRET_ID instead, so the roster can be rotated
 * without a deploy and is not sitting in plaintext on the function's
 * configuration. See roster.mjs.
 */
function loadUsers() {
  // Absent when Cognito or a secret owns the directory. getConfig checks that
  // one of the three is present, so an empty map here is never the whole story.
  if (!process.env.USERS_JSON) return new Map();
  const parsed = JSON.parse(process.env.USERS_JSON);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('USERS_JSON must be a non-empty array');
  }
  return rosterFromArray(parsed);
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
      // The roster as a rotatable secret. Preferred over USERS_JSON wherever
      // there is an AWS account to hold it.
      usersSecretId: process.env.USERS_SECRET_ID || null,
      usersSecretRegion: process.env.USERS_SECRET_REGION || process.env.AWS_REGION || null,
      // Short enough that a rotation takes effect while you are still looking
      // at the console, long enough that a burst of sign-ins is one API call.
      rosterTtlSeconds: seconds('ROSTER_TTL_SECONDS', 60),
      // Where the dashboard writes. Absent on the dev server, which has no
      // bucket, so the admin routes report themselves unavailable rather than
      // failing halfway through a write.
      mediaBucket: process.env.MEDIA_BUCKET || null,
      mediaRegion: process.env.MEDIA_REGION || process.env.AWS_REGION || null,
      // Only the dev server sets this: it stands in for the bucket so the
      // dashboard can be developed without an AWS account.
      localCatalogPath: process.env.LOCAL_CATALOG_PATH || null,
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

    // Only the pool and the client decide whether Cognito is in play. The
    // region must not: Lambda always sets AWS_REGION, so counting it would make
    // every roster deployment look half-configured and refuse to start.
    const cognitoParts = [cached.cognitoUserPoolId, cached.cognitoClientId];
    const cognitoConfigured = cognitoParts.filter(Boolean).length;
    if (cognitoConfigured !== 0 && cognitoConfigured !== cognitoParts.length) {
      cached = undefined;
      throw new Error('COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID must be set together or not at all');
    }
    cached.usesCognito = cognitoConfigured === cognitoParts.length;
    if (cached.usesCognito && !cached.cognitoRegion) {
      cached = undefined;
      throw new Error('COGNITO_REGION (or AWS_REGION) is required when using Cognito');
    }

    // Exactly one directory has to be in charge. None leaves nobody able to
    // sign in; more than one would make it ambiguous which password is
    // authoritative.
    const directories = [
      cached.usesCognito,
      cached.users.size > 0,
      Boolean(cached.usersSecretId),
    ].filter(Boolean).length;

    if (directories === 0) {
      cached = undefined;
      throw new Error('Configure one of COGNITO_*, USERS_SECRET_ID or USERS_JSON');
    }
    if (directories > 1) {
      cached = undefined;
      throw new Error('Configure only one of COGNITO_*, USERS_SECRET_ID or USERS_JSON');
    }
    if (cached.usersSecretId && !cached.usersSecretRegion) {
      cached = undefined;
      throw new Error('USERS_SECRET_REGION (or AWS_REGION) is required with USERS_SECRET_ID');
    }
  }
  return cached;
}

/**
 * Async because the roster may have to be fetched. It is cached in roster.mjs
 * for a minute, so this is a network call on the first sign-in after a
 * rotation and free for every one after that.
 */
export async function authenticate(username, password, options = {}) {
  const config = getConfig();
  const roster = config.usersSecretId
    ? await loadRoster(
        {
          secretId: config.usersSecretId,
          region: config.usersSecretRegion,
          ttlSeconds: config.rosterTtlSeconds,
        },
        options,
      )
    : config.users;

  return authenticateAgainst(roster, username, password);
}
