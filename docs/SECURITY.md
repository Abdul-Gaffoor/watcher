# Security notes

What the MVP does, and what to change before it takes real public traffic.

## What is already solid

- **Buckets are never public.** Both have all four public-access blocks on and
  are reachable only through CloudFront's Origin Access Control, restricted by
  `AWS:SourceArn` to this one distribution.
- **Media is gated at the edge.** `/media/*` requires valid CloudFront signed
  cookies. The policy is scoped to the media path with an explicit expiry, not
  to the whole distribution.
- **Passwords are never stored.** Only scrypt hashes (N=16384, r=8, p=1) with a
  per-password random salt, compared in constant time.
- **Sign-in does not leak which field was wrong.** An unknown username still
  runs a scrypt verification against a dummy hash, so timing and the error
  message are the same as a wrong password.
- **Cookies are `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`.** No token is
  reachable from JavaScript, so XSS cannot exfiltrate a session.
- **Auth responses are `no-store`.** They can never be cached by CloudFront or
  the browser.
- **JWTs are verified properly.** Signature compared in constant time, expiry
  required and enforced; a token with no `exp` is rejected.
- **Security headers** (HSTS, `X-Content-Type-Options`, `X-Frame-Options: DENY`,
  `Referrer-Policy`) are applied by a response headers policy on every
  behaviour.

## Known gaps to close before public launch

1. **Secrets live in Lambda environment variables.** The signing private key,
   the session secret and the user roster are all readable by anyone with
   `lambda:GetFunctionConfiguration`. Move them to Secrets Manager or SSM
   SecureString and fetch on cold start.

2. **The Lambda Function URL is `AuthType: NONE`.** It is reachable directly,
   bypassing CloudFront. Either attach an OAC to the Lambda origin and set
   `AuthType: AWS_IAM`, or verify a shared secret header that only CloudFront
   adds via an origin custom header.

3. **Rate limiting is per-container and in-memory.** It slows down a single
   attacker but resets on scale-out. Put AWS WAF in front of the distribution
   with a rate-based rule on `/api/login`.

4. **No account lockout, MFA, or password rotation.** The roster is a JSON blob
   redeployed by hand. Move to Cognito (or a user table) once there are more
   than a handful of viewers.

5. **Signed cookies are bearer credentials.** Anyone who copies them out of a
   signed-in browser can fetch segments until they expire. The 1-hour TTL limits
   the window; shorten `MediaTtlSeconds` if that matters. Genuine anti-piracy
   needs DRM, which is out of scope here.

6. **No access logging.** Enable CloudFront standard logs to an S3 bucket, or
   real-time logs to Kinesis, before you need to investigate anything.

7. **No CSP.** Add a `Content-Security-Policy` to the response headers policy
   once the asset origins are settled (`script-src 'self'`, `media-src 'self'`).

8. **Buckets are `DeletionPolicy: Retain`.** Deleting the stack leaves them
   behind — deliberate, so a stack mistake cannot destroy your content library,
   but it does mean manual cleanup.

## Handling the signing key

The private key in `.secrets/cloudfront-private.pem` mints media access for
anyone who holds it. It is gitignored, created `chmod 600`, and
`generate-signing-key.sh` refuses to overwrite an existing one.

To rotate: generate a new pair, add the new public key to the key group
(CloudFront accepts several), deploy the Lambda with the new private key, then
remove the old public key once the longest cookie lifetime has passed.
