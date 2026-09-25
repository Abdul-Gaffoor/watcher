output "app_url" {
  description = "Where the platform is served."
  value = (
    var.domain_name != null
    ? "https://${var.domain_name}"
    : try("https://${aws_cloudfront_distribution.this[0].domain_name}", try(aws_apigatewayv2_api.this[0].api_endpoint, ""))
  )
}

output "distribution_domain_name" {
  description = "CloudFront's generated hostname. Empty when the front end is API Gateway."
  value       = try(aws_cloudfront_distribution.this[0].domain_name, "")
}

# Empty rather than null so `terraform output -raw` succeeds in both modes and
# the deploy workflow can simply test for a value.
output "distribution_id" {
  description = "Needed for cache invalidations. Empty when there is nothing to invalidate."
  value       = try(aws_cloudfront_distribution.this[0].id, "")
}

output "edge" {
  description = "Which front end is deployed: cloudfront or apigateway."
  value       = var.edge
}

output "api_endpoint" {
  description = "The HTTP API's generated hostname. Empty when the front end is CloudFront."
  value       = try(aws_apigatewayv2_api.this[0].api_endpoint, "")
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

output "signing_public_key_id" {
  description = "CloudFront key pair id used when signing media cookies."
  value       = aws_cloudfront_public_key.signing.id
}

output "github_allowed_subjects" {
  description = "The exact OIDC subject claims permitted to assume the roles."
  value       = local.github_subjects
}

output "media_policy_resource" {
  description = "Resource the signed-cookie policy is scoped to. Null behind API Gateway, where the session gates media instead."
  value       = local.media_resource
}

output "certificate_arn" {
  description = "Certificate serving the custom domain. Null when the distribution uses its default *.cloudfront.net certificate."
  value       = local.certificate_arn
}

output "auth_provider" {
  description = "Where viewer credentials live: roster or cognito."
  value       = var.auth_provider
}

output "cognito_user_pool_id" {
  description = "The user pool, for adding viewers or resetting one by hand. Empty on the roster path."
  value       = try(aws_cognito_user_pool.this[0].id, "")
}

output "cognito_client_id" {
  description = "The app client the auth Lambda authenticates against. Not a secret."
  value       = try(aws_cognito_user_pool_client.web[0].id, "")
}

output "users_secret_id" {
  value       = one(aws_secretsmanager_secret.users[*].id)
  description = <<-DESC
    The roster secret. Read the seeded password with:

      aws secretsmanager get-secret-value --secret-id <this> \
        --query SecretString --output text

    Rotate by writing a new value back; it takes effect within
    roster_ttl_seconds and survives the next apply.
  DESC
}
