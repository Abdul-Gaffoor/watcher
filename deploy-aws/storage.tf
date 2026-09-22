# ---------------------------------------------------------------------------
# Two private buckets: the built SPA, and the video library. Neither is ever
# publicly readable — CloudFront reaches them through Origin Access Control.
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "app" {
  bucket = local.app_bucket_name

  # Losing the content library to a `terraform destroy` would be unrecoverable.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket" "media" {
  bucket = local.media_bucket_name

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "app" {
  bucket                  = aws_s3_bucket.app.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_public_access_block" "media" {
  bucket                  = aws_s3_bucket.media.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "app" {
  bucket = aws_s3_bucket.app.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "media" {
  bucket = aws_s3_bucket.media.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

# Versioning on the app bucket makes a bad frontend deploy recoverable.
resource "aws_s3_bucket_versioning" "app" {
  bucket = aws_s3_bucket.app.id

  versioning_configuration {
    status = "Enabled"
  }
}

# Old hashed assets are unreachable once index.html stops referencing them.
resource "aws_s3_bucket_lifecycle_configuration" "app" {
  bucket     = aws_s3_bucket.app.id
  depends_on = [aws_s3_bucket_versioning.app]

  rule {
    id     = "expire-noncurrent-assets"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# Video uploads are large and multipart; clean up anything that failed midway.
resource "aws_s3_bucket_lifecycle_configuration" "media" {
  bucket = aws_s3_bucket.media.id

  rule {
    id     = "abort-incomplete-multipart-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# --------------------------------------------------------- bucket policies --

# Read access is granted to the CloudFront service principal, and narrowed by
# SourceArn to this one distribution.
data "aws_iam_policy_document" "app_bucket" {
  count = local.use_cloudfront ? 1 : 0

  statement {
    sid     = "AllowCloudFrontRead"
    effect  = "Allow"
    actions = ["s3:GetObject"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    resources = ["${aws_s3_bucket.app.arn}/*"]

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.this[0].arn]
    }
  }
}

data "aws_iam_policy_document" "media_bucket" {
  count = local.use_cloudfront ? 1 : 0

  statement {
    sid     = "AllowCloudFrontRead"
    effect  = "Allow"
    actions = ["s3:GetObject"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    resources = ["${aws_s3_bucket.media.arn}/*"]

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.this[0].arn]
    }
  }
}

# Only CloudFront needs a bucket policy. Behind API Gateway the reading is done
# by a Lambda with an IAM role, and the presigned URLs it hands out inherit that
# role's permission, so the buckets stay reachable with no policy at all.
resource "aws_s3_bucket_policy" "app" {
  count = local.use_cloudfront ? 1 : 0

  bucket     = aws_s3_bucket.app.id
  policy     = data.aws_iam_policy_document.app_bucket[0].json
  depends_on = [aws_s3_bucket_public_access_block.app]
}

resource "aws_s3_bucket_policy" "media" {
  count = local.use_cloudfront ? 1 : 0

  bucket     = aws_s3_bucket.media.id
  policy     = data.aws_iam_policy_document.media_bucket[0].json
  depends_on = [aws_s3_bucket_public_access_block.media]
}

# A segment request starts same-origin and is redirected to S3, which makes the
# final fetch cross-origin. Without this the player can reach the bytes but the
# browser refuses to hand them over.
resource "aws_s3_bucket_cors_configuration" "media" {
  count = local.use_apigateway ? 1 : 0

  bucket = aws_s3_bucket.media.id

  cors_rule {
    allowed_methods = ["GET", "HEAD"]
    allowed_origins = var.domain_name == null ? ["*"] : ["https://${var.domain_name}"]
    allowed_headers = ["*"]
    # hls.js reads these off a range response to drive seeking.
    expose_headers  = ["Content-Length", "Content-Range", "Content-Type", "ETag", "Accept-Ranges"]
    max_age_seconds = 3000
  }
}
