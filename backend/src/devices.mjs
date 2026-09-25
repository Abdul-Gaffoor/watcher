import { createHash, randomBytes, randomInt } from 'node:crypto';

import { safeEqual } from './crypto-utils.mjs';
import { credentialsFromEnv, signRequest } from './sigv4.mjs';

/**
 * Signing in a television by scanning a code with your phone.
 *
 * This is the OAuth 2.0 device authorization grant (RFC 8628) in miniature:
 * the device that cannot easily accept typing gets a short code, a phone that
 * is already trusted approves it, and the device trades its own secret for a
 * session. The password is never typed on the television, never travels to it,
 * and is never seen by whoever is in the room.
 *
 * Two codes, and the split between them is the security:
 *
 *   userCode    eight characters, shown on the screen and inside the QR. Short
 *               enough to read across a room, so it must be assumed public to
 *               anyone who can see the screen.
 *   deviceCode  256 bits, known only to the device that asked. The poll must
 *               present it, so seeing the screen is not enough to collect the
 *               session that the approval produces.
 *
 * Only a hash of the device code is stored, so a dump of the table cannot be
 * replayed into a pending sign-in.
 */

/**
 * No vowels, so a random code can never spell something; no 0/O, 1/I/L or
 * U/V, which is where reading a code off a screen actually goes wrong.
 */
const CODE_ALPHABET = 'BCDFGHJKMNPQRSTWXZ23456789';
const CODE_LENGTH = 8;

/** Long enough that guessing is pointless, short enough for a QR to stay sparse. */
const DEVICE_CODE_BYTES = 32;

const DEFAULT_TTL_SECONDS = 10 * 60;
const POLL_INTERVAL_SECONDS = 2;

export class DeviceError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'DeviceError';
    this.status = status;
  }
}

// ---------------------------------------------------------------- codes --

export function generateUserCode(random = randomInt) {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) out += CODE_ALPHABET[random(CODE_ALPHABET.length)];
  return out;
}

/**
 * Accepts what a person actually types: any case, with or without the dash it
 * is displayed with, and with stray spaces.
 */
