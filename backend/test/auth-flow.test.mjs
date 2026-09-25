import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  beginLogin,
  describeCognitoError,
  readChallengeToken,
  submitMfaCode,
  submitNewPassword,
  verifyMfaSetup,
} from '../src/auth-flow.mjs';
import { CognitoError, otpauthUri } from '../src/cognito.mjs';
import { signJwt } from '../src/crypto-utils.mjs';

const config = {
  sessionSecret: 'flow-test-secret',
  cognitoRegion: 'us-east-1',
  cognitoClientId: 'testclientid',
  cognitoUserPoolId: 'us-east-1_test',
  cognitoIssuerLabel: 'Watcher',
};

/** An ID token is only base64-decoded, never verified, so this is enough. */
function idToken(claims) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part(claims)}.signature`;
}

/**
 * Stands in for Cognito. Each entry answers one operation, in order, so a test
 * spells out the exchange it expects rather than a single canned reply.
 */
function fakeCognito(script) {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const operation = init.headers['x-amz-target'].split('.').pop();
    const body = JSON.parse(init.body);
    calls.push({ operation, body });

    const next = script.shift();
    if (!next) throw new Error(`No scripted reply for ${operation}`);
    assert.equal(operation, next.operation, `expected a call to ${next.operation}`);

    if (next.error) {
      return {
        ok: false,
        status: next.status ?? 400,
        text: async () =>
          JSON.stringify({ __type: `com.amazonaws.cognitoidp#${next.error}`, message: next.message ?? '' }),
      };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(next.reply) };
  };
  return { fetchImpl, calls };
}

test('a password alone never authenticates when MFA is required', async () => {
  const { fetchImpl, calls } = fakeCognito([
    { operation: 'InitiateAuth', reply: { ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: 'S1' } },
  ]);

  const outcome = await beginLogin({ config, username: 'abdul', password: 'pw', fetchImpl });

  assert.equal(outcome.status, 'mfa_required');
  assert.ok(outcome.challengeToken);
  // No tokens, and nothing that could be mistaken for a session.
  assert.equal(outcome.user, undefined);
  assert.equal(calls[0].body.AuthFlow, 'USER_PASSWORD_AUTH');
});

test('an invited account is sent to set a password first', async () => {
  const { fetchImpl } = fakeCognito([
    { operation: 'InitiateAuth', reply: { ChallengeName: 'NEW_PASSWORD_REQUIRED', Session: 'S1' } },
  ]);

  const outcome = await beginLogin({ config, username: 'abdul', password: 'temp', fetchImpl });

  assert.equal(outcome.status, 'new_password_required');
  const challenge = readChallengeToken(outcome.challengeToken, config.sessionSecret);
  assert.equal(challenge.challengeName, 'NEW_PASSWORD_REQUIRED');
  assert.equal(challenge.cognitoSession, 'S1');
});

test('enrolment hands back a secret and the URI an authenticator app reads', async () => {
  const { fetchImpl, calls } = fakeCognito([
    { operation: 'InitiateAuth', reply: { ChallengeName: 'MFA_SETUP', Session: 'S1' } },
    { operation: 'AssociateSoftwareToken', reply: { SecretCode: 'JBSWY3DPEHPK3PXP', Session: 'S2' } },
  ]);

  const outcome = await beginLogin({ config, username: 'abdul', password: 'pw', fetchImpl });

  assert.equal(outcome.status, 'mfa_setup_required');
  assert.equal(outcome.secretCode, 'JBSWY3DPEHPK3PXP');
  assert.ok(outcome.otpauthUri.startsWith('otpauth://totp/Watcher%3Aabdul?'));
  assert.ok(outcome.otpauthUri.includes('secret=JBSWY3DPEHPK3PXP'));
  // Enrolment continues against the session the association returned, not S1.
  assert.equal(calls[1].body.Session, 'S1');
  assert.equal(readChallengeToken(outcome.challengeToken, config.sessionSecret).cognitoSession, 'S2');
});

