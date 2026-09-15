terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }

  # State is local (terraform.tfstate, gitignored). It holds the CloudFront
  # signing private key and the session secret in plaintext, so keep a backup
  # and never commit it. Add a `backend "s3"` block here if this ever needs to
  # be shared between machines.
}
