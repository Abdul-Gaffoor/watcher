import { createHash, createHmac } from 'node:crypto';

/**
 * Minimal AWS Signature Version 4: query-string presigning for S3, and
 * Authorization-header signing for the JSON APIs.
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

/** Lowercase name, trimmed value, sorted — the canonical header form. */
function canonicalizeHeaders(headers) {
  const entries = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), String(value).trim().replace(/\s+/g, ' ')])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return {
    canonical: entries.map(([name, value]) => `${name}:${value}`).join('\n'),
    signed: entries.map(([name]) => name).join(';'),
  };
}

/** The four-step derivation that scopes a key to one day, region and service. */
function signingKey(secretAccessKey, dateStamp, region, service = SERVICE) {
  const date = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regional = hmac(date, region);
  const scoped = hmac(regional, service);
  return hmac(scoped, 'aws4_request');
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
 * Builds a presigned S3 URL for any single request.
 *
 * Generalised beyond GET because the admin path hands the browser URLs for the
 * whole multipart upload exchange: start, each part, and finish. The Lambda
 * only ever signs; the bytes go browser to S3 directly, which is the only way
 * a gigabyte of video can move without a proxy in the middle.
 *
 * `extraQuery` carries the S3 sub-resources that select the operation, such as
 * `uploads` to begin or `partNumber` and `uploadId` for one part. They are
 * signed along with everything else, so a URL can only do the one thing it
 * was minted for, to the one key it names.
 *
 * `expiresIn` is capped by AWS at 7 days, and in practice is also capped by the
 * lifetime of the Lambda's temporary credentials — a URL outlives neither.
 */
export function presignS3({
  method = 'GET',
  bucket,
  key,
  region,
  credentials,
  extraQuery = {},
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
    ...extraQuery,
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
    .map((name) => `${uriEncode(name)}=${uriEncode(String(query[name]))}`)
    .join('&');

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`,
    'host',
    // S3 accepts this sentinel in place of a body hash for presigned requests,
    // which is what lets the browser stream a part it has not hashed.
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signingKey(secretAccessKey, dateStamp, region))
    .update(stringToSign, 'utf8')
    .digest('hex');

  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/** The read case, which is most of the traffic and reads better named. */
export function presignGetObject(options) {
  return presignS3({ ...options, method: 'GET' });
}

/**
 * Signs a request with an Authorization header, which is what the JSON APIs
 * take — Secrets Manager has no presigned form, so the roster fetch cannot
 * reuse presignS3.
 *
 * Unlike the S3 presigner this hashes the body: a JSON API signs its payload,
 * and UNSIGNED-PAYLOAD is an S3 concession to streaming uploads that nothing
 * here needs.
 *
 * Returns the headers to send. The caller owns the fetch, so this stays
 * testable without a network.
 */
export function signRequest({
  method = 'POST',
  host,
  path = '/',
  region,
  service,
  credentials,
  headers = {},
  body = '',
  now = new Date(),
}) {
  const { accessKeyId, secretAccessKey, sessionToken } = credentials;
  const { amzDate, dateStamp } = timestamps(now);
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const payloadHash = sha256Hex(body);

  const allHeaders = {
    ...headers,
    host,
    'x-amz-date': amzDate,
    // Signed rather than merely sent: temporary credentials are rejected when
    // the token is not covered by the signature.
    ...(sessionToken ? { 'x-amz-security-token': sessionToken } : {}),
  };

  const { canonical, signed } = canonicalizeHeaders(allHeaders);

  const canonicalRequest = [method, path, '', `${canonical}\n`, signed, payloadHash].join('\n');
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signingKey(secretAccessKey, dateStamp, region, service))
    .update(stringToSign, 'utf8')
    .digest('hex');

  return {
    ...allHeaders,
    authorization: `${ALGORITHM} Credential=${accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
  };
}
