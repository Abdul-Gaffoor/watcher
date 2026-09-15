# deploy-aws

Terraform for the whole Watcher stack: GitHub OIDC, the two private S3 buckets,
CloudFront, the auth Lambda, and the signing key that gates `/media/*`.

This is the only definition of the infrastructure — there is no CloudFormation
equivalent to keep in sync.

---

## What gets created

| Area | Resources |
| --- | --- |
| **GitHub OIDC** | OIDC provider, deploy role (narrow) |
| **Storage** | App bucket + media bucket — private, encrypted, OAC-only |
| **CDN** | Distribution, OAC, SPA-router function, response headers policy |
| **Domain** | ACM certificate (us-east-1), its validation record, A + AAAA aliases |
| **Access** | RSA signing key pair, CloudFront public key, trusted key group |
| **API** | Auth Lambda (arm64, nodejs22), Function URL, log group, IAM role |
| **Secrets** | Generated session secret and signing key |

### What the split of roles and buckets is actually for

**Two IAM roles get created**, and only one of them has anything to do with CI:

| Role | Purpose |
| --- | --- |
| `watcher-api` | The Lambda's **execution role**. Every Lambda needs one — it is what lets the function write its own logs. Not a CI role. |
| `watcher-github-actions-deploy` | The **OIDC role** GitHub Actions assumes. Can write the two buckets and invalidate this one distribution. Nothing else. |

**Two S3 buckets.** To be clear about what this is *not*: it is not the security
boundary. The gate is the trusted key group on the `/media/*` cache behaviour,
and that works the same whether the objects sit in one bucket or two. The split
buys three operational things:

1. **Blast radius.** Publishing the SPA runs `aws s3 sync --delete`. Sharing a
   bucket with the video library means one bad prefix away from deleting it.
2. **Versioning where it pays.** The app bucket is versioned so a bad frontend
   deploy can be rolled back. Versioning a video library doubles its storage
   bill for no benefit — re-encodes get new paths anyway.
3. **Room to scope writers later.** An upload/transcode pipeline can be given
   the media bucket without also handing it your app.

Buckets themselves are free; you pay for storage and requests either way. If you
would still rather have one, it is a small change — say so.

**Terraform owns the Lambda's code** (zipped from `backend/src` by
`archive_file`), so a backend change ships with your local `terraform apply`,
not through GitHub Actions. That keeps one owner for the function instead of a
CI push and the next apply fighting over it.

---

## First deploy

### 1. Configure

```bash
cp terraform.tfvars.example terraform.tfvars
node ../scripts/hash-password.mjs      # once per viewer; paste the hash in
```

Fill in `github_owner` and `github_repo` at minimum. `terraform.tfvars` is
gitignored — it holds password hashes.

The example is already pointed at this project: the `watcher.moderndayjourney.me`
domain, its hosted zone, and the `abdul.cloud0two` profile. `aws_profile` is
what makes `terraform apply` pick up the right credentials from
`~/.aws/config`; clear it to fall back to environment variables or SSO.

Check that the profile resolves before applying:

```bash
aws sts get-caller-identity --profile abdul.cloud0two
```

### 2. Apply

```bash
terraform init
terraform plan
terraform apply
```

CloudFront takes 10–15 minutes to reach `Deployed` on first creation, and the
certificate has to be issued before the distribution is even created, so the
first apply is mostly waiting. The order is forced by the dependencies:

```
certificate requested -> validation record written -> ACM issues (a minute or two)
  -> distribution created (10-15 min) -> A/AAAA aliases point at it
```

DNS then needs to propagate, which the 60-second record TTL keeps short.

`terraform init` writes `.terraform.lock.hcl` — **commit it**. It is not in the
repo yet because a lock file is platform-specific, and the one generated here
would have been wrong for anyone on macOS or Windows. To cover a mixed team:

```bash
terraform providers lock \
  -platform=linux_amd64 -platform=darwin_arm64 -platform=windows_amd64
```

### 3. Wire up GitHub

```bash
terraform output
```

Set these as **repository variables** (Settings → Secrets and variables →
Actions → Variables):

| Variable | From output |
| --- | --- |
| `AWS_REGION` | your `aws_region` |
| `AWS_DEPLOY_ROLE_ARN` | `github_actions_deploy_role_arn` |
| `APP_BUCKET_NAME` | `app_bucket_name` |
| `MEDIA_BUCKET_NAME` | `media_bucket_name` |
| `CLOUDFRONT_DISTRIBUTION_ID` | `distribution_id` |
| `APP_URL` | `app_url` |

