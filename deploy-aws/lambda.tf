# ---------------------------------------------------------------------------
# The auth API. It verifies passwords, issues the session JWT, and signs the
# CloudFront cookies that unlock /media/*. No npm dependencies — the source is
# zipped straight from backend/src.
# ---------------------------------------------------------------------------

data "archive_file" "api" {
  type        = "zip"
  source_dir  = "${path.module}/../backend/src"
  output_path = "${path.module}/.terraform-build/api.zip"
}

data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "api" {
  name               = "${local.name_prefix}-api"
  description        = "Execution role for the ${var.project_name} auth Lambda."
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

# What the dashboard needs, and nothing else. The Lambda never handles video
# itself; it signs URLs, and a presigned URL can never grant more than the role
# that signed it. So this policy is also the ceiling on what an upload URL
# could ever reach if one leaked.
data "aws_iam_policy_document" "api_media_admin" {
  statement {
    sid    = "ManageMediaObjects"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:AbortMultipartUpload",
      "s3:ListMultipartUploadParts",
    ]
    resources = ["${aws_s3_bucket.media.arn}/*"]
  }

  # Without this, S3 answers a GET for a key that does not exist with 403
  # rather than 404, so a library with no catalog yet would look like a
  # permission failure instead of an empty shelf.
  statement {
    sid       = "DistinguishMissingFromForbidden"
    effect    = "Allow"
    actions   = ["s3:ListBucket", "s3:ListBucketMultipartUploads"]
    resources = [aws_s3_bucket.media.arn]
  }
}

resource "aws_iam_role_policy" "api_media_admin" {
  name   = "${local.name_prefix}-api-media"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api_media_admin.json
}

resource "aws_iam_role_policy_attachment" "api_basic_execution" {
  role       = aws_iam_role.api.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Created explicitly so retention is bounded — the implicit log group Lambda
# makes on first invocation never expires.
resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${local.name_prefix}-api"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "api" {
  function_name = "${local.name_prefix}-api"
  description   = "Sign-in and CloudFront signed-cookie issuer."
  role          = aws_iam_role.api.arn

  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256

  runtime       = "nodejs22.x"
  handler       = "index.handler"
  architectures = ["arm64"]
  memory_size   = 512
  timeout       = 10

  environment {
    variables = merge({
      SESSION_SECRET      = random_password.session_secret.result
      SESSION_TTL_SECONDS = tostring(var.session_ttl_seconds)
      MEDIA_TTL_SECONDS   = tostring(var.media_ttl_seconds)
      # Where the dashboard reads and writes the catalog, and where uploads land.
      MEDIA_BUCKET = aws_s3_bucket.media.id
      MEDIA_REGION = var.aws_region
      }, local.use_cognito ? {
      # Cognito owns the directory, so the roster is not passed at all. The
      # handler refuses to start with both configured, which keeps it
      # unambiguous which password is authoritative.
      COGNITO_USER_POOL_ID = aws_cognito_user_pool.this[0].id
      COGNITO_CLIENT_ID    = aws_cognito_user_pool_client.web[0].id
      COGNITO_REGION       = var.aws_region
      COGNITO_ISSUER_LABEL = var.project_name
      } : {
      USERS_JSON = local.users_json
      }, local.use_cloudfront ? {
      # The signer is configured as a set or not at all. Absent, the handler
      # stops issuing cookies no edge would verify and media is gated by the
      # session instead.
      CLOUDFRONT_KEY_PAIR_ID = aws_cloudfront_public_key.signing.id
      CLOUDFRONT_PRIVATE_KEY = local.signing_private_key
      MEDIA_RESOURCE         = local.media_resource
    } : {})
  }

  depends_on = [
    aws_iam_role_policy_attachment.api_basic_execution,
    aws_cloudwatch_log_group.api,
  ]
}

resource "aws_lambda_function_url" "api" {
  function_name      = aws_lambda_function.api.function_name
  authorization_type = "NONE"
}

# A Function URL with AuthType NONE is reachable directly, bypassing
# CloudFront. Acceptable for the MVP because the handler authenticates every
# request itself; see docs/SECURITY.md for how to close it off.
resource "aws_lambda_permission" "function_url" {
  statement_id           = "AllowPublicFunctionUrlInvoke"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.api.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}
