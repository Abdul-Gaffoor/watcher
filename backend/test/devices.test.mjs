import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  DeviceError,
  decidePairing,
  describeDevice,
  describePairing,
  formatUserCode,
  generateUserCode,
  normaliseUserCode,
  pollPairing,
  resetMemoryStore,
  startPairing,
} from '../src/devices.mjs';

/** No table, so the in-memory store stands in — same flow, one process. */
const CONFIG = { deviceCodeTtlSeconds: 600 };
const VIEWER = { username: 'Abdul', name: 'Abdul', roles: ['viewer', 'admin'] };
const REQUEST = { userAgent: 'Mozilla/5.0 (SMART-TV; Tizen) Chrome/120', sourceIp: '203.0.113.7' };

test.beforeEach(() => resetMemoryStore());

async function pending() {
  return startPairing(CONFIG, REQUEST);
}

// ----------------------------------------------------------------- codes --

test('a code never contains a character that is misread off a screen', () => {
  // 0/O, 1/I/L and U/V are where reading a code across a room goes wrong.
  for (let i = 0; i < 200; i += 1) {
    assert.doesNotMatch(generateUserCode(), /[01OILUVAEY]/);
    assert.equal(generateUserCode().length, 8);
  }
});

test('a code is accepted however it is typed', () => {
  const code = generateUserCode();
  const display = formatUserCode(code);

  assert.equal(normaliseUserCode(display), code);
  assert.equal(normaliseUserCode(display.toLowerCase()), code);
  assert.equal(normaliseUserCode(` ${display} `), code);
  assert.equal(normaliseUserCode(code), code);
});

test('a code that could not have been issued is refused before any lookup', () => {
  for (const bad of ['', 'SHORT', 'TOOLONGGGG', 'ABCD-000O', 'WXYZ 234!']) {
    assert.throws(() => normaliseUserCode(bad), DeviceError, `expected ${bad} to be refused`);
  }
});

test('the device label describes without quoting the user agent back', () => {
  assert.equal(describeDevice('Mozilla/5.0 (SMART-TV; Tizen) Chrome/120'), 'Chrome on a TV');
  assert.equal(describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/605'), 'Safari on an iPhone');
  assert.equal(describeDevice(undefined), 'A browser on an unknown device');

  // Every Chromium agent also claims Safari, and Chrome on iOS claims neither
  // by name, so the order these are tested in is the whole implementation.
  assert.equal(
    describeDevice('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/120 Safari/537.36'),
    'Chrome on a Linux machine',
  );
  assert.equal(
    describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) CriOS/120 Safari/604'),
    'Chrome on an iPhone',
  );
  assert.equal(
    describeDevice('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120 Safari/537.36 Edg/120'),
    'Edge on a Windows PC',
  );
  assert.equal(
    describeDevice('Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/537.36 SamsungBrowser/4.0 Chrome/76 Safari/537.36'),
    'Samsung Internet on a TV',
  );

  // A crafted agent cannot fill the approval screen with a persuasive sentence.
  assert.ok(describeDevice(`Chrome/1 ${'x'.repeat(5000)}`).length <= 64);
});

// ------------------------------------------------------------ happy path --

test('a television is signed in by a phone, and inherits its roles', async () => {
  const started = await pending();
  assert.equal(started.displayCode, formatUserCode(started.userCode));

  // The device waits.
  assert.deepEqual(await pollPairing(CONFIG, started), { status: 'pending', intervalSeconds: 2 });

  // The phone is shown what it is approving.
  const shown = await describePairing(CONFIG, started.userCode);
  assert.equal(shown.device, 'Chrome on a TV');
  assert.equal(shown.ip, '203.0.113.7');

  await decidePairing(CONFIG, { userCode: started.userCode, approve: true, user: VIEWER });

  const collected = await pollPairing(CONFIG, started);
  assert.equal(collected.status, 'approved');
  assert.deepEqual(collected.user, VIEWER);
});

test('a refusal is reported rather than left to time out', async () => {
  const started = await pending();
  await decidePairing(CONFIG, { userCode: started.userCode, approve: false, user: VIEWER });

  assert.equal((await pollPairing(CONFIG, started)).status, 'denied');
});

// -------------------------------------------------------------- attacks --

