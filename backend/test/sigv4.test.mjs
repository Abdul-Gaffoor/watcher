import { strict as assert } from 'node:assert';
import test from 'node:test';

import { presignGetObject, uriEncode } from '../src/sigv4.mjs';

const EXAMPLE = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};

test('matches the signature AWS publishes for a presigned GET', () => {
  const url = presignGetObject({
    bucket: 'examplebucket',
    key: 'test.txt',
    region: 'us-east-1',
    host: 'examplebucket.s3.amazonaws.com',
    credentials: EXAMPLE,
    expiresIn: 86400,
    now: new Date('2013-05-24T00:00:00Z'),
  });

  // The worked example from the SigV4 documentation. If this drifts, every
  // presigned URL this service hands out is rejected by S3.
  assert.match(
    url,
    /X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/,
  );
});

test('signs against the regional endpoint by default', () => {
  const url = presignGetObject({
    bucket: 'watcher-media',
    key: 'media/catalog.json',
    region: 'eu-west-2',
    credentials: EXAMPLE,
  });

  assert.ok(url.startsWith('https://watcher-media.s3.eu-west-2.amazonaws.com/media/catalog.json?'));
});

test('carries the session token, which temporary credentials require', () => {
  const url = presignGetObject({
    bucket: 'b',
    key: 'k',
    region: 'us-east-1',
    credentials: { ...EXAMPLE, sessionToken: 'tok/en+value=' },
  });

  assert.ok(url.includes('X-Amz-Security-Token=tok%2Fen%2Bvalue%3D'));
});

test('omits the token parameter entirely for long-lived credentials', () => {
  const url = presignGetObject({
    bucket: 'b',
    key: 'k',
    region: 'us-east-1',
    credentials: EXAMPLE,
  });

  assert.ok(!url.includes('X-Amz-Security-Token'));
});

test('keeps slashes in the key but escapes everything else', () => {
  assert.equal(uriEncode('media/a b+c.ts', false), 'media/a%20b%2Bc.ts');
  assert.equal(uriEncode('media/a b+c.ts'), 'media%2Fa%20b%2Bc.ts');
});

test('escapes the characters encodeURIComponent leaves alone', () => {
  // AWS escapes these; encodeURIComponent does not. A key containing one
  // would otherwise sign differently from the URL requested.
  assert.equal(uriEncode("!'()*"), '%21%27%28%29%2A');
});

test('encodes non-ASCII as UTF-8 bytes', () => {
  assert.equal(uriEncode('é'), '%C3%A9');
});

test('expiry and timestamp appear as S3 expects them', () => {
  const url = presignGetObject({
    bucket: 'b',
    key: 'k',
    region: 'us-east-1',
    credentials: EXAMPLE,
    expiresIn: 900,
    now: new Date('2026-09-22T13:45:01.123Z'),
  });

  assert.ok(url.includes('X-Amz-Date=20260922T134501Z'));
  assert.ok(url.includes('X-Amz-Expires=900'));
  assert.ok(url.includes('X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20260922%2Fus-east-1%2Fs3%2Faws4_request'));
});
