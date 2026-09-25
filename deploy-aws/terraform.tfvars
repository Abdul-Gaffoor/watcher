# Copy to terraform.tfvars and fill in. terraform.tfvars is gitignored — it
# holds password hashes.

project_name = "watcher"
aws_region   = "us-east-1"

# Named profile to apply with. Comment out in CI, where the OIDC role provides
# credentials through the environment.
aws_profile = "abdul.cloud0two"

# --- GitHub OIDC -------------------------------------------------------------
github_owner = "Abdul-Gaffoor"
github_repo  = "watcher"

# Branches allowed to assume the deploy role. This is what deploy.yml uses.
github_branches = ["master"]

# Approval gating is a TWO-SIDED change. Declaring `environment: production` in
# the workflow switches the OIDC subject from `...:ref:refs/heads/master` to
# `...:environment:production`, so uncommenting this WITHOUT also adding
# `environment: production` to .github/workflows/deploy.yml (or vice versa)
# breaks the assume-role step.
# github_environments = ["production"]

# Set false if this AWS account already has a GitHub OIDC provider.
create_oidc_provider = true

# --- Identity ----------------------------------------------------------------
# "roster"  the scrypt list below, which is what is deployed today
# "cognito" a managed user pool: required MFA, lockout, password policy,
#           self-service reset, and no password material in this file at all
#
# Switching is two edits: set this to "cognito", and replace the users list with
# the commented-out shape below. Your current password stops working at that
# point; Cognito emails you a temporary one instead.
auth_provider = "roster"

# --- Viewers -----------------------------------------------------------------
# With auth_provider = "cognito", this is all a viewer needs. No secret, because
# Cognito generates the temporary password and emails the invitation:
#
# users = [
#   {
#     username = "Abdul"
#     name     = "Abdul"
#     email    = "you@example.com"   # must be real; it receives the invitation
#   },
# ]
#
# With auth_provider = "roster", generate each hash with:
#   node scripts/hash-password.mjs
users = [
  {
    username = "Abdul"
    name     = "Abdul"
    # "admin" is what opens the dashboard. It is checked on the server, in the
    # session, not merely hidden in the interface.
    roles         = ["viewer", "admin"]
    password_hash = "scrypt$16384$8$1$QJR67RN7ikhYjGzEL4WAew==$sEhT7xe4ZakJWyGyKb10DTckFVLkKpQE7Ii9QnuxReA="
  },
]

# --- CloudFront --------------------------------------------------------------
# PriceClass_All gives the lowest latency worldwide, at a higher cost.
price_class = "PriceClass_100"

# Custom domain. With route53_zone_id set, Terraform requests the ACM
# certificate, writes the DNS validation records, waits for issuance, and points
# A and AAAA alias records at the distribution — no manual step.
#
# Note that media is then playable only over this hostname: the signed-cookie
# policy names it exactly. The *.cloudfront.net address still serves the app,
# but its segment requests come back 403.
domain_name     = "watcher.moderndayjourney.me"
route53_zone_id = "Z063013830JENA0YBKB28"

# Only when DNS lives outside this account, so Terraform cannot validate a
# certificate itself. Takes precedence over route53_zone_id, and must be
# us-east-1.
# acm_certificate_arn = "arn:aws:acm:us-east-1:111122223333:certificate/..."

# --- Lifetimes ---------------------------------------------------------------
session_ttl_seconds = 43200 # 12h sign-in
media_ttl_seconds   = 3600  # 1h signed cookies, renewed in the background