No secrets are needed: OIDC replaces stored AWS keys entirely.

### 4. Upload content

```bash
cd ..
./scripts/upload-content.sh      # or push to master and let deploy.yml run
```

---

## Why the OIDC trust policy looks like that

Two conditions, and both matter:

```json
"StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
"StringLike":   { "token.actions.githubusercontent.com:sub": ["repo:OWNER/REPO:ref:refs/heads/master"] }
```

Drop the `sub` condition and **any GitHub repository in the world** can assume
the role — this is the classic OIDC misconfiguration. Drop `aud` and a token
minted for a different audience is accepted.

**Adding an approval gate is a two-sided change.** A GitHub Environment can
require a manual approval, which is stronger than a branch condition — but the
moment a job declares `environment: production`, GitHub changes the token's
`sub` from `repo:OWNER/REPO:ref:refs/heads/master` to
`repo:OWNER/REPO:environment:production`. So you must do both:

1. add `environment: production` to the job in `.github/workflows/deploy.yml`, and
2. add `github_environments = ["production"]` to `terraform.tfvars` and apply.

Do one without the other and the assume-role step fails with
`Not authorized to perform sts:AssumeRoleWithWebIdentity`.

Check what you actually allowed:

```bash
terraform output github_allowed_subjects
```

---

## The media policy resource

`terraform output media_policy_resource` shows what the signed-cookie policy is
scoped to. With `domain_name` set it is the exact host:

```
https://watcher.moderndayjourney.me/media/*
```

**So media plays on the custom domain and nowhere else.** The
`*.cloudfront.net` address still serves the app and still signs you in, but
every segment request comes back 403, because the cookie's policy names a
different host. That is the intended trade for one canonical address. If you
need both to work, either drop `domain_name` or widen the policy by hand.

Without a custom domain the resource falls back to `https://*/media/*`, because
the distribution's generated hostname cannot be fed back into the Lambda's
environment without a dependency cycle:

```
lambda (env needs domain) -> distribution (needs function URL) -> function URL (needs lambda)
```

That wildcard is on the **host**, never the path, and it costs nothing in
practice: the signature is verified against our public key, that key lives only
in our key group, and that key group is attached only to this distribution — so
a cookie we signed is useless anywhere else. See `locals.tf` for the full
reasoning.

---

## Rotating the signing key

```bash
terraform apply -replace='tls_private_key.signing[0]'
```

`aws_cloudfront_public_key` is `create_before_destroy`, so the new key is added
to the key group before the old one goes. Viewers holding cookies signed by the
old key lose media access when it is removed — within `media_ttl_seconds` they
would have refreshed anyway.

---

## State lives on your laptop

`terraform.tfstate` sits next to these files, gitignored. It contains the
CloudFront **signing private key** and the **session secret** in plaintext —
anyone holding that key can mint media access — so:

- Back it up somewhere private. Losing it means losing the ability to manage or
  cleanly destroy the stack.
- Never commit it. `.gitignore` covers `*.tfstate*`, but check before you
  `git add -A` in this directory.

If a second machine or another person ever needs to apply, that is the point to
add a `backend "s3"` block to `versions.tf` and migrate — not before.

## Notes and gotchas

- **`prevent_destroy` is set on both buckets.** That is deliberate:
  `terraform destroy` should not be able to take the content library with it.
  Remove the lifecycle block if you genuinely want them gone.
- **The OIDC provider is a singleton per account.** If another stack already
  created `token.actions.githubusercontent.com`, set
  `create_oidc_provider = false` and this configuration looks it up instead.
- **A custom domain needs a us-east-1 certificate.** CloudFront accepts ACM
  certificates only from that region, whatever `aws_region` is set to, which is
  why `providers.tf` carries an `aws.us_east_1` alias used for the certificate
  alone. Terraform requests and validates it when `route53_zone_id` is set; pass
  `acm_certificate_arn` instead when DNS lives elsewhere. A `precondition`
  catches a domain with neither at plan time.
- **The hosted zone must be authoritative for the domain.** A second
  `precondition` compares `domain_name` against the zone's own name, so a
  mismatched zone id fails at plan rather than hanging on validation.
- **The Lambda Function URL is `AuthType: NONE`** and reachable directly. The
  handler authenticates every request, but see `../docs/SECURITY.md` for how to
  put it behind CloudFront only.
