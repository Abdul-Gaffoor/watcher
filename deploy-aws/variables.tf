# ---------------------------------------------------------------- general --

variable "project_name" {
  type        = string
  default     = "watcher"
  description = "Lowercase prefix for resource names."

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,30}$", var.project_name))
    error_message = "project_name must be 2-31 lowercase letters, digits or hyphens."
  }
}

variable "aws_region" {
  type        = string
  default     = "us-east-1"
  description = "Region for the buckets and the auth Lambda. CloudFront itself is global."
}

variable "aws_profile" {
  type        = string
  default     = null
  description = <<-DESC
    Named profile from ~/.aws/credentials or ~/.aws/config to apply with. Leave
    null in CI, where the GitHub OIDC role supplies credentials through the
    environment instead.
  DESC
}

variable "edge" {
  type        = string
  default     = "cloudfront"
  description = <<-DESC
    What sits in front of the app.

    "cloudfront" is the intended design: one distribution, media gated at the
    edge by a trusted key group, everything cached close to the viewer.

    "apigateway" is the fallback for an account that cannot create a
    distribution. An HTTP API serves the same paths, media is gated by checking
    the session in a Lambda that then hands back a presigned S3 URL, and
    nothing is cached anywhere. Same domain, same certificate, same buckets.
  DESC

  validation {
    condition     = contains(["cloudfront", "apigateway"], var.edge)
    error_message = "edge must be \"cloudfront\" or \"apigateway\"."
  }
}

variable "tags" {
  type        = map(string)
  default     = {}
  description = "Extra tags applied to every resource."
}

# ----------------------------------------------------------- GitHub OIDC --

variable "github_owner" {
  type        = string
  description = "GitHub user or organisation that owns the repository."
}

variable "github_repo" {
  type        = string
  description = "Repository name, without the owner prefix."
}

variable "github_branches" {
  type        = list(string)
  default     = ["master"]
  description = "Branches allowed to assume the deploy role. Wildcards are allowed (e.g. \"release/*\")."
}

variable "github_environments" {
  type        = list(string)
  default     = []
  description = <<-DESC
    GitHub Environments allowed to assume the deploy role. Prefer this over
    branches for production: an environment can require a manual approval before
    the job — and therefore before the role — is ever reachable.
  DESC
}

variable "github_extra_subjects" {
  type        = list(string)
  default     = []
  description = "Additional raw `sub` claim patterns, for pull_request or tag triggers."
}

variable "create_oidc_provider" {
  type        = bool
  default     = true
  description = <<-DESC
    Create the GitHub OIDC provider. An AWS account can only hold one provider
    per URL, so set this to false if another stack already created it — this
    configuration then looks the existing one up instead.
  DESC
}

# ------------------------------------------------------------------ auth --

variable "users" {
  type = list(object({
    username      = string
    name          = optional(string)
    roles         = optional(list(string), ["viewer"])
    password_hash = string
  }))
  sensitive   = true
  description = <<-DESC
    Viewers allowed to sign in. Generate each hash with:
      node scripts/hash-password.mjs
    Never put a plaintext password here.
  DESC

  validation {
    condition     = length(var.users) > 0
    error_message = "At least one user is required, or nobody can sign in."
  }

  validation {
    condition     = alltrue([for user in var.users : startswith(user.password_hash, "scrypt$")])
    error_message = "Every password_hash must be a scrypt hash from scripts/hash-password.mjs, not a plaintext password."
  }

  validation {
    condition     = length(distinct([for user in var.users : lower(user.username)])) == length(var.users)
    error_message = "Usernames must be unique (they are matched case-insensitively)."
  }
}

variable "session_ttl_seconds" {
  type        = number
  default     = 43200
  description = "How long a sign-in lasts."

  validation {
    condition     = var.session_ttl_seconds >= 300 && var.session_ttl_seconds <= 604800
    error_message = "session_ttl_seconds must be between 300 (5 minutes) and 604800 (7 days)."
  }
}

variable "media_ttl_seconds" {
  type        = number
  default     = 3600
  description = "Lifetime of the CloudFront signed cookies. The app renews them in the background."

  validation {
    condition     = var.media_ttl_seconds >= 300
    error_message = "media_ttl_seconds must be at least 300 (5 minutes)."
  }
}

variable "signing_private_key_pem" {
  type        = string
  default     = null
  sensitive   = true
  description = <<-DESC
    Existing RSA private key (PEM) for signing media cookies. Leave null to have
    Terraform generate one. Either way the key ends up in state, so keep state
    encrypted and access-controlled.
  DESC
}

# ------------------------------------------------------------ CloudFront --

variable "price_class" {
  type        = string
  default     = "PriceClass_100"
  description = "PriceClass_100 (NA/EU), PriceClass_200 (+ Asia), or PriceClass_All."

  validation {
    condition     = contains(["PriceClass_100", "PriceClass_200", "PriceClass_All"], var.price_class)
    error_message = "price_class must be PriceClass_100, PriceClass_200 or PriceClass_All."
  }
}

variable "domain_name" {
  type        = string
  default     = null
  description = <<-DESC
    Custom domain the platform is served on (e.g. watcher.example.com). Needs a
    certificate: either set route53_zone_id and let Terraform request and
    validate one, or supply acm_certificate_arn yourself.

    Setting this also pins the signed-cookie policy to this exact host, so media
    is only playable through this domain — see locals.tf.
  DESC

  validation {
    condition     = var.domain_name == null || can(regex("^[a-z0-9][a-z0-9.-]*[a-z0-9]$", var.domain_name))
    error_message = "domain_name must be a bare lowercase hostname, with no scheme and no trailing dot."
  }
}

variable "route53_zone_id" {
  type        = string
  default     = null
  description = <<-DESC
    Hosted zone that is authoritative for domain_name. When set, Terraform
    requests an ACM certificate, writes its DNS validation records, and points
    A and AAAA alias records at the distribution.

    Leave null to manage DNS elsewhere; then supply acm_certificate_arn and
    create the alias (or CNAME) record yourself.
  DESC

  validation {
    condition     = var.route53_zone_id == null || can(regex("^Z[A-Z0-9]+$", var.route53_zone_id))
    error_message = "route53_zone_id must be a hosted zone id, e.g. Z0123456789ABCDEFGHIJ."
  }
}

variable "acm_certificate_arn" {
  type        = string
  default     = null
  description = <<-DESC
    Existing certificate for domain_name, when DNS lives outside this account
    and Terraform cannot validate one itself. Must be issued in us-east-1 —
    CloudFront accepts certificates from nowhere else. Takes precedence over
    route53_zone_id.
  DESC

  validation {
    condition     = var.acm_certificate_arn == null || can(regex("^arn:aws[a-z-]*:acm:us-east-1:", var.acm_certificate_arn))
    error_message = "CloudFront only accepts ACM certificates issued in us-east-1."
  }
}

variable "log_retention_days" {
  type        = number
  default     = 30
  description = "CloudWatch retention for the auth Lambda's logs."
}
