terraform {
  # 1.10 is the floor for S3-native state locking (use_lockfile).
  required_version = ">= 1.10"

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

  # Shared state, so a laptop and GitHub Actions apply the same stack instead
  # of each building their own. The state holds the CloudFront signing private
  # key, the session secret and the generated seed passwords in plaintext, so
  # the bucket must stay private and versioned.
  #
  # use_lockfile is S3-native locking: a .tflock object beside the state, which
  # replaces the DynamoDB table this used to require.
  backend "s3" {
    bucket       = "terraform-state-132848804230"
    key          = "watcher/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}
