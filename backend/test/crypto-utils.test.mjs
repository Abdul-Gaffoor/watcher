import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, signJwt, verifyJwt } from '../src/crypto-utils.mjs';

test('a password verifies against its own hash', () => {
  const hash = hashPassword('correct horse battery staple');
  assert.equal(verifyPassword('correct horse battery staple', hash), true);
});

test('a wrong password does not verify', () => {
  const hash = hashPassword('correct horse battery staple');
  assert.equal(verifyPassword('Correct horse battery staple', hash), false);
  assert.equal(verifyPassword('', hash), false);
});

test('hashing the same password twice produces different hashes', () => {
  assert.notEqual(hashPassword('same'), hashPassword('same'));
});

test('malformed stored hashes are rejected rather than throwing', () => {
  for (const stored of ['', 'not-a-hash', 'scrypt$$$$', 'bcrypt$1$2$3$4$5', null, undefined]) {
    assert.equal(verifyPassword('anything', stored), false);
  }
});

test('a signed JWT round-trips', () => {
  const exp = Math.floor(Date.now() / 1000) + 60;
  const token = signJwt({ sub: 'demo', name: 'Demo', roles: ['viewer'], exp }, 'secret');
  const payload = verifyJwt(token, 'secret');
  assert.equal(payload.sub, 'demo');
  assert.deepEqual(payload.roles, ['viewer']);
});

test('a JWT signed with another secret is rejected', () => {
  const exp = Math.floor(Date.now() / 1000) + 60;
  const token = signJwt({ sub: 'demo', exp }, 'secret');
  assert.equal(verifyJwt(token, 'other-secret'), null);
});

test('an expired JWT is rejected', () => {
  const exp = Math.floor(Date.now() / 1000) - 1;
  const token = signJwt({ sub: 'demo', exp }, 'secret');
  assert.equal(verifyJwt(token, 'secret'), null);
});

test('a JWT with no expiry is rejected', () => {
  assert.equal(verifyJwt(signJwt({ sub: 'demo' }, 'secret'), 'secret'), null);
});

test('a tampered payload is rejected', () => {
  const exp = Math.floor(Date.now() / 1000) + 60;
  const token = signJwt({ sub: 'demo', roles: ['viewer'], exp }, 'secret');
  const [header, , signature] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 'demo', roles: ['admin'], exp })).toString('base64url');
  assert.equal(verifyJwt(`${header}.${forged}.${signature}`, 'secret'), null);
});

test('garbage tokens are rejected rather than throwing', () => {
  for (const token of ['', 'a.b', 'a.b.c.d', null, undefined, 42]) {
    assert.equal(verifyJwt(token, 'secret'), null);
  }
});
