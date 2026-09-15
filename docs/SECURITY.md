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

8. **Buckets carry `prevent_destroy`.** `terraform destroy` refuses to take
   them — deliberate, so a mistake cannot delete your content library, but it
   does mean removing the lifecycle block if you genuinely want them gone.

## Handling the signing key

Terraform generates the RSA signing key and holds it in state — which is why
`deploy-aws/bootstrap/` exists: state belongs in an encrypted, versioned,
private bucket, not on a laptop. Anyone holding that key can mint media access.
To bring your own instead, set `signing_private_key_pem`.

To rotate:

```bash
terraform apply -replace='tls_private_key.signing[0]'
```

`aws_cloudfront_public_key` is `create_before_destroy`, so the replacement joins
the key group before the old key leaves it. Viewers holding cookies signed by
the old key lose media access when it goes — within `media_ttl_seconds` they
would have refreshed anyway.