test('reading the code off the screen is not enough to collect the session', async () => {
  // The whole point of two codes. An onlooker sees the short one; the session
  // goes only to whoever also holds the device code.
  const started = await pending();
  await decidePairing(CONFIG, { userCode: started.userCode, approve: true, user: VIEWER });

  await assert.rejects(
    () => pollPairing(CONFIG, { userCode: started.userCode, deviceCode: 'guessed' }),
    (error) => {
      assert.equal(error.status, 404);
      return true;
    },
  );

  // And the real device is still able to collect, so a failed guess did not
  // consume the pairing.
  assert.equal((await pollPairing(CONFIG, started)).status, 'approved');
});

test('a pairing is good for exactly one session', async () => {
  const started = await pending();
  await decidePairing(CONFIG, { userCode: started.userCode, approve: true, user: VIEWER });

  assert.equal((await pollPairing(CONFIG, started)).status, 'approved');
  // Replaying the same device code afterwards gets nothing.
  assert.equal((await pollPairing(CONFIG, started)).status, 'expired');
});

test('approving twice cannot revive a collected pairing', async () => {
  const started = await pending();
  await decidePairing(CONFIG, { userCode: started.userCode, approve: true, user: VIEWER });
  await pollPairing(CONFIG, started);

  await assert.rejects(
    () => decidePairing(CONFIG, { userCode: started.userCode, approve: true, user: VIEWER }),
    /not waiting for approval/,
  );
});

test('an expired pairing cannot be approved or collected', async () => {
  const started = await pending();
  const later = Date.now() + 601 * 1000;

  await assert.rejects(
    () => decidePairing(CONFIG, { userCode: started.userCode, approve: true, user: VIEWER }, { now: later }),
    /not waiting for approval/,
  );
  assert.equal((await pollPairing(CONFIG, started, { now: later })).status, 'expired');
});

test('expiry is enforced in code, not left to the table sweep', async () => {
  // DynamoDB deletes TTL rows lazily and sometimes hours late, so a row that
  // is still present must still be treated as gone.
  const started = await pending();
  await decidePairing(CONFIG, { userCode: started.userCode, approve: true, user: VIEWER });

  const later = Date.now() + 601 * 1000;
  assert.equal((await pollPairing(CONFIG, started, { now: later })).status, 'expired');
});

test('an unknown, used and expired code are all the same answer', async () => {
  // Telling them apart would make this an oracle for which codes are live.
  const started = await pending();
  await decidePairing(CONFIG, { userCode: started.userCode, approve: true, user: VIEWER });
  await pollPairing(CONFIG, started);

  const messages = [];
  for (const code of [started.userCode, generateUserCode()]) {
    await assert.rejects(
      () => describePairing(CONFIG, code),
      (error) => {
        messages.push(error.message);
        assert.equal(error.status, 404);
        return true;
      },
    );
  }
  assert.equal(new Set(messages).size, 1, 'the answers must be indistinguishable');
});

test('two pairings in flight do not see each other', async () => {
  const tv = await pending();
  const laptop = await startPairing(CONFIG, { userAgent: 'Mozilla/5.0 (Macintosh; Mac OS X) Safari/17', sourceIp: '198.51.100.4' });

  assert.notEqual(tv.userCode, laptop.userCode);
  assert.notEqual(tv.deviceCode, laptop.deviceCode);

  await decidePairing(CONFIG, { userCode: tv.userCode, approve: true, user: VIEWER });

  assert.equal((await pollPairing(CONFIG, tv)).status, 'approved');
  assert.equal((await pollPairing(CONFIG, laptop)).status, 'pending');
});

test('a device code from one pairing does not open another', async () => {
  const tv = await pending();
  const laptop = await startPairing(CONFIG, REQUEST);
  await decidePairing(CONFIG, { userCode: laptop.userCode, approve: true, user: VIEWER });

  await assert.rejects(
    () => pollPairing(CONFIG, { userCode: laptop.userCode, deviceCode: tv.deviceCode }),
    /not waiting for approval/,
  );
});

test('the stored record keeps a hash, never the device code itself', async () => {
  // A dump of the table must not be replayable into a pending sign-in.
  const started = await pending();
  const { storeFor } = await import('../src/devices.mjs');
  const row = await storeFor(CONFIG).read(started.userCode);

  assert.match(row.deviceHash, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(row).includes(started.deviceCode), false);
});
