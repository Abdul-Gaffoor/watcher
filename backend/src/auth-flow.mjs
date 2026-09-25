import {
  associateSoftwareToken,
  claimsFromIdToken,
  CognitoError,
  initiateAuth,
  otpauthUri,
  respondToAuthChallenge,
  verifySoftwareToken,
} from './cognito.mjs';
import { signJwt, verifyJwt } from './crypto-utils.mjs';

/**
 * Sign-in as a state machine, because requiring MFA means it cannot be one
 * round trip. Cognito answers a password with a challenge, and which challenge
 * depends on what the account still owes:
 *
 *   new_password_required  an invited account still holds its temporary password
 *   mfa_setup_required     no authenticator app enrolled yet
 *   mfa_required           enrolled, and owes a code
 *   authenticated          nothing left to prove
 *
 * Between steps the browser holds a challenge token rather than Cognito's raw
 * session. It is a short-lived JWT signed with the same secret as the session
 * cookie, carrying the Cognito session and the username. Signing it means a
 * viewer cannot rewrite which account they are part-way through authenticating
 * as, and the expiry means an abandoned attempt cannot be resumed later.
 */

const CHALLENGE_TTL_SECONDS = 15 * 60;

/** Cognito's own session is short-lived; this only has to outlive a person typing. */
function issueChallengeToken({ sessionSecret, username, cognitoSession, challengeName }) {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(
    {
      sub: username,
      cs: cognitoSession,
      cn: challengeName,
      iat: now,
      exp: now + CHALLENGE_TTL_SECONDS,
    },
    sessionSecret,
  );
}

export function readChallengeToken(token, sessionSecret) {
  const payload = verifyJwt(token, sessionSecret);
  if (!payload?.cs || !payload?.sub || !payload?.cn) return null;
  return { username: payload.sub, cognitoSession: payload.cs, challengeName: payload.cn };
}

function userFromTokens(result) {
  const claims = claimsFromIdToken(result?.IdToken) ?? {};
  const username = claims['cognito:username'] ?? claims.sub;
  const groups = claims['cognito:groups'];
  return {
    username,
    name: claims.name || claims.preferred_username || username,
    // Groups are how a trading-only tier would eventually be expressed; until
    // one exists, everyone who can sign in is a viewer.
    roles: Array.isArray(groups) && groups.length > 0 ? groups : ['viewer'],
  };
}

/**
 * Turns whatever Cognito just said into the next thing the browser should do.
 * MFA_SETUP is the one challenge that needs another call before the viewer can
 * act on it, because the secret they have to enrol comes from Cognito.
 */
async function advance({ config, username, result, fetchImpl }) {
  if (result.AuthenticationResult) {
    return { status: 'authenticated', user: userFromTokens(result.AuthenticationResult) };
  }

  const challengeName = result.ChallengeName;
  const session = result.Session;

  if (challengeName === 'NEW_PASSWORD_REQUIRED') {
    return {
      status: 'new_password_required',
      challengeToken: issueChallengeToken({
        sessionSecret: config.sessionSecret,
        username,
        cognitoSession: session,
        challengeName,
      }),
    };
  }

  if (challengeName === 'MFA_SETUP') {
    const association = await associateSoftwareToken({
      region: config.cognitoRegion,
      session,
      fetchImpl,
    });
    return {
      status: 'mfa_setup_required',
      secretCode: association.SecretCode,
      otpauthUri: otpauthUri({
        secret: association.SecretCode,
        username,
        issuer: config.cognitoIssuerLabel,
      }),
      challengeToken: issueChallengeToken({
        sessionSecret: config.sessionSecret,
        username,
        // Enrolment continues against the session association handed back.
        cognitoSession: association.Session,
        challengeName,
      }),
    };
  }

  if (challengeName === 'SOFTWARE_TOKEN_MFA') {
    return {
      status: 'mfa_required',
      challengeToken: issueChallengeToken({
        sessionSecret: config.sessionSecret,
        username,
        cognitoSession: session,
        challengeName,
      }),
    };
  }

  // SMS_MFA, DEVICE_SRP_AUTH and friends are not enabled on this pool, so
  // reaching one means the pool drifted from what this code expects.
  throw new CognitoError(`Unsupported challenge: ${challengeName ?? 'none'}`, {
    type: 'UnsupportedChallenge',
    status: 501,
  });
}

