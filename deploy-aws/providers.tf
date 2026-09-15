provider "aws" {
  region = var.aws_region

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
