import { hashPassword, verifyPassword } from './crypto-utils.mjs';
import { credentialsFromEnv, signRequest } from './sigv4.mjs';

/**
 * The viewer roster, read from AWS Secrets Manager rather than baked into the
 * function.
 *
 * Two reasons it lives there rather than in a Lambda environment variable,
 * which is where it used to live:
 *
 * A Lambda environment variable is not a secret. Anyone with
 * lambda:GetFunctionConfiguration reads it back in plaintext, and it is
 * printed in the console. Secrets Manager is encrypted with KMS and gated by
 * its own IAM action, so the roster is readable by the function and by whoever
 * you deliberately grant it to.
 *
 * And it can be rotated without a deploy. Change the secret, and the next
 * sign-in after the cache expires uses the new password. Terraform does not
 * own the value after it seeds it, so an edit made in the console survives the
 * next apply instead of being reverted by it.
 */

const SECRETS_API_TARGET = 'secretsmanager.GetSecretValue';

/**
 * A scrypt hash of nothing in particular, used to keep a failed lookup as
 * expensive as a failed password. Never matches: no password hashes to it.
 */
const DUMMY_HASH =
  'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

export class RosterError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RosterError';
  }
}

/**
 * Accepts a hash or a plaintext password per user.
 *
 * A hash is what Terraform seeds and what you should prefer. Plaintext is
 * allowed because the point of moving the roster here was that you can rotate
 * it, and rotating means typing a new password into the console — requiring a
 * hash would mean running a script first, which is the kind of friction that
 * stops a password ever being changed.
 *
 * The weaker part of that trade is narrow: Secrets Manager is encrypted at
 * rest and reading it is an IAM action you control. scrypt defends against the
 * store itself leaking, and if this store leaks the account is already lost.
 */
function normalise(entry) {
  const username = String(entry.username ?? '').trim();
  if (!username) throw new RosterError('Every roster entry needs a username.');

  const hash = entry.passwordHash ?? entry.password_hash ?? null;
  const plaintext = entry.password ?? null;
  if (!hash && !plaintext) {
    throw new RosterError(`Roster entry "${username}" has neither password nor passwordHash.`);
  }

  return {
    username,
    name: entry.name ?? username,
    roles: Array.isArray(entry.roles) && entry.roles.length > 0 ? entry.roles : ['viewer'],
    // Hashing a plaintext entry on load means the comparison below is the same
    // code path either way, and the plaintext is never held beyond this call.
    passwordHash: hash ?? hashPassword(String(plaintext)),
  };
}

export function rosterFromArray(parsed) {
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new RosterError('The roster must be a non-empty array of users.');
  }
  return new Map(parsed.map((entry) => [String(entry.username ?? '').toLowerCase(), normalise(entry)]));
}

/**
 * The raw Secrets Manager call. Signed with headers rather than a presigned
 * URL because the JSON APIs have no presigned form.
 */
async function fetchSecret({ secretId, region, credentials, fetchImpl }) {
  const host = `secretsmanager.${region}.amazonaws.com`;
  const body = JSON.stringify({ SecretId: secretId });

  const headers = signRequest({
    method: 'POST',
    host,
    path: '/',
    region,
    service: 'secretsmanager',
    credentials,
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': SECRETS_API_TARGET,
    },
    body,
  });

  const response = await fetchImpl(`https://${host}/`, { method: 'POST', headers, body });
  if (!response.ok) {
    // Deliberately without the response body: it echoes the secret's name and
    // ARN, and this message reaches CloudWatch.
    throw new RosterError(`Secrets Manager answered ${response.status} for the roster.`);
  }

  const payload = JSON.parse(await response.text());
  if (typeof payload.SecretString !== 'string') {
    throw new RosterError('The roster secret holds binary, which this expects to be JSON.');
  }
  return payload.SecretString;
}

/**
 * Cached for a short window rather than for the life of the container.
 *
 * Forever would mean a rotation only takes effect when Lambda happens to
 * recycle, which could be hours and is not something you can observe. A minute
 * keeps the common case — a burst of sign-ins — down to one API call, while
 * making "change it and try again" true within a minute.
 */
let cache = { value: null, expiresAt: 0, secretId: null };

export function clearRosterCache() {
  cache = { value: null, expiresAt: 0, secretId: null };
}

export async function loadRoster(
  { secretId, region, ttlSeconds = 60 },
  { fetchImpl = fetch, credentials = null, now = () => Date.now() } = {},
) {
  if (cache.value && cache.secretId === secretId && now() < cache.expiresAt) {
    return cache.value;
  }

  const secretString = await fetchSecret({
    secretId,
    region,
    credentials: credentials ?? credentialsFromEnv(),
    fetchImpl,
  });

  let parsed;
  try {
    parsed = JSON.parse(secretString);
  } catch {
    throw new RosterError('The roster secret is not valid JSON.');
  }

  // Both shapes are accepted: a bare array, and { users: [...] } for when the
  // same secret grows other fields later.
  const roster = rosterFromArray(Array.isArray(parsed) ? parsed : parsed.users);

  cache = { value: roster, secretId, expiresAt: now() + ttlSeconds * 1000 };
  return roster;
}

/**
 * Verifies a password against a roster. Always runs one scrypt verification,
 * so an unknown username costs the same as a wrong password and the two cannot
 * be told apart by timing.
 */
export function authenticateAgainst(roster, username, password) {
  const user = roster.get(String(username ?? '').toLowerCase());
  const ok = verifyPassword(String(password ?? ''), user?.passwordHash ?? DUMMY_HASH);

  if (!user || !ok) return null;
  return { username: user.username, name: user.name, roles: user.roles };
}