test('setting a new password leads straight into enrolment', async () => {
  const { fetchImpl, calls } = fakeCognito([
    { operation: 'RespondToAuthChallenge', reply: { ChallengeName: 'MFA_SETUP', Session: 'S2' } },
    { operation: 'AssociateSoftwareToken', reply: { SecretCode: 'SECRET', Session: 'S3' } },
  ]);

  const outcome = await submitNewPassword({
    config,
    challenge: { username: 'abdul', cognitoSession: 'S1', challengeName: 'NEW_PASSWORD_REQUIRED' },
    password: 'a-much-longer-password',
    fetchImpl,
  });

  assert.equal(outcome.status, 'mfa_setup_required');
  assert.equal(calls[0].body.ChallengeResponses.NEW_PASSWORD, 'a-much-longer-password');
  // Cognito rejects a challenge response that does not name the user.
  assert.equal(calls[0].body.ChallengeResponses.USERNAME, 'abdul');
});

test('a verified enrolment completes the sign-in', async () => {
  const { fetchImpl, calls } = fakeCognito([
    { operation: 'VerifySoftwareToken', reply: { Status: 'SUCCESS', Session: 'S3' } },
    {
      operation: 'RespondToAuthChallenge',
      reply: {
        AuthenticationResult: {
          IdToken: idToken({ 'cognito:username': 'abdul', name: 'Abdul' }),
        },
      },
    },
  ]);

  const outcome = await verifyMfaSetup({
    config,
    challenge: { username: 'abdul', cognitoSession: 'S2', challengeName: 'MFA_SETUP' },
    code: '123456',
    fetchImpl,
  });

  assert.equal(outcome.status, 'authenticated');
  assert.deepEqual(outcome.user, { username: 'abdul', name: 'Abdul', roles: ['viewer'] });
  assert.equal(calls[1].body.Session, 'S3');
});

test('an enrolment that is not confirmed does not sign anyone in', async () => {
  const { fetchImpl } = fakeCognito([
    { operation: 'VerifySoftwareToken', reply: { Status: 'ERROR' } },
  ]);

  await assert.rejects(
    () =>
      verifyMfaSetup({
        config,
        challenge: { username: 'abdul', cognitoSession: 'S2', challengeName: 'MFA_SETUP' },
        code: '000000',
        fetchImpl,
      }),
    (error) => {
      assert.ok(error instanceof CognitoError);
      assert.equal(describeCognitoError(error).status, 401);
      return true;
    },
  );
});

test('a correct code on an enrolled account signs in', async () => {
  const { fetchImpl, calls } = fakeCognito([
    {
      operation: 'RespondToAuthChallenge',
      reply: {
        AuthenticationResult: { IdToken: idToken({ 'cognito:username': 'abdul' }) },
      },
    },
  ]);

  const outcome = await submitMfaCode({
    config,
    challenge: { username: 'abdul', cognitoSession: 'S1', challengeName: 'SOFTWARE_TOKEN_MFA' },
    code: '654321',
    fetchImpl,
  });

  assert.equal(outcome.status, 'authenticated');
  // With no name claim, the username stands in rather than showing "undefined".
  assert.equal(outcome.user.name, 'abdul');
  assert.equal(calls[0].body.ChallengeResponses.SOFTWARE_TOKEN_MFA_CODE, '654321');
});

test('group membership becomes roles', async () => {
  const { fetchImpl } = fakeCognito([
    {
      operation: 'RespondToAuthChallenge',
      reply: {
        AuthenticationResult: {
          IdToken: idToken({ 'cognito:username': 'abdul', 'cognito:groups': ['trading', 'cinema'] }),
        },
      },
    },
  ]);

  const outcome = await submitMfaCode({
    config,
    challenge: { username: 'abdul', cognitoSession: 'S1', challengeName: 'SOFTWARE_TOKEN_MFA' },
    code: '111111',
    fetchImpl,
  });

  assert.deepEqual(outcome.user.roles, ['trading', 'cinema']);
});

test('a wrong code is reported as a wrong code, not a server error', async () => {
  const { fetchImpl } = fakeCognito([
    { operation: 'RespondToAuthChallenge', error: 'CodeMismatchException' },
  ]);

  await assert.rejects(
    () =>
      submitMfaCode({
        config,
        challenge: { username: 'abdul', cognitoSession: 'S1', challengeName: 'SOFTWARE_TOKEN_MFA' },
        code: '000000',
        fetchImpl,
      }),
    (error) => {
      const described = describeCognitoError(error);
      assert.equal(described.status, 401);
      assert.match(described.message, /code/i);
      return true;
    },
  );
});