/** Step one. A wrong password is indistinguishable from an unknown user by design. */
export async function beginLogin({ config, username, password, fetchImpl }) {
  const result = await initiateAuth({
    region: config.cognitoRegion,
    clientId: config.cognitoClientId,
    username,
    password,
    fetchImpl,
  });
  return advance({ config, username, result, fetchImpl });
}

/** Replaces the temporary password an invited account starts with. */
export async function submitNewPassword({ config, challenge, password, fetchImpl }) {
  const result = await respondToAuthChallenge({
    region: config.cognitoRegion,
    clientId: config.cognitoClientId,
    challengeName: 'NEW_PASSWORD_REQUIRED',
    session: challenge.cognitoSession,
    username: challenge.username,
    responses: { NEW_PASSWORD: password },
    fetchImpl,
  });
  return advance({ config, username: challenge.username, result, fetchImpl });
}

/**
 * Completes enrolment. The code proves the authenticator app is in sync before
 * the factor is trusted, so a mistyped secret fails here rather than locking
 * the viewer out of their own account on the next sign-in.
 */
export async function verifyMfaSetup({ config, challenge, code, fetchImpl }) {
  const verification = await verifySoftwareToken({
    region: config.cognitoRegion,
    session: challenge.cognitoSession,
    userCode: code,
    friendlyDeviceName: 'Authenticator app',
    fetchImpl,
  });

  if (verification.Status !== 'SUCCESS') {
    throw new CognitoError('That code was not accepted.', {
      type: 'EnableSoftwareTokenMFAException',
      status: 401,
    });
  }

  const result = await respondToAuthChallenge({
    region: config.cognitoRegion,
    clientId: config.cognitoClientId,
    challengeName: 'MFA_SETUP',
    session: verification.Session,
    username: challenge.username,
    responses: {},
    fetchImpl,
  });
  return advance({ config, username: challenge.username, result, fetchImpl });
}

/** The ordinary second step, once an authenticator app is enrolled. */
export async function submitMfaCode({ config, challenge, code, fetchImpl }) {
  const result = await respondToAuthChallenge({
    region: config.cognitoRegion,
    clientId: config.cognitoClientId,
    challengeName: 'SOFTWARE_TOKEN_MFA',
    session: challenge.cognitoSession,
    username: challenge.username,
    responses: { SOFTWARE_TOKEN_MFA_CODE: code },
    fetchImpl,
  });
  return advance({ config, username: challenge.username, result, fetchImpl });
}

/**
 * Cognito's error names, mapped to a status and a message safe to show. A
 * wrong password and an unknown user both land on the same 401 because the
 * pool has prevent_user_existence_errors on, and this keeps it that way.
 */
export function describeCognitoError(error) {
  if (!(error instanceof CognitoError)) return null;

  switch (error.type) {
    case 'NotAuthorizedException':
    case 'UserNotFoundException':
      return { status: 401, message: 'Incorrect username or password.' };
    case 'CodeMismatchException':
    case 'EnableSoftwareTokenMFAException':
      return { status: 401, message: 'That code was not accepted. Try the next one.' };
    case 'ExpiredCodeException':
      return { status: 401, message: 'That code has expired. Try the next one.' };
    case 'InvalidPasswordException':
      return { status: 400, message: error.message || 'That password does not meet the policy.' };
    case 'PasswordResetRequiredException':
      return { status: 403, message: 'This account needs a password reset.' };
    case 'UserNotConfirmedException':
      return { status: 403, message: 'This account is not confirmed yet.' };
    case 'TooManyRequestsException':
    case 'LimitExceededException':
      return { status: 429, message: 'Too many attempts. Try again in a few minutes.' };
    case 'TooManyFailedAttemptsException':
      return { status: 429, message: 'Too many failed attempts. Try again later.' };
    default:
      return null;
  }
}
