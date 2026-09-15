# ---------------------------------------------------------------------------
# GitHub Actions -> AWS via OIDC. No long-lived access keys anywhere: a workflow
# exchanges its short-lived GitHub token for temporary AWS credentials, and the
# trust policy pins exactly which repository and ref may do so.
# ---------------------------------------------------------------------------

# GitHub rotates its signing certificate, so read the current thumbprint rather
# than hardcoding one. (AWS no longer enforces it for this provider, but the
# field is still required.)
data "tls_certificate" "github" {
  count = var.create_oidc_provider ? 1 : 0
  url   = "https://token.actions.githubusercontent.com/.well-known/openid-configuration"
}

resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_oidc_provider ? 1 : 0

  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.github[0].certificates[0].sha1_fingerprint]
}

# An account holds at most one provider per URL, so reuse an existing one when
# create_oidc_provider is false.
data "aws_iam_openid_connect_provider" "existing" {
  count = var.create_oidc_provider ? 0 : 1
  url   = "https://token.actions.githubusercontent.com"
}

locals {
  oidc_provider_arn = var.create_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : data.aws_iam_openid_connect_provider.existing[0].arn
}

data "aws_iam_policy_document" "github_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider_arn]
    }

    # Without the audience check, a token minted for any other audience would be
    # accepted.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # Without the subject check, ANY GitHub repository could assume this role.
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = local.github_subjects
    }
  }
}

# ------------------------------------------------------------ deploy role --

resource "aws_iam_role" "github_deploy" {
  name               = "${local.name_prefix}-github-actions-deploy"
  description        = "Publishes the built SPA and catalog, and invalidates CloudFront."
  assume_role_policy = data.aws_iam_policy_document.github_assume_role.json

  # A workflow job is short; capping the session makes leaked credentials
  # useless sooner.
  max_session_duration = 3600
}

data "aws_iam_policy_document" "github_deploy" {
  statement {
    sid     = "ListDeploymentBuckets"
    effect  = "Allow"
    actions = ["s3:ListBucket", "s3:GetBucketLocation"]
    resources = [
      aws_s3_bucket.app.arn,
      aws_s3_bucket.media.arn,
    ]
  }

  statement {
    sid    = "PublishObjects"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
    ]
    resources = [
      "${aws_s3_bucket.app.arn}/*",
      "${aws_s3_bucket.media.arn}/*",
    ]
  }

  # Scoped to this distribution: a deploy job cannot touch any other one.
  statement {
    sid    = "InvalidateThisDistribution"
    effect = "Allow"
    actions = [
      "cloudfront:CreateInvalidation",
      "cloudfront:GetInvalidation",
      "cloudfront:ListInvalidations",
    ]
    resources = [aws_cloudfront_distribution.this.arn]
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  name   = "${local.name_prefix}-deploy"
  role   = aws_iam_role.github_deploy.id
  policy = data.aws_iam_policy_document.github_deploy.json
}
