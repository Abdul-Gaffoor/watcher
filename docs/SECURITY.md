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

4. **No account lockout, MFA, or password rotation — on the roster path.**
   `auth_provider = "cognito"` closes this one. A user pool brings required MFA,
   lockout that survives scale-out, a password policy, and self-service reset,
   and it takes password material out of this repository entirely: Terraform
   declares who may sign in, and Cognito emails each invitee a temporary
   password. The roster remains only because the local dev server and the
   end-to-end suite must work with no AWS account. Gaps 1 and 3 shrink to
   nothing on the Cognito path, since there is no roster in the Lambda's
   environment and lockout is no longer per-container.

5. **Presigned URLs are bearer credentials, and they live in a URL.** This
   applies only to `edge = "apigateway"`. A signed cookie is `HttpOnly` and
   unreachable from JavaScript; a presigned URL is a plain link, so it can leak
   through a referrer header, a proxy log, or a shared address bar. The
   `media_ttl_seconds` window bounds it, and the URL can never grant more than
   the edge Lambda's role, which is `s3:GetObject` on two buckets and nothing
   else. Shorten the TTL if that matters. The CloudFront path does not have
   this property and is the better one to be on.

6. **Signed cookies are bearer credentials.** Anyone who copies them out of a
   signed-in browser can fetch segments until they expire. The 1-hour TTL limits
   the window; shorten `MediaTtlSeconds` if that matters. Genuine anti-piracy
   needs DRM, which is out of scope here.

7. **No access logging.** Enable CloudFront standard logs to an S3 bucket, or
   real-time logs to Kinesis, before you need to investigate anything.

8. **No CSP.** Add a `Content-Security-Policy` to the response headers policy
   once the asset origins are settled (`script-src 'self'`, `media-src 'self'`).

9. **GitHub Actions holds long-lived AWS keys.** `AWS_ACCESS_KEY` and
   `AWS_SECRET_KEY` are static credentials in repository secrets. They do not
   expire on their own, they are as powerful as the IAM user behind them, and
   anyone who can push a workflow change to `master` can use them. The stack
   still creates the GitHub OIDC provider and a narrow deploy role, which issue
   short-lived credentials and need nothing stored. Switching back is a change
   to `deploy.yml` alone. Until then: give that IAM user only the permissions
   the apply needs, and rotate the key pair on a schedule.

10. **Buckets carry `prevent_destroy`.** `terraform destroy` refuses to take
   them — deliberate, so a mistake cannot delete your content library, but it
   does mean removing the lifecycle block if you genuinely want them gone.

## What Cognito is and is not doing

On `auth_provider = "cognito"` the Lambda never sees a stored password. It
forwards the submitted credentials to Cognito, which decides, and then issues
its own session cookie from the result.

Two details worth knowing:

- **Tokens are not signature-verified.** They arrive in the body of a TLS
  response from Cognito, in the same request that asked for them, so there is no
  third party to distrust and no JWKS to fetch. A token read from a client would
  need verifying; one read from the response to your own `InitiateAuth` does not.
- **The challenge token is a bearer credential.** Between the password step and
  the code step, the browser holds a short-lived JWT signed with the session
  secret, carrying Cognito's session. Signing it stops a viewer rewriting which
  account they are half-way through authenticating as. It expires in 15 minutes,
  and it is useless without also passing the second factor.
- **The app client has no secret.** Every Cognito call the Lambda makes is one a
  signed-out user may make, so a secret would be one more thing to store for no
  gain. What bounds the danger is the pool policy, not the client id.

## Handling the signing key

Terraform generates the RSA signing key and holds it in the state file, in
plaintext. Anyone who can read that object can mint media access, so the state
is a secret in its own right. It now lives in
`s3://terraform-state-132848804230/watcher/terraform.tfstate`, written with
`encrypt = true`. That bucket must have all four public-access blocks on, and
should have versioning enabled so a truncated write is recoverable. Read access
to it is equivalent to read access to the signing key, so scope it as tightly
as the buckets themselves.

To bring your own key instead, set `signing_private_key_pem`.

To rotate:

```bash
terraform apply -replace='tls_private_key.signing[0]'
```

`aws_cloudfront_public_key` is `create_before_destroy`, so the replacement joins
the key group before the old key leaves it. Viewers holding cookies signed by
the old key lose media access when it goes — within `media_ttl_seconds` they
would have refreshed anyway.
