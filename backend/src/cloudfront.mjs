import { createSign } from 'node:crypto';

/**
 * CloudFront signed cookies, implemented directly against node:crypto so the
 * Lambda ships with no dependencies at all (smaller bundle, faster cold start).
 *
 * CloudFront uses a non-standard base64 alphabet for policy and signature
 * values: `+` -> `-`, `=` -> `_`, `/` -> `~`.
 */
function cloudfrontBase64(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/=/g, '_').replace(/\//g, '~');
}

/**
 * Builds a custom policy so the cookies are scoped to the media path only —
 * never the whole distribution.
 */
export function createSignedCookies({ resource, expiresAt, keyPairId, privateKey }) {
  const policy = JSON.stringify({
    Statement: [
      {
        Resource: resource,
        Condition: { DateLessThan: { 'AWS:EpochTime': expiresAt } },
      },
    ],
  });

  const signature = createSign('RSA-SHA1').update(policy).sign(privateKey);

  return {
    'CloudFront-Policy': cloudfrontBase64(Buffer.from(policy)),
    'CloudFront-Signature': cloudfrontBase64(signature),
    'CloudFront-Key-Pair-Id': keyPairId,
  };
}
