# Values GitHub Actions applies with. Committed on purpose: none of it is
# secret. The one secret input, the viewer roster, arrives as the TF_VAR_users
# environment variable from a repository secret.
#
# Your laptop keeps using terraform.tfvars, which is gitignored. This file is
# named rather than *.auto.tfvars so it is only ever loaded by the explicit
# -var-file in the workflow, and never shadows your local values.

project_name = "watcher"
aws_region   = "us-east-1"

# Runners have no ~/.aws/config. Credentials come from AWS_ACCESS_KEY_ID and
# AWS_SECRET_ACCESS_KEY in the environment instead.
aws_profile = null

github_owner    = "Abdul-Gaffoor"
github_repo     = "watcher"
github_branches = ["master"]

create_oidc_provider = true

price_class = "PriceClass_100"

# CloudFront is blocked on this account pending AWS verification, so the front
# end is an HTTP API instead: same domain, same certificate, same buckets, but
# media is gated by the session in a Lambda rather than by a key group at the
# edge, and nothing is cached. Set this back to "cloudfront" once the account
# is verified; the distribution is the only resource that has to be created.
edge = "apigateway"

domain_name     = "watcher.moderndayjourney.me"
route53_zone_id = "Z063013830JENA0YBKB28"

session_ttl_seconds = 43200
media_ttl_seconds   = 3600
