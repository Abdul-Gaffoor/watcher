# ---------------------------------------------------------------------------
# The CloudFront-free front end.
#
# One HTTP API on the same domain, with the same certificate, splitting by
# route the way the distribution split by cache behaviour:
#
#   /api/*          -> the auth Lambda, unchanged
#   everything else -> the edge Lambda: app shell, and the gate on /media/*
#
# Still one origin, so still no CORS on the API and cookies still work. What is
# gone is the cache: every asset and every video segment is an invocation.
# ---------------------------------------------------------------------------

locals {
  # Both functions ship from the same zip; only the handler differs.
  edge_function_name = "${local.name_prefix}-edge"
}

resource "aws_iam_role" "edge" {
  count = local.use_apigateway ? 1 : 0

  name               = local.edge_function_name
  description        = "Execution role for the ${var.project_name} edge Lambda."
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy_attachment" "edge_basic_execution" {
  count = local.use_apigateway ? 1 : 0

  role       = aws_iam_role.edge[0].name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Read-only, and only these two buckets. A presigned URL can never grant more
# than the role that signed it, so this is also the ceiling on what a leaked
# media URL could reach.
data "aws_iam_policy_document" "edge_read_buckets" {
  count = local.use_apigateway ? 1 : 0

  statement {
    sid     = "ReadSiteObjects"
    effect  = "Allow"
    actions = ["s3:GetObject"]
    resources = [
      "${aws_s3_bucket.app.arn}/*",
      "${aws_s3_bucket.media.arn}/*",
    ]
  }

  # Without ListBucket, S3 answers a GET for a key that does not exist with 403
  # rather than 404, to avoid telling an unauthorised caller which keys exist.
  # Here the caller is our own function, and that disguise turns every missing
  # file into an indistinguishable permission error. Granting it on the bucket
  # itself, not its objects, makes a 404 mean what it says.
  statement {
    sid     = "DistinguishMissingFromForbidden"
    effect  = "Allow"
    actions = ["s3:ListBucket"]
    resources = [
      aws_s3_bucket.app.arn,
      aws_s3_bucket.media.arn,
    ]
  }
}

resource "aws_iam_role_policy" "edge_read_buckets" {
  count = local.use_apigateway ? 1 : 0

  name   = "${local.edge_function_name}-read"
  role   = aws_iam_role.edge[0].id
  policy = data.aws_iam_policy_document.edge_read_buckets[0].json
}

resource "aws_cloudwatch_log_group" "edge" {
  count = local.use_apigateway ? 1 : 0

  name              = "/aws/lambda/${local.edge_function_name}"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "edge" {
  count = local.use_apigateway ? 1 : 0

  function_name = local.edge_function_name
  description   = "Serves the app shell and gates /media/* with presigned URLs."
  role          = aws_iam_role.edge[0].arn

  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256

  runtime       = "nodejs22.x"
  handler       = "edge.handler"
  architectures = ["arm64"]
  memory_size   = 512
  timeout       = 30

  environment {
    variables = {
      APP_BUCKET        = aws_s3_bucket.app.id
      MEDIA_BUCKET      = aws_s3_bucket.media.id
      SESSION_SECRET    = random_password.session_secret.result
      MEDIA_TTL_SECONDS = tostring(var.media_ttl_seconds)
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.edge_basic_execution,
    aws_cloudwatch_log_group.edge,
  ]
}

resource "aws_apigatewayv2_api" "this" {
  count = local.use_apigateway ? 1 : 0

  name          = local.name_prefix
  description   = "${var.project_name} front end (no CloudFront)."
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "auth" {
  count = local.use_apigateway ? 1 : 0

  api_id           = aws_apigatewayv2_api.this[0].id
  integration_type = "AWS_PROXY"
  integration_uri  = aws_lambda_function.api.invoke_arn
  # 2.0 is the shape the handler already reads: rawPath, requestContext.http,
  # a cookies array in and a cookies array out. Identical to a Function URL.
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_integration" "edge" {
  count = local.use_apigateway ? 1 : 0

  api_id                 = aws_apigatewayv2_api.this[0].id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.edge[0].invoke_arn
  payload_format_version = "2.0"
  # Large segments are a redirect rather than a body, so this only has to cover
  # an S3 round trip for a playlist or an asset.
  timeout_milliseconds = 29000
}

resource "aws_apigatewayv2_route" "api" {
  count = local.use_apigateway ? 1 : 0

  api_id    = aws_apigatewayv2_api.this[0].id
  route_key = "ANY /api/{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.auth[0].id}"
}

# Everything the /api/* route does not claim, including /media/*, which the
# edge Lambda separates by path.
resource "aws_apigatewayv2_route" "default" {
  count = local.use_apigateway ? 1 : 0

  api_id    = aws_apigatewayv2_api.this[0].id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.edge[0].id}"
}

resource "aws_apigatewayv2_stage" "default" {
  count = local.use_apigateway ? 1 : 0

  api_id      = aws_apigatewayv2_api.this[0].id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    # A login endpoint with only an in-memory throttle behind it deserves a
    # ceiling that survives scale-out. See ../docs/SECURITY.md.
    throttling_burst_limit = 200
    throttling_rate_limit  = 100
  }
}

resource "aws_lambda_permission" "api_gateway_auth" {
  count = local.use_apigateway ? 1 : 0

  statement_id  = "AllowInvokeFromHttpApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this[0].execution_arn}/*/*"
}

resource "aws_lambda_permission" "api_gateway_edge" {
  count = local.use_apigateway ? 1 : 0

  statement_id  = "AllowInvokeFromHttpApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.edge[0].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this[0].execution_arn}/*/*"
}

# A regional endpoint, so no CloudFront distribution is created on our behalf
# either. That also means the certificate has to live in this region rather
# than always us-east-1.
resource "aws_apigatewayv2_domain_name" "this" {
  count = local.use_apigateway && var.domain_name != null ? 1 : 0

  domain_name = var.domain_name

  domain_name_configuration {
    certificate_arn = local.certificate_arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }

  lifecycle {
    precondition {
      condition     = var.aws_region == "us-east-1" || var.acm_certificate_arn != null
      error_message = "A regional API Gateway domain needs a certificate in aws_region. Terraform issues its managed certificate in us-east-1, so either keep aws_region there or pass acm_certificate_arn for this region."
    }
  }
}

resource "aws_apigatewayv2_api_mapping" "this" {
  count = local.use_apigateway && var.domain_name != null ? 1 : 0

  api_id      = aws_apigatewayv2_api.this[0].id
  domain_name = aws_apigatewayv2_domain_name.this[0].id
  stage       = aws_apigatewayv2_stage.default[0].id
}
