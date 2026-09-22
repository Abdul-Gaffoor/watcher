import { createHash, createHmac } from 'node:crypto';

/**
 * Minimal AWS Signature Version 4 query-string presigning for S3 GETs.
 *
 * Written against node:crypto for the same reason the JWT and the CloudFront
 * policy signature are: this Lambda ships with no dependencies, so there is no
 * tree to audit on a function that gates private video.
 *
 * A presigned URL is the whole access-control story when there is no CloudFront
 * key group to trust. The URL carries its own expiry and signature, so S3 can
 * be handed straight to the viewer's player without the bucket ever being
 * public.
 */

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';

/**
 * RFC 3986 encoding over UTF-8 bytes. `encodeURIComponent` leaves !'()* alone
 * and AWS does not, so a key containing any of them would sign differently
 * from the URL actually requested.
 */
export function uriEncode(input, encodeSlash = true) {
  let out = '';
  for (const byte of Buffer.from(String(input), 'utf8')) {
    const char = String.fromCharCode(byte);
    const unreserved =
      (byte >= 0x41 && byte <= 0x5a) || // A-Z
      (byte >= 0x61 && byte <= 0x7a) || // a-z
      (byte >= 0x30 && byte <= 0x39) || // 0-9
      char === '-' ||
      char === '_' ||
      char === '.' ||
      char === '~';

    if (unreserved) out += char;
    else if (char === '/' && !encodeSlash) out += '/';
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

function hmac(key, value) {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** The four-step derivation that scopes a key to one day, region and service. */
function signingKey(secretAccessKey, dateStamp, region) {
  const date = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regional = hmac(date, region);
  const service = hmac(regional, SERVICE);
  return hmac(service, 'aws4_request');
}

/** `20260922T134501Z` and `20260922`, the two forms the signature needs. */
function timestamps(now) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/**
 * Credentials as Lambda exposes them. The session token matters: temporary
 * credentials are rejected unless it rides along in the query string.
 */
export function credentialsFromEnv(env = process.env) {
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('No AWS credentials in the environment');
  }
  return { accessKeyId, secretAccessKey, sessionToken: env.AWS_SESSION_TOKEN };
}

/**
 * Builds a presigned `GET` URL for one object.
 *
 * `expiresIn` is capped by AWS at 7 days, and in practice is also capped by the
 * lifetime of the Lambda's temporary credentials — a URL outlives neither.
 */
export function presignGetObject({
  bucket,
  key,
  region,
  credentials,
  expiresIn = 3600,
  now = new Date(),
  // Overridable so the AWS reference vectors, which use the legacy
  // region-less endpoint, can be checked byte for byte.
  host = `${bucket}.s3.${region}.amazonaws.com`,
}) {
  const { accessKeyId, secretAccessKey, sessionToken } = credentials;
  const { amzDate, dateStamp } = timestamps(now);
  const canonicalUri = `/${uriEncode(key, false)}`;
  const scope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;

  const query = {
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-SignedHeaders': 'host',
  };
  if (sessionToken) query['X-Amz-Security-Token'] = sessionToken;

  // The canonical query string must be sorted by encoded key, byte-wise.
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((name) => `${uriEncode(name)}=${uriEncode(query[name])}`)
    .join('&');

  const canonicalRequest = [
    'GET',
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`,
    'host',
    // S3 accepts this sentinel in place of a body hash for presigned GETs.
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signingKey(secretAccessKey, dateStamp, region))
    .update(stringToSign, 'utf8')
    .digest('hex');

  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
