import { strict as assert } from 'node:assert';
import test from 'node:test';

/**
 * getConfig caches per module instance, so each case imports a fresh one. The
 * query string is what makes Node treat it as a different module.
 */
let instance = 0;
async function loadConfig(env) {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('COGNITO_') || key === 'USERS_JSON' || key === 'AWS_REGION') {
      delete process.env[key];
    }
  }
  Object.assign(process.env, env);
  try {
    const module = await import(`../src/config.mjs?case=${(instance += 1)}`);
    return module.getConfig();
  } finally {
    process.env = saved;
  }
}

const ROSTER = JSON.stringify([
  { username: 'alex', passwordHash: 'scrypt$16384$8$1$c2FsdA==$aGFzaA==' },
]);
const BASE = { SESSION_SECRET: 'secret' };
const POOL = { COGNITO_USER_POOL_ID: 'us-east-1_abc', COGNITO_CLIENT_ID: 'clientid' };

test('a roster deployment starts even though Lambda always sets AWS_REGION', async () => {
  // The region is a fallback, not a signal. Counting it as one made every
  // roster deployment look half-configured for Cognito and refuse to start,
  // which is exactly how it failed in production.
  const config = await loadConfig({ ...BASE, USERS_JSON: ROSTER, AWS_REGION: 'us-east-1' });

  assert.equal(config.usesCognito, false);
  assert.equal(config.users.size, 1);
});

test('Cognito takes the region from AWS_REGION when none is given', async () => {
  const config = await loadConfig({ ...BASE, ...POOL, AWS_REGION: 'eu-west-2' });

  assert.equal(config.usesCognito, true);
  assert.equal(config.cognitoRegion, 'eu-west-2');
  assert.equal(config.users.size, 0);
});

test('an explicit Cognito region wins over the Lambda region', async () => {
  const config = await loadConfig({
    ...BASE,
    ...POOL,
    AWS_REGION: 'eu-west-2',
    COGNITO_REGION: 'us-east-1',
  });

  assert.equal(config.cognitoRegion, 'us-east-1');
});

test('a pool without a client is refused rather than half-used', async () => {
  await assert.rejects(
    () => loadConfig({ ...BASE, USERS_JSON: ROSTER, COGNITO_USER_POOL_ID: 'us-east-1_abc' }),
    /must be set together/,
  );
});

test('Cognito with no region at all is refused', async () => {
  await assert.rejects(() => loadConfig({ ...BASE, ...POOL }), /COGNITO_REGION/);
});

test('no directory at all is refused, since nobody could sign in', async () => {
  await assert.rejects(() => loadConfig({ ...BASE }), /either COGNITO_\* or USERS_JSON/);
});

test('both directories at once is refused, since neither would be authoritative', async () => {
  await assert.rejects(
    () => loadConfig({ ...BASE, ...POOL, AWS_REGION: 'us-east-1', USERS_JSON: ROSTER }),
    /not both/,
  );
});

test('the media signer stays optional and independent of the directory', async () => {
  const config = await loadConfig({ ...BASE, USERS_JSON: ROSTER, AWS_REGION: 'us-east-1' });

  assert.equal(config.signsMediaCookies, false);
});

test('a half-configured media signer is refused', async () => {
  await assert.rejects(
    () =>
      loadConfig({
        ...BASE,
        USERS_JSON: ROSTER,
        AWS_REGION: 'us-east-1',
        CLOUDFRONT_KEY_PAIR_ID: 'KEYPAIR',
      }),
    /must be set together or not at all/,
  );
});
