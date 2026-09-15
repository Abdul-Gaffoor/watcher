output "app_url" {
  description = "Where the platform is served."
  value       = var.domain_name != null ? "https://${var.domain_name}" : "https://${aws_cloudfront_distribution.this.domain_name}"
}

output "distribution_domain_name" {
  description = "CloudFront's generated hostname. Point a CNAME here for a custom domain."
  value       = aws_cloudfront_distribution.this.domain_name
}

output "distribution_id" {
  description = "Needed for cache invalidations."
  value       = aws_cloudfront_distribution.this.id
}

output "app_bucket_name" {
  description = "Target for the built SPA."
  value       = aws_s3_bucket.app.id
}

output "media_bucket_name" {
  description = "Target for catalog.json and the video library."
  value       = aws_s3_bucket.media.id
}

output "api_function_name" {
  value       = aws_lambda_function.api.function_name
  description = "Auth Lambda."
}

output "github_actions_deploy_role_arn" {
  description = "Set as the AWS_DEPLOY_ROLE_ARN repository variable in GitHub."
  value       = aws_iam_role.github_deploy.arn
}

output "github_actions_terraform_role_arn" {
  description = "Set as AWS_TERRAFORM_ROLE_ARN. Null unless create_terraform_role is true."
  value       = var.create_terraform_role ? aws_iam_role.github_terraform[0].arn : null
}

output "signing_public_key_id" {
  description = "CloudFront key pair id used when signing media cookies."
  value       = aws_cloudfront_public_key.signing.id
}

output "github_allowed_subjects" {
  description = "The exact OIDC subject claims permitted to assume the roles."
  value       = local.github_subjects
}

output "media_policy_resource" {
  description = "Resource string the signed-cookie policy is scoped to."
  value       = local.media_resource
}