export function normaliseUserCode(input) {
  const cleaned = String(input ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (cleaned.length !== CODE_LENGTH) throw new DeviceError('That code is not a valid pairing code.');
  for (const char of cleaned) {
    if (!CODE_ALPHABET.includes(char)) throw new DeviceError('That code is not a valid pairing code.');
  }
  return cleaned;
}

/** `WXYZ-2345`, which is easier to read aloud and to copy than eight runs-on. */
export function formatUserCode(code) {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function hashDeviceCode(deviceCode) {
  return createHash('sha256').update(String(deviceCode), 'utf8').digest('hex');
}

/**
 * A best-effort label for the device asking, so the approval screen can say
 * what it is approving rather than asking for a blind yes.
 *
 * Deliberately coarse. A user agent is attacker-controlled, so this is a
 * recognition aid, never a security control, and it is truncated so a crafted
 * one cannot fill the phone's screen with a persuasive sentence.
 */
export function describeDevice(userAgent) {
  const ua = String(userAgent ?? '');
  // Order matters: every Chromium agent also claims Safari, and Chrome on iOS
  // claims neither by name. Checked most specific first, and Chrome is matched
  // without a leading word boundary so "HeadlessChrome/" is not read as Safari.
  const browser =
    /Edg(e|A|iOS)?\//.test(ua) ? 'Edge'
    : /\bOPR\/|\bOpera\//.test(ua) ? 'Opera'
    : /\bSamsungBrowser\//.test(ua) ? 'Samsung Internet'
    : /FxiOS\/|\bFirefox\//.test(ua) ? 'Firefox'
    : /CriOS\/|Chrome\//.test(ua) ? 'Chrome'
    : /\bSafari\//.test(ua) ? 'Safari'
    : 'A browser';

  const platform =
    /\bSMART-TV|SmartTV|Tizen|Web0S|WEBOS|BRAVIA|AFT[BMS]|GoogleTV\b/i.test(ua) ? 'a TV'
    : /\biPhone\b/.test(ua) ? 'an iPhone'
    : /\biPad\b/.test(ua) ? 'an iPad'
    : /\bAndroid\b/.test(ua) ? 'an Android device'
    : /\bMac OS X\b/.test(ua) ? 'a Mac'
    : /\bWindows\b/.test(ua) ? 'a Windows PC'
    : /\bLinux\b/.test(ua) ? 'a Linux machine'
    : 'an unknown device';

  return `${browser} on ${platform}`.slice(0, 64);
}

// ---------------------------------------------------------------- store --

/**
 * DynamoDB, because this is the one piece of state the platform has that is
 * neither a file nor a session: it is written by one request and read by
 * another, seconds later, many times. S3 holds the catalog perfectly well and
 * would hold this badly — a poll every two seconds against an object that was
 * just overwritten is exactly the shape S3 is worst at.
 *
 * expiresAt is the table's TTL attribute. DynamoDB deletes lazily, sometimes
 * a long time late, so every read checks the expiry itself rather than
 * trusting the sweep to have happened.
 */
function dynamoStore(config) {
  const region = config.devicesRegion;
  const host = `dynamodb.${region}.amazonaws.com`;

  async function call(target, payload, { fetchImpl = fetch } = {}) {
    const body = JSON.stringify(payload);
    const headers = signRequest({
      method: 'POST',
      host,
      path: '/',
      region,
      service: 'dynamodb',
      credentials: credentialsFromEnv(),
      headers: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': `DynamoDB_20120810.${target}` },
      body,
    });

    const response = await fetchImpl(`https://${host}/`, { method: 'POST', headers, body });
    const text = await response.text();
    if (!response.ok) {
      const type = String(JSON.parse(text || '{}').__type ?? '');
      // The one failure that is not an error: a conditional write losing a
      // race is how "already approved" is detected.
      if (type.includes('ConditionalCheckFailed')) return { conditionFailed: true };
      throw new DeviceError(`The pairing store answered ${response.status}.`, 502);
    }
    return text ? JSON.parse(text) : {};
  }

  return {
    async create(record, options) {
      const result = await call(
        'PutItem',
        {
          TableName: config.devicesTable,
          Item: toItem(record),
          // Never silently take over a code that is already in flight.
          ConditionExpression: 'attribute_not_exists(user_code)',
        },
        options,
      );
      return !result.conditionFailed;
    },

    async read(userCode, options) {
      const result = await call(
        'GetItem',
        {
          TableName: config.devicesTable,
          Key: { user_code: { S: userCode } },
          ConsistentRead: true,
        },
        options,
      );
      return result.Item ? fromItem(result.Item) : null;
    },

    async decide(userCode, decision, user, options) {
      const result = await call(
        'UpdateItem',
        {
          TableName: config.devicesTable,
          Key: { user_code: { S: userCode } },
          UpdateExpression: 'SET #s = :next, username = :u, display_name = :n, roles = :r',
          // Only a pending pairing can be decided, so a second approval cannot
          // revive one that was already collected or denied.
          ConditionExpression: 'attribute_exists(user_code) AND #s = :pending',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':next': { S: decision },
            ':pending': { S: 'pending' },
            ':u': { S: user?.username ?? '' },
            ':n': { S: user?.name ?? '' },
            ':r': { S: JSON.stringify(user?.roles ?? []) },
          },
        },
        options,
      );
      return !result.conditionFailed;
    },

    async remove(userCode, options) {
      await call('DeleteItem', { TableName: config.devicesTable, Key: { user_code: { S: userCode } } }, options);
    },
  };
}

function toItem(record) {
  return {
    user_code: { S: record.userCode },
    device_hash: { S: record.deviceHash },
    status: { S: record.status },
    created_at: { N: String(record.createdAt) },
    expires_at: { N: String(record.expiresAt) },
    device_label: { S: record.deviceLabel },
    device_ip: { S: record.deviceIp },
    username: { S: '' },
    display_name: { S: '' },
    roles: { S: '[]' },
  };
}

function fromItem(item) {
  return {
    userCode: item.user_code?.S ?? '',
    deviceHash: item.device_hash?.S ?? '',
    status: item.status?.S ?? 'pending',
    createdAt: Number(item.created_at?.N ?? 0),
    expiresAt: Number(item.expires_at?.N ?? 0),
    deviceLabel: item.device_label?.S ?? '',
    deviceIp: item.device_ip?.S ?? '',
    username: item.username?.S ?? '',
    name: item.display_name?.S ?? '',
    roles: JSON.parse(item.roles?.S ?? '[]'),
  };
}

/**
 * The dev server and the end-to-end suite, which have no AWS account. One
 * process, so a Map is the whole implementation and the flow can be exercised
 * exactly as it runs in production.
 */
function memoryStore() {
  const rows = new Map();
  return {
    async create(record) {
      if (rows.has(record.userCode)) return false;
      rows.set(record.userCode, { ...record, username: '', name: '', roles: [] });
      return true;
    },
    async read(userCode) {
      const row = rows.get(userCode);
      return row ? { ...row } : null;
    },
    async decide(userCode, decision, user) {
      const row = rows.get(userCode);
      if (!row || row.status !== 'pending') return false;
      Object.assign(row, {
        status: decision,
        username: user?.username ?? '',
        name: user?.name ?? '',
        roles: user?.roles ?? [],
      });
      return true;
    },
    async remove(userCode) {
      rows.delete(userCode);
    },
  };
}

let memory = null;

export function storeFor(config) {
  if (config.devicesTable) return dynamoStore(config);
  // Shared across invocations on purpose: the poll must see what start wrote.
  if (!memory) memory = memoryStore();
  return memory;
}

export function resetMemoryStore() {
  memory = null;
}

// ----------------------------------------------------------------- flow --

/**
 * Opens a pairing. Unauthenticated by necessity — this is what a device calls
 * before anybody has proved anything — so it creates nothing of value on its
 * own: an unapproved code is worth exactly nothing, and it expires.
 */
export async function startPairing(config, { userAgent, sourceIp, now = Date.now() }, options = {}) {
  const store = storeFor(config);
  const ttl = config.deviceCodeTtlSeconds ?? DEFAULT_TTL_SECONDS;
  const deviceCode = randomBytes(DEVICE_CODE_BYTES).toString('base64url');
  const createdAt = Math.floor(now / 1000);

  // A collision is astronomically unlikely, but a collision that silently
  // hijacked somebody else's pending sign-in would be severe, so the write is
  // conditional and a clash simply draws another code.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const userCode = generateUserCode();
    const created = await store.create(
      {
        userCode,
        deviceHash: hashDeviceCode(deviceCode),
        status: 'pending',
        createdAt,
        expiresAt: createdAt + ttl,
        deviceLabel: describeDevice(userAgent),
        deviceIp: String(sourceIp ?? '').slice(0, 45),
      },
      options,
    );

    if (created) {
      return {
        userCode,
        displayCode: formatUserCode(userCode),
        deviceCode,
        expiresInSeconds: ttl,
        intervalSeconds: POLL_INTERVAL_SECONDS,
      };
    }
  }

  throw new DeviceError('Could not start a pairing. Try again.', 503);
}

