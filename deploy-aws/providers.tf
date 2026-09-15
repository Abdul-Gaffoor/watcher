# The default provider. `profile` is null unless aws_profile is set, which
# falls back to the usual credential chain (env vars, SSO, instance role) —
# so the same configuration works from a laptop and from CI.
provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile

  default_tags {
    tags = merge(
      {
        Project   = var.project_name
        ManagedBy = "terraform"
      },
      var.tags,
    )
  }
}

# CloudFront only accepts ACM certificates from us-east-1, whatever region the
# buckets and the Lambda live in. This alias exists so the certificate can be
# issued there without pinning the rest of the stack to that region.
provider "aws" {
  alias   = "us_east_1"
  region  = "us-east-1"
  profile = var.aws_profile

  default_tags {
    tags = merge(
      {
        Project   = var.project_name
        ManagedBy = "terraform"
      },
      var.tags,
    )
  }
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
