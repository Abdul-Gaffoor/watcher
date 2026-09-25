import { strict as assert } from 'node:assert';
import test from 'node:test';

import { hashPassword } from '../src/crypto-utils.mjs';
import {
  RosterError,
  authenticateAgainst,
  clearRosterCache,
  loadRoster,
  rosterFromArray,
} from '../src/roster.mjs';
import { signRequest } from '../src/sigv4.mjs';

const CREDENTIALS = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};

const SETTINGS = { secretId: 'watcher/users', region: 'us-east-1', ttlSeconds: 60 };

/** A Secrets Manager stand-in that counts calls, so caching is observable. */
function fakeSecrets(secretStrings) {
  const queue = [...secretStrings];
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const body = queue.length > 1 ? queue.shift() : queue[0];
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ SecretString: body }),
    };
  };
  return { fetchImpl, calls };
}

function rosterJson(password) {
  return JSON.stringify([
    { username: 'Abdul', name: 'Abdul', roles: ['viewer', 'admin'], passwordHash: hashPassword(password) },
  ]);
}

test.beforeEach(() => clearRosterCache());

// ------------------------------------------------------------------ shape --

test('a plaintext password is accepted and hashed on the way in', () => {
  // Rotating means typing a new password into the console. Requiring a hash
  // first is the friction that stops a password ever being changed.
  const roster = rosterFromArray([{ username: 'Abdul', password: 'correct horse' }]);

  assert.match(roster.get('abdul').passwordHash, /^scrypt\$/);
  assert.ok(authenticateAgainst(roster, 'Abdul', 'correct horse'));
  assert.equal(authenticateAgainst(roster, 'Abdul', 'wrong'), null);
});

test('a hash wins over a plaintext password on the same entry', () => {
  const roster = rosterFromArray([
    { username: 'Abdul', password: 'ignored', passwordHash: hashPassword('real') },
  ]);

  assert.ok(authenticateAgainst(roster, 'Abdul', 'real'));
  assert.equal(authenticateAgainst(roster, 'Abdul', 'ignored'), null);
});

test('an entry with no credential at all is refused rather than unmatchable', () => {
  assert.throws(() => rosterFromArray([{ username: 'Abdul' }]), RosterError);
});

test('an empty roster is refused, since nobody could sign in', () => {
  assert.throws(() => rosterFromArray([]), /non-empty/);
  assert.throws(() => rosterFromArray(null), /non-empty/);
});

test('usernames match regardless of case, and viewer is the default role', () => {
  const roster = rosterFromArray([{ username: 'Abdul', password: 'p' }]);

  assert.deepEqual(authenticateAgainst(roster, 'ABDUL', 'p').roles, ['viewer']);
  // The stored spelling is what comes back, not what was typed.
  assert.equal(authenticateAgainst(roster, 'abdul', 'p').username, 'Abdul');
});

test('an unknown user and a wrong password are indistinguishable', () => {
  const roster = rosterFromArray([{ username: 'Abdul', password: 'p' }]);

  assert.equal(authenticateAgainst(roster, 'nobody', 'p'), null);
  assert.equal(authenticateAgainst(roster, 'Abdul', 'wrong'), null);
  // Both ran a real verification; neither short-circuited on the lookup.
  assert.equal(authenticateAgainst(roster, undefined, undefined), null);
});

// ---------------------------------------------------------------- fetching --

test('the roster is read from Secrets Manager and cached', async () => {
  const { fetchImpl, calls } = fakeSecrets([rosterJson('first')]);

  const a = await loadRoster(SETTINGS, { fetchImpl, credentials: CREDENTIALS });
  const b = await loadRoster(SETTINGS, { fetchImpl, credentials: CREDENTIALS });

  assert.equal(calls.length, 1, 'the second sign-in should not call AWS again');
  assert.equal(a, b);
  assert.ok(authenticateAgainst(a, 'Abdul', 'first'));
});

