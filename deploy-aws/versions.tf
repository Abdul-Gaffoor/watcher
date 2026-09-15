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

  # Remote state is strongly recommended: this state contains the CloudFront
  # signing private key and the session secret. See bootstrap/ for a backend,
  # then uncomment and fill this in.
  #
  # backend "s3" {
  #   bucket       = "watcher-tfstate-<account-id>"
  #   key          = "watcher/terraform.tfstate"
  #   region       = "us-east-1"
  #   encrypt      = true
  #   use_lockfile = true
  # }
}
