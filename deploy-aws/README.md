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
terraform fmt -check -recursive && terraform validate
terraform plan
terraform apply
```

GitHub Actions applies the same stack from the same state, so a laptop apply
and a pushed apply are interchangeable. `.github/workflows/deploy.yml` runs
`fmt -check`, `init`, `validate` and `apply` against `ci.tfvars`, then publishes
the app into the buckets that apply produced. Running `plan` locally before
pushing is still the cheapest way to see what a push will do.

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

Two repository **secrets**, under Settings, then Secrets and variables, then
Actions:

| Secret | What it holds |
| --- | --- |
| `AWS_ACCESS_KEY` | Access key id for the IAM user Actions applies as |
| `AWS_SECRET_KEY` | Its secret access key |

No repository **variables** are needed. Everything the app job used to read
from them now comes from the Terraform outputs of the apply that ran seconds
earlier, in the same workflow.

### Where the inputs come from

Three files feed the apply, and Terraform layers them in this order, each
overriding the last:

| Source | Carries | Loaded |
| --- | --- | --- |
| `terraform.tfvars` | The viewer roster, and your local `aws_profile` | Automatically, always |
| `ci.tfvars` | The same settings with `aws_profile = null` | Only by the workflow's `-var-file` |
| `TF_VAR_users` | An alternative roster | Only if `terraform.tfvars` does not set `users` |

`terraform.tfvars` is tracked, which is why the workflow needs no roster secret
and why **this repository must stay private**: the file holds scrypt password
hashes. A runner has no `~/.aws/config`, so `ci.tfvars` overrides `aws_profile`
to null and credentials come from the environment instead.

To make the repository public again, remove `!terraform.tfvars` from
`.gitignore` and put the roster in a `TF_VAR_USERS` secret. Terraform parses a
`TF_VAR_` value for a complex type as HCL, so it is a list of objects on one
line:

```hcl
[{ username = "alex", name = "Alex", roles = ["viewer"], password_hash = "scrypt$16384$8$1$...$..." }]
```

`name` and `roles` are optional, defaulting to the username and `["viewer"]`.
Generate each hash with `node scripts/hash-password.mjs`.

### 4. Upload content

```bash
cd ..
./scripts/upload-content.sh      # or push to master and let deploy.yml run
```

---

## Two directories, one variable

`auth_provider` decides where viewer credentials live.

| | `roster` | `cognito` |
| --- | --- | --- |
| Store | scrypt hashes in the Lambda's environment | managed user pool |
| MFA | none | required, authenticator app |
| Lockout | per-container, resets on scale-out | enforced by the pool |
| Password reset | regenerate a hash and redeploy | self-service by email |
| Secrets in git or state | a hash per viewer | none |
| Adding a viewer | edit, apply, tell them the password | edit, apply, Cognito emails the invitation |

`cognito` is the one to be on. `roster` remains because the local dev server and
the end-to-end suite have to work with no AWS account at all.

### Switching to Cognito

Two edits in `terraform.tfvars`, then apply:

```hcl
auth_provider = "cognito"

users = [
  { username = "Abdul", name = "Abdul", email = "you@example.com" },
]
```

The email must be real: it receives the invitation, and later any password
reset. Drop `password_hash`, which Terraform will reject on this path rather
than leave a secret sitting there with nothing reading it.

What happens on the next apply: the pool is created, each viewer is invited, and
**the old password stops working**. Your first sign-in then walks three steps,
because Terraform can declare an account but cannot enrol a phone for it.

1. Sign in with the username and the temporary password from the email.
2. Choose a real password. Minimum 12 characters, mixed case, a digit, a symbol.
3. Enrol an authenticator app, either from the enrolment link or by typing the
   setup key, and confirm with a six-digit code.

After that it is username, password, code. To add a viewer later, add them to
`users` and apply; they get the same three steps.

### Getting back in if you are locked out

The pool is yours, so nothing here is unrecoverable:

```bash
# Forgotten password, when email works: use the reset link on the sign-in page.
# Lost the authenticator app:
aws cognito-idp admin-set-user-mfa-preference \
  --user-pool-id "$(terraform output -raw cognito_user_pool_id)" \
  --username Abdul --software-token-mfa-settings Enabled=false
```

That clears the enrolled factor, so the next sign-in offers setup again.

---

## Two front ends, one variable

`edge` decides what sits in front of the app. Everything else in the stack is
shared: the same domain, the same certificate, the same buckets, the same auth
Lambda.

| | `cloudfront` | `apigateway` |
| --- | --- | --- |
| Front end | One distribution | One HTTP API, regional |
| Media gate | Trusted key group, at the edge | Session checked in a Lambda, then a presigned S3 URL |
| Caching | Edge cache, shared between viewers | None |
| SPA routing | CloudFront Function | The edge Lambda |
| IPv6 | Yes | No, so no AAAA record is published |
| Cost shape | Requests plus egress | An invocation per asset and per segment |

`cloudfront` is the design. `apigateway` exists because AWS gates
`CreateDistribution` on an account it has not verified, and that gate has no
workaround from this side. Switching is one line in `terraform.tfvars` and one
apply. The CloudFront function, origin access control, key group and signing
key are all free and stay created in both modes, so going back creates only the
distribution itself.

### What the fallback costs

Every request is served from one region with no cache in front of it. For the
app shell that is a few hundred milliseconds; for video it means the origin
pays for every segment of every viewing. Do not leave a real audience on it.

### Adding a viewer behind either front end

Unchanged: edit `users` in `terraform.tfvars` and apply. The auth Lambda is the
same code in both modes. It simply stops issuing CloudFront cookies when there
is no key group to sign for.

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

## State lives in S3

`versions.tf` points at `s3://terraform-state-132848804230/watcher/terraform.tfstate`.
Shared state is what lets a laptop and a workflow apply the same stack instead
of each building its own copy of everything.

Locking is S3-native, via `use_lockfile`. A concurrent apply takes a `.tflock`
object beside the state and the second one waits. This replaces the DynamoDB
table older setups needed, and is why `required_version` is at least 1.10.

The state contains the CloudFront **signing private key** and the **session
secret** in plaintext. Anyone who can read that object can mint media access,
so the bucket must block public access, and versioning on it is what saves you
from a corrupted or truncated write.

### Moving an existing local state into S3

If you already applied from a laptop, that state is the real record of what
exists. Adding the backend block does not move it. Run this once, in
`deploy-aws`, from the machine that holds it:

```bash
terraform init -migrate-state
```

Terraform sees the local file and the new backend, and offers to copy one into
the other. Answer yes. Skipping this means the workflow starts from empty
state, tries to create resources that already exist, and fails on names that
are already taken.

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
- **Two workflows, different jobs.** `ci.yml` tests and builds the app on every
  push and pull request. `deploy.yml` applies this directory and then publishes
  the app, on pushes to `master` and on manual dispatch.
- **The OIDC role is currently unused.** Actions authenticates with the static
  keys in `AWS_ACCESS_KEY` and `AWS_SECRET_KEY`, so `watcher-github-actions-deploy`
  and the OIDC provider are still created but nothing assumes them. They are
  left in place because switching back to OIDC is then a workflow-only change.
- **The Lambda Function URL is `AuthType: NONE`** and reachable directly. The
  handler authenticates every request, but see `../docs/SECURITY.md` for how to
  put it behind CloudFront only.
