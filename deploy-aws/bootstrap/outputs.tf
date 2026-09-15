output "state_bucket_name" {
  description = "Use as the `bucket` value in the parent's backend block."
  value       = aws_s3_bucket.state.id
}

output "backend_block" {
  description = "Paste into ../versions.tf, replacing the commented-out backend."
  value       = <<-HCL
    backend "s3" {
      bucket       = "${aws_s3_bucket.state.id}"
      key          = "${var.project_name}/terraform.tfstate"
      region       = "${var.aws_region}"
      encrypt      = true
      use_lockfile = true
    }
  HCL
}