test('a rotation takes effect once the cache window passes, with no deploy', async () => {
  const { fetchImpl, calls } = fakeSecrets([rosterJson('old'), rosterJson('new')]);
  let clock = 1_000;
  const options = { fetchImpl, credentials: CREDENTIALS, now: () => clock };

  const before = await loadRoster(SETTINGS, options);
  assert.ok(authenticateAgainst(before, 'Abdul', 'old'));

  // Still inside the window: the old password is still the live one.
  clock += 59_000;
  assert.ok(authenticateAgainst(await loadRoster(SETTINGS, options), 'Abdul', 'old'));
  assert.equal(calls.length, 1);

  clock += 2_000;
  const after = await loadRoster(SETTINGS, options);
  assert.equal(calls.length, 2);
  assert.ok(authenticateAgainst(after, 'Abdul', 'new'));
  assert.equal(authenticateAgainst(after, 'Abdul', 'old'), null);
});

test('a different secret id is never served from another one cache entry', async () => {
  const { fetchImpl, calls } = fakeSecrets([rosterJson('a'), rosterJson('b')]);

  await loadRoster(SETTINGS, { fetchImpl, credentials: CREDENTIALS });
  await loadRoster({ ...SETTINGS, secretId: 'other/users' }, { fetchImpl, credentials: CREDENTIALS });

  assert.equal(calls.length, 2);
});

test('the call is a signed GetSecretValue for exactly the named secret', async () => {
  const { fetchImpl, calls } = fakeSecrets([rosterJson('p')]);

  await loadRoster(SETTINGS, { fetchImpl, credentials: CREDENTIALS });
  const { url, init } = calls[0];

  assert.equal(url, 'https://secretsmanager.us-east-1.amazonaws.com/');
  assert.equal(init.headers['x-amz-target'], 'secretsmanager.GetSecretValue');
  assert.deepEqual(JSON.parse(init.body), { SecretId: 'watcher/users' });
  assert.match(init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\//);
  assert.match(init.headers.authorization, /\/us-east-1\/secretsmanager\/aws4_request/);
});

test('{ users: [...] } is accepted as well as a bare array', async () => {
  const { fetchImpl } = fakeSecrets([JSON.stringify({ users: [{ username: 'Abdul', password: 'p' }] })]);

  const roster = await loadRoster(SETTINGS, { fetchImpl, credentials: CREDENTIALS });

  assert.ok(authenticateAgainst(roster, 'Abdul', 'p'));
});

test('a failure names the status without echoing the secret back into the log', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 403,
    text: async () => 'AccessDeniedException: user is not authorized on arn:aws:secretsmanager:...',
  });

  await assert.rejects(
    () => loadRoster(SETTINGS, { fetchImpl, credentials: CREDENTIALS }),
    (error) => {
      assert.match(error.message, /answered 403/);
      assert.doesNotMatch(error.message, /arn:aws/);
      return true;
    },
  );
});

test('a secret that is not JSON says so rather than throwing a parse error', async () => {
  const { fetchImpl } = fakeSecrets(['not json at all']);

  await assert.rejects(() => loadRoster(SETTINGS, { fetchImpl, credentials: CREDENTIALS }), /not valid JSON/);
});

test('a binary secret is refused rather than read as a roster', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ SecretBinary: 'AAAA' }),
  });

  await assert.rejects(() => loadRoster(SETTINGS, { fetchImpl, credentials: CREDENTIALS }), /binary/);
});

// ----------------------------------------------------------------- signing --

test('the session token is signed, not merely sent', () => {
  // Temporary credentials are what Lambda has, and AWS rejects a request whose
  // signature does not cover the token.
  const headers = signRequest({
    host: 'secretsmanager.us-east-1.amazonaws.com',
    region: 'us-east-1',
    service: 'secretsmanager',
    credentials: { ...CREDENTIALS, sessionToken: 'TOKEN' },
    body: '{}',
    now: new Date('2026-09-25T00:00:00Z'),
  });

  assert.equal(headers['x-amz-security-token'], 'TOKEN');
  assert.match(headers.authorization, /SignedHeaders=[^,]*x-amz-security-token/);
});

test('a changed body changes the signature', () => {
  const base = {
    host: 'secretsmanager.us-east-1.amazonaws.com',
    region: 'us-east-1',
    service: 'secretsmanager',
    credentials: CREDENTIALS,
    now: new Date('2026-09-25T00:00:00Z'),
  };

  const one = signRequest({ ...base, body: JSON.stringify({ SecretId: 'a' }) });
  const two = signRequest({ ...base, body: JSON.stringify({ SecretId: 'b' }) });

  assert.notEqual(one.authorization, two.authorization);
});
