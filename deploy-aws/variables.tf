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
  default     = ["main"]
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

variable "create_terraform_role" {
  type        = bool
  default     = false
  description = <<-DESC
    Also create a broad role for running `terraform plan/apply` from CI. Off by
    default: it is far more privileged than the deploy role, so only turn it on
    once the subject patterns are narrowed to a protected branch or environment.
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
  description = "Optional custom domain (e.g. watch.example.com). Requires acm_certificate_arn."
}

variable "acm_certificate_arn" {
  type        = string
  default     = null
  description = "ACM certificate ARN for domain_name. Must be issued in us-east-1 for CloudFront."

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
