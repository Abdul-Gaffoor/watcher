/**
 * The Cognito calls this service needs, over fetch.
 *
 * Every operation here is one a signed-out user is allowed to make, so none of
 * them is SigV4-signed and none needs AWS credentials. That holds only while
 * the app client has no secret, which is why Terraform creates it without one:
 * a secret would have to be stored somewhere and hashed into every request for
 * no gain, since a public client's danger is entirely bounded by the user pool
 * policy rather than by the client id being hard to guess.
 *
 * The tokens Cognito returns are not signature-verified here. They arrive in
 * the body of a TLS response from Cognito itself, in the same request that
 * asked for them, so there is no third party to distrust and no JWKS to fetch.
 * A token read from a client would be a different matter.
 */

const JSON_1_1 = 'application/x-amz-json-1.1';
const TARGET_PREFIX = 'AWSCognitoIdentityProviderService';

export class CognitoError extends Error {
  constructor(message, { type, status }) {
    super(message);
    this.name = 'CognitoError';
    this.type = type;
    this.status = status;
  }
}

function endpoint(region) {
  return `https://cognito-idp.${region}.amazonaws.com/`;
}

async function call(region, operation, payload, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(endpoint(region), {
    method: 'POST',
    headers: {
      'content-type': JSON_1_1,
      'x-amz-target': `${TARGET_PREFIX}.${operation}`,
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      /* Cognito always answers JSON; a non-JSON body means something upstream. */
    }
  }

  if (!response.ok) {
    // The type arrives either as a bare name or as a shape id with a prefix.
    const type = String(body.__type ?? '').split('#').pop() || 'UnknownError';
    throw new CognitoError(body.message ?? `${operation} failed`, {
      type,
      status: response.status,
    });
  }

  return body;
}

/** Step one: username and password. With MFA on, this always returns a challenge. */
export function initiateAuth({ region, clientId, username, password, fetchImpl }) {
  return call(
    region,
    'InitiateAuth',
    {
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: clientId,
      AuthParameters: { USERNAME: username, PASSWORD: password },
    },
    { fetchImpl },
  );
}

/**
 * Answers whichever challenge Cognito raised. `responses` carries the fields
 * that challenge expects, and the session threads the exchange together.
 */
export function respondToAuthChallenge({
  region,
  clientId,
  challengeName,
  session,
  responses,
  username,
  fetchImpl,
}) {
  return call(
    region,
    'RespondToAuthChallenge',
    {
      ClientId: clientId,
      ChallengeName: challengeName,
      Session: session,
      // Cognito rejects a challenge response that does not name the user, even
      // though the session already identifies them.
      ChallengeResponses: { USERNAME: username, ...responses },
    },
    { fetchImpl },
  );
}

/** Begins enrolment: returns the shared secret for an authenticator app. */
export function associateSoftwareToken({ region, session, fetchImpl }) {
  return call(region, 'AssociateSoftwareToken', { Session: session }, { fetchImpl });
}

/** Proves the authenticator app is in sync before the factor is trusted. */
export function verifySoftwareToken({ region, session, userCode, friendlyDeviceName, fetchImpl }) {
  return call(
    region,
    'VerifySoftwareToken',
    {
      Session: session,
      UserCode: userCode,
      ...(friendlyDeviceName ? { FriendlyDeviceName: friendlyDeviceName } : {}),
    },
    { fetchImpl },
  );
}

/**
 * The URI an authenticator app expects, so enrolment is a scan or a tap rather
 * than transcribing a secret by hand.
 */
export function otpauthUri({ secret, username, issuer }) {
  const label = encodeURIComponent(`${issuer}:${username}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Reads the identity out of an ID token without verifying it — see the note above. */
export function claimsFromIdToken(idToken) {
  const parts = String(idToken ?? '').split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