test('a wrong password and an unknown user read identically', async () => {
  for (const type of ['NotAuthorizedException', 'UserNotFoundException']) {
    const { fetchImpl } = fakeCognito([{ operation: 'InitiateAuth', error: type }]);
    await assert.rejects(
      () => beginLogin({ config, username: 'whoever', password: 'wrong', fetchImpl }),
      (error) => {
        assert.deepEqual(describeCognitoError(error), {
          status: 401,
          message: 'Incorrect username or password.',
        });
        return true;
      },
    );
  }
});

test('a rejected password explains the policy', async () => {
  const { fetchImpl } = fakeCognito([
    {
      operation: 'RespondToAuthChallenge',
      error: 'InvalidPasswordException',
      message: 'Password did not conform with policy: Password must have symbol characters',
    },
  ]);

  await assert.rejects(
    () =>
      submitNewPassword({
        config,
        challenge: { username: 'abdul', cognitoSession: 'S1', challengeName: 'NEW_PASSWORD_REQUIRED' },
        password: 'short',
        fetchImpl,
      }),
    (error) => {
      const described = describeCognitoError(error);
      assert.equal(described.status, 400);
      assert.match(described.message, /symbol/);
      return true;
    },
  );
});

test('lockout is surfaced as too many attempts', async () => {
  const { fetchImpl } = fakeCognito([
    { operation: 'InitiateAuth', error: 'TooManyFailedAttemptsException' },
  ]);

  await assert.rejects(
    () => beginLogin({ config, username: 'abdul', password: 'wrong', fetchImpl }),
    (error) => {
      assert.equal(describeCognitoError(error).status, 429);
      return true;
    },
  );
});

test('an unexpected challenge is refused rather than guessed at', async () => {
  const { fetchImpl } = fakeCognito([
    { operation: 'InitiateAuth', reply: { ChallengeName: 'SMS_MFA', Session: 'S1' } },
  ]);

  await assert.rejects(
    () => beginLogin({ config, username: 'abdul', password: 'pw', fetchImpl }),
    /Unsupported challenge: SMS_MFA/,
  );
});

test('a tampered challenge token is rejected', async () => {
  const { fetchImpl } = fakeCognito([
    { operation: 'InitiateAuth', reply: { ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: 'S1' } },
  ]);
  const { challengeToken } = await beginLogin({
    config,
    username: 'abdul',
    password: 'pw',
    fetchImpl,
  });

  // Rewriting the payload to claim another account breaks the signature.
  const [header, , signature] = challengeToken.split('.');
  const forgedPayload = Buffer.from(
    JSON.stringify({ sub: 'someone-else', cs: 'S1', cn: 'SOFTWARE_TOKEN_MFA', exp: 9999999999 }),
  ).toString('base64url');

  assert.equal(readChallengeToken(`${header}.${forgedPayload}.${signature}`, config.sessionSecret), null);
  assert.equal(readChallengeToken(challengeToken, 'a-different-secret'), null);
});

test('an abandoned sign-in cannot be resumed once its token expires', () => {
  const expired = signJwt(
    { sub: 'abdul', cs: 'S1', cn: 'SOFTWARE_TOKEN_MFA', exp: Math.floor(Date.now() / 1000) - 1 },
    config.sessionSecret,
  );

  assert.equal(readChallengeToken(expired, config.sessionSecret), null);
});

test('a token missing any of its parts is not a challenge', () => {
  assert.equal(readChallengeToken(undefined, config.sessionSecret), null);
  assert.equal(readChallengeToken('not-a-jwt', config.sessionSecret), null);
});

test('the otpauth URI escapes the label and names the issuer', () => {
  const uri = otpauthUri({ secret: 'ABC', username: 'a b', issuer: 'Watcher' });

  assert.ok(uri.startsWith('otpauth://totp/Watcher%3Aa%20b?'));
  assert.ok(uri.includes('issuer=Watcher'));
  assert.ok(uri.includes('digits=6'));
  assert.ok(uri.includes('period=30'));
});
