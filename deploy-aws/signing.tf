# ---------------------------------------------------------------------------
# The RSA key pair behind the CloudFront signed cookies. The Lambda signs a
# policy with the private half; CloudFront verifies it at the edge against the
# public half in the trusted key group.
# ---------------------------------------------------------------------------

resource "tls_private_key" "signing" {
  count = var.signing_private_key_pem == null ? 1 : 0

  algorithm = "RSA"
  rsa_bits  = 2048
}

locals {
  signing_private_key = var.signing_private_key_pem != null ? var.signing_private_key_pem : tls_private_key.signing[0].private_key_pem
  signing_public_key  = var.signing_private_key_pem != null ? data.tls_public_key.supplied[0].public_key_pem : tls_private_key.signing[0].public_key_pem
}

# Derives the public half when the private key was supplied.
data "tls_public_key" "supplied" {
  count = var.signing_private_key_pem == null ? 0 : 1

  private_key_pem = var.signing_private_key_pem
}

resource "aws_cloudfront_public_key" "signing" {
  name        = "${local.name_prefix}-media-signing-key"
  comment     = "Verifies signed cookies issued by the ${var.project_name} auth Lambda."
  encoded_key = local.signing_public_key

  # CloudFront public keys are immutable: rotating the key means creating the
  # new one before the key group stops referencing the old one.
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_cloudfront_key_group" "signing" {
  name    = "${local.name_prefix}-media-key-group"
  comment = "Key group trusted by the /media/* behaviour."
  items   = [aws_cloudfront_public_key.signing.id]
}

# Signs the session JWTs. Kept in state (not regenerated on each apply) so a
# redeploy does not sign everybody out.
resource "random_password" "session_secret" {
  length  = 64
  special = false
}
