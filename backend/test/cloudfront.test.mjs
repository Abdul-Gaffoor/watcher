import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { createSignedCookies } from '../src/cloudfront.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

/** Undo CloudFront's custom base64 alphabet. */
function fromCloudfrontBase64(value) {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/'), 'base64');
}

const expiresAt = Math.floor(Date.now() / 1000) + 3600;
const cookies = createSignedCookies({
  resource: 'https://example.cloudfront.net/media/*',
  expiresAt,
  keyPairId: 'K123EXAMPLE',
  privateKey,
});

test('all three CloudFront cookies are issued', () => {
  assert.deepEqual(Object.keys(cookies).sort(), [
    'CloudFront-Key-Pair-Id',
    'CloudFront-Policy',
    'CloudFront-Signature',
  ]);
  assert.equal(cookies['CloudFront-Key-Pair-Id'], 'K123EXAMPLE');
});

test('the policy scopes access to the media path and expires', () => {
  const policy = JSON.parse(fromCloudfrontBase64(cookies['CloudFront-Policy']).toString('utf8'));
  const statement = policy.Statement[0];
  assert.equal(statement.Resource, 'https://example.cloudfront.net/media/*');
  assert.equal(statement.Condition.DateLessThan['AWS:EpochTime'], expiresAt);
});

test('cookie values avoid characters that are illegal in a cookie', () => {
  for (const value of Object.values(cookies)) {
    assert.match(value, /^[A-Za-z0-9\-_~]+$/, `unexpected characters in ${value.slice(0, 16)}…`);
  }
});

test('the signature verifies against the public key with RSA-SHA1', () => {
  const policy = fromCloudfrontBase64(cookies['CloudFront-Policy']);
  const signature = fromCloudfrontBase64(cookies['CloudFront-Signature']);
  assert.equal(createVerify('RSA-SHA1').update(policy).verify(publicKey, signature), true);
});

test('a policy for a different resource does not verify against this signature', () => {
  const signature = fromCloudfrontBase64(cookies['CloudFront-Signature']);
  const tampered = Buffer.from(
    JSON.stringify({
      Statement: [{ Resource: 'https://example.cloudfront.net/*', Condition: { DateLessThan: { 'AWS:EpochTime': expiresAt } } }],
    }),
  );
  assert.equal(createVerify('RSA-SHA1').update(tampered).verify(publicKey, signature), false);
});
