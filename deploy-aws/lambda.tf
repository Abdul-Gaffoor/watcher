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
    variables = {
      USERS_JSON             = local.users_json
      SESSION_SECRET         = random_password.session_secret.result
      CLOUDFRONT_KEY_PAIR_ID = aws_cloudfront_public_key.signing.id
      CLOUDFRONT_PRIVATE_KEY = local.signing_private_key
      MEDIA_RESOURCE         = local.media_resource
      SESSION_TTL_SECONDS    = tostring(var.session_ttl_seconds)
      MEDIA_TTL_SECONDS      = tostring(var.media_ttl_seconds)
    }
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
