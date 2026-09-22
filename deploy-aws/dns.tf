# ---------------------------------------------------------------------------
# Custom domain: certificate and DNS.
#
# Only active when domain_name is set. With route53_zone_id Terraform owns the
# whole path — request the certificate, prove ownership by writing the
# validation records, then alias the domain at the distribution. Without it,
# supply acm_certificate_arn and point the record at the distribution yourself.
# ---------------------------------------------------------------------------

data "aws_route53_zone" "this" {
  count = local.manage_dns ? 1 : 0

  zone_id = var.route53_zone_id
}

resource "aws_acm_certificate" "this" {
  count = local.create_certificate ? 1 : 0

  provider = aws.us_east_1

  domain_name       = var.domain_name
  validation_method = "DNS"

  # Replacing a certificate in use by a distribution fails unless the
  # replacement exists first.
  lifecycle {
    create_before_destroy = true

    precondition {
      condition     = endswith(var.domain_name, trimsuffix(data.aws_route53_zone.this[0].name, "."))
      error_message = "domain_name must sit inside the hosted zone named by route53_zone_id."
    }
  }
}

# The DNS proof of ownership.
#
# Deliberately `count` rather than the `for_each` over domain_validation_options
# in most examples. That map's KEYS come from an attribute of a certificate that
# does not exist yet, so on a first apply Terraform cannot plan it at all:
#   the "for_each" map includes keys derived from resource attributes that
#   cannot be determined until apply
# With a single name and no subject alternative names there is exactly one
# option, so a count of one is known up front and the values inside it are free
# to be unknown. Add SANs and this needs revisiting.
resource "aws_route53_record" "certificate_validation" {
  count = local.create_certificate ? 1 : 0

  zone_id = var.route53_zone_id
  name    = tolist(aws_acm_certificate.this[0].domain_validation_options)[0].resource_record_name
  type    = tolist(aws_acm_certificate.this[0].domain_validation_options)[0].resource_record_type
  records = [tolist(aws_acm_certificate.this[0].domain_validation_options)[0].resource_record_value]
  ttl     = 60

  # Re-applying after the certificate is replaced writes the same name again.
  allow_overwrite = true
}

# Blocks until ACM has seen the records and issued the certificate, so the
# distribution is never handed a pending ARN.
resource "aws_acm_certificate_validation" "this" {
  count = local.create_certificate ? 1 : 0

  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.this[0].arn
  validation_record_fqdns = [for record in aws_route53_record.certificate_validation : record.fqdn]
}

# Alias records, not CNAMEs: an alias can sit on a zone apex, resolves without
# an extra lookup, and costs nothing to query.
locals {
  alias_target = local.use_cloudfront ? {
    name    = try(aws_cloudfront_distribution.this[0].domain_name, null)
    zone_id = try(aws_cloudfront_distribution.this[0].hosted_zone_id, null)
    } : {
    name    = try(aws_apigatewayv2_domain_name.this[0].domain_name_configuration[0].target_domain_name, null)
    zone_id = try(aws_apigatewayv2_domain_name.this[0].domain_name_configuration[0].hosted_zone_id, null)
  }
}

resource "aws_route53_record" "app_ipv4" {
  count = local.manage_dns ? 1 : 0

  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = local.alias_target.name
    zone_id                = local.alias_target.zone_id
    evaluate_target_health = false
  }
}

# CloudFront answers on IPv6 and a regional API Gateway endpoint does not, so
# this record only exists in the mode that can serve it. Publishing an AAAA
# that nothing answers would strand IPv6-only clients.
resource "aws_route53_record" "app_ipv6" {
  count = local.manage_dns && local.use_cloudfront ? 1 : 0

  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "AAAA"

  alias {
    name                   = local.alias_target.name
    zone_id                = local.alias_target.zone_id
    evaluate_target_health = false
  }
}