/**
 * What the phone is about to approve. Requires a signed-in viewer, so an
 * onlooker who reads the code off the screen still learns nothing.
 */
export async function describePairing(config, userCode, { now = Date.now() } = {}, options = {}) {
  const record = await requirePending(config, userCode, now, options);
  return {
    displayCode: formatUserCode(record.userCode),
    device: record.deviceLabel,
    ip: record.deviceIp,
    requestedAt: new Date(record.createdAt * 1000).toISOString(),
    expiresAt: new Date(record.expiresAt * 1000).toISOString(),
  };
}

async function requirePending(config, userCode, now, options) {
  const store = storeFor(config);
  const record = await store.read(userCode, options);

  // The same answer for "never existed", "already used" and "expired". Telling
  // them apart would turn this into an oracle for which codes are live.
  if (!record || record.status !== 'pending' || record.expiresAt * 1000 <= now) {
    throw new DeviceError('That pairing code is not waiting for approval.', 404);
  }
  return record;
}

/** The phone's decision. `approve` false records a refusal rather than a silence. */
export async function decidePairing(
  config,
  { userCode, approve, user },
  { now = Date.now() } = {},
  options = {},
) {
  await requirePending(config, userCode, now, options);
  const store = storeFor(config);

  const decided = await store.decide(userCode, approve ? 'approved' : 'denied', user, options);
  if (!decided) {
    // Lost a race with another approval or with expiry.
    throw new DeviceError('That pairing code is not waiting for approval.', 404);
  }
  return { status: approve ? 'approved' : 'denied' };
}

/**
 * The device asking whether it may come in yet.
 *
 * Returns the user on success and deletes the pairing in the same breath: a
 * code is good for exactly one session, so a replayed poll gets nothing even
 * if the device code leaks afterwards.
 */
export async function pollPairing(config, { userCode, deviceCode }, { now = Date.now() } = {}, options = {}) {
  const store = storeFor(config);
  const record = await store.read(userCode, options);

  if (!record) return { status: 'expired' };

  // Checked before the expiry so a wrong device code never learns whether the
  // pairing it guessed at was real.
  if (!safeEqual(record.deviceHash, hashDeviceCode(deviceCode))) {
    throw new DeviceError('That pairing code is not waiting for approval.', 404);
  }

  if (record.expiresAt * 1000 <= now) {
    await store.remove(userCode, options);
    return { status: 'expired' };
  }

  if (record.status === 'denied') {
    await store.remove(userCode, options);
    return { status: 'denied' };
  }

  if (record.status === 'approved') {
    await store.remove(userCode, options);
    return {
      status: 'approved',
      user: { username: record.username, name: record.name, roles: record.roles },
    };
  }

  return { status: 'pending', intervalSeconds: POLL_INTERVAL_SECONDS };
}
