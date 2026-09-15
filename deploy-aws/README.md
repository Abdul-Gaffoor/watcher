# deploy-aws

Terraform for the whole Watcher stack: GitHub OIDC, the two private S3 buckets,
CloudFront, the auth Lambda, and the signing key that gates `/media/*`.

> **One IaC definition, please.** The repo also carries
> `infra/cloudformation/watcher-stack.yaml` from the first pass. These two
> describe the same infrastructure — running both against one account will
> fight over the same resources. Pick this one and delete the CloudFormation
> template (or vice versa) before anyone deploys.

---

## What gets created

| Area | Resources |
| --- | --- |
| **GitHub OIDC** | OIDC provider, deploy role (narrow), optional Terraform role |
| **Storage** | App bucket + media bucket — private, encrypted, OAC-only |
| **CDN** | Distribution, OAC, SPA-router function, response headers policy |
| **Access** | RSA signing key pair, CloudFront public key, trusted key group |
| **API** | Auth Lambda (arm64, nodejs22), Function URL, log group, IAM role |
| **Secrets** | Generated session secret and signing key |

### Two roles, on purpose

**`watcher-github-actions-deploy`** — what `deploy.yml` uses. It can write to
the two buckets and invalidate this one distribution. Nothing else. This is the
role that runs on every content change, so it is the one that should stay dull.

**`watcher-github-actions-terraform`** — off by default
(`create_terraform_role = false`). It manages the whole stack, IAM included, so
it is administrative. Turn it on only once `github_environments` pins it to an
environment with required reviewers.

Terraform owns the Lambda's code (zipped from `backend/src` by `archive_file`),
so a backend change ships through `terraform.yml`, not `deploy.yml`. That keeps
one owner for the function and avoids drift where a CI code-push gets reverted
by the next apply.

---

## First deploy

### 1. Remote state (recommended, do it once)

State holds the signing private key and the session secret, so it should not
live on a laptop.

```bash
cd deploy-aws/bootstrap
terraform init && terraform apply
terraform output backend_block     # paste into ../versions.tf
cd .. && terraform init -migrate-state
```

### 2. Configure

```bash
cp terraform.tfvars.example terraform.tfvars
node ../scripts/hash-password.mjs      # once per viewer; paste the hash in
```

Fill in `github_owner` and `github_repo` at minimum. `terraform.tfvars` is
gitignored — it holds password hashes.

### 3. Apply

```bash
terraform init
terraform plan
terraform apply
```

CloudFront takes 10–15 minutes to reach `Deployed` on first creation.

`terraform init` writes `.terraform.lock.hcl` — **commit it**. It is not in the
repo yet because a lock file is platform-specific, and the one generated here
would have been wrong for anyone on macOS or Windows. To cover a mixed team:

```bash
terraform providers lock \
  -platform=linux_amd64 -platform=darwin_arm64 -platform=windows_amd64
```

### 4. Wire up GitHub

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
| `AWS_TERRAFORM_ROLE_ARN` | `github_actions_terraform_role_arn` (only if enabled) |

If you enable `terraform.yml`, also add a **secret** named `TF_VAR_USERS`
holding the roster as JSON (note `password_hash`, snake_case, matching the
variable):

```json
[{"username":"alex","name":"Alex","roles":["viewer"],"password_hash":"scrypt$..."}]
```

### 5. Upload content

```bash
cd ..
./scripts/upload-content.sh      # or just push to main and let deploy.yml run
```

---

## Why the OIDC trust policy looks like that

Two conditions, and both matter:

```json
"StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
"StringLike":   { "token.actions.githubusercontent.com:sub": ["repo:OWNER/REPO:ref:refs/heads/main"] }
```

Drop the `sub` condition and **any GitHub repository in the world** can assume
the role — this is the classic OIDC misconfiguration. Drop `aud` and a token
minted for a different audience is accepted.

Prefer `github_environments` over `github_branches` for production: a GitHub
Environment can require a manual approval, so the role is unreachable until a
human clicks. A branch condition only proves which branch the workflow ran on.

Check what you actually allowed:

```bash
terraform output github_allowed_subjects
```

---

## The media policy resource

`terraform output media_policy_resource` shows what the signed-cookie policy is
scoped to. Without a custom domain it is `https://*/media/*`, because the
distribution's generated hostname cannot be fed back into the Lambda's
environment without a dependency cycle:

```
lambda (env needs domain) -> distribution (needs function URL) -> function URL (needs lambda)
```

The wildcard is on the **host**, never the path. It costs nothing in practice:
the signature is verified against our public key, that key lives only in our key
group, and that key group is attached only to this distribution — so a cookie we
signed is useless anywhere else. Set `domain_name` and the policy names one host
again. See `locals.tf` for the full reasoning.

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

## Notes and gotchas

- **`prevent_destroy` is set on both buckets** and on the state bucket. That is
  deliberate: `terraform destroy` should not be able to take the content library
  with it. Remove the lifecycle block if you genuinely want them gone.
- **The OIDC provider is a singleton per account.** If another stack already
  created `token.actions.githubusercontent.com`, set
  `create_oidc_provider = false` and this configuration looks it up instead.
- **A custom domain needs a us-east-1 certificate.** CloudFront accepts ACM
  certificates only from that region, whatever `aws_region` is set to. There is
  a `precondition` that catches a missing certificate at plan time.
- **`create_terraform_role` attaches `AdministratorAccess`.** PowerUser cannot
  manage IAM, which this stack needs. Narrow it once the resource set settles.
- **The Lambda Function URL is `AuthType: NONE`** and reachable directly. The
  handler authenticates every request, but see `../docs/SECURITY.md` for how to
  put it behind CloudFront only.
