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
  const parsed = JSON.parse(required('USERS_JSON'));
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
      keyPairId: required('CLOUDFRONT_KEY_PAIR_ID'),
      // Newlines survive the Lambda console and CloudFormation more reliably
      // when escaped, so accept both forms.
      privateKey: required('CLOUDFRONT_PRIVATE_KEY').replace(/\\n/g, '\n'),
      mediaResource: required('MEDIA_RESOURCE'),
      cookieDomain: process.env.COOKIE_DOMAIN || undefined,
      sessionTtlSeconds: seconds('SESSION_TTL_SECONDS', 12 * 60 * 60),
      mediaTtlSeconds: seconds('MEDIA_TTL_SECONDS', 60 * 60),
    };
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
