locals {
  # The frontend is hosted on Vercel at the apex and keeps that URL. AWS serves only the API (and the
  # signed video delivery) on its own host; both names are configured in the app from day one, even before
  # DNS points at them, so the first boot already has its final origins.
  frontend_url     = "https://${var.domain_name}"
  api_host         = "${var.api_subdomain}.${var.domain_name}"
  api_url          = "https://${local.api_host}"
  frontend_origins = distinct(concat([local.frontend_url], var.cors_extra_origins))
}

# --- Task security group -------------------------------------------------------------------------
resource "aws_security_group" "app" {
  #checkov:skip=CKV2_AWS_5:Attached to the api, worker and migrate tasks and referenced by the database and cache modules
  name_prefix = "${local.name}-app-"
  description = "API / worker / migrate tasks: ingress only from the internal ALB"
  vpc_id      = module.network.vpc_id

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "app_from_alb" {
  security_group_id            = aws_security_group.app.id
  description                  = "HTTP from the internal ALB"
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
  referenced_security_group_id = module.alb.security_group_id
}

# Egress: HTTPS out through NAT (image pulls, Paymob, Meta, AWS APIs) and the data stores.
resource "aws_vpc_security_group_egress_rule" "app_https" {
  security_group_id = aws_security_group.app.id
  description       = "HTTPS out"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "app_postgres" {
  security_group_id = aws_security_group.app.id
  description       = "PostgreSQL"
  ip_protocol       = "tcp"
  from_port         = 5432
  to_port           = 5432
  cidr_ipv4         = module.network.vpc_cidr
}

resource "aws_vpc_security_group_egress_rule" "app_valkey" {
  security_group_id = aws_security_group.app.id
  description       = "Valkey"
  ip_protocol       = "tcp"
  from_port         = 6379
  to_port           = 6379
  cidr_ipv4         = module.network.vpc_cidr
}

# --- Internal ALB, reachable only through the CloudFront VPC origin --------------------------------
module "alb" {
  source = "../../modules/alb"

  name                   = "${local.name}-alb"
  vpc_id                 = module.network.vpc_id
  vpc_cidr               = module.network.vpc_cidr
  subnet_ids             = module.network.app_subnet_ids
  access_logging_enabled = true
  access_log_bucket      = module.logs_bucket.id
  default_target         = "api"
  deletion_protection    = true

  # The API is the only target: everything that reaches the distribution is an API or media request.
  targets = {
    api = { port = 3000, health_path = "/api/v1/health", paths = [], priority = 0 }
  }

  depends_on = [module.logs_bucket]
}

resource "aws_vpc_security_group_ingress_rule" "alb_from_cloudfront" {
  security_group_id            = module.alb.security_group_id
  description                  = "CloudFront VPC origin"
  ip_protocol                  = "tcp"
  from_port                    = module.alb.listener_port
  to_port                      = module.alb.listener_port
  referenced_security_group_id = module.cdn.vpc_origin_security_group_id
}

# --- CloudFront + WAF ----------------------------------------------------------------------------
# The flat-rate (Business) plan is subscribed to this distribution in the console after the first apply
# (docs/phase6-production.md): Terraform support for the plan subscription is unverified.
module "cdn" {
  source    = "../../modules/cdn"
  providers = { aws = aws, aws.us_east_1 = aws.us_east_1 }

  name         = local.name
  vpc_id       = module.network.vpc_id
  alb_arn      = module.alb.arn
  alb_dns_name = module.alb.dns_name
  alb_https    = module.alb.https

  aliases             = var.certificate_enabled ? [local.api_host] : []
  acm_certificate_arn = var.certificate_enabled ? aws_acm_certificate_validation.api[0].certificate_arn : null

  video_bucket         = module.media.output_bucket
  video_public_key_pem = var.video_public_key_pem
  cors_allowed_origins = local.frontend_origins

  # Public API: no allowlist gate.
  restrict_to_allowlist    = false
  waf_block_managed_rules  = var.waf_block
  rate_rules_block         = var.waf_block
  rate_limit_per_5min      = var.rate_limit_per_5min
  auth_rate_limit_per_5min = var.auth_rate_limit_per_5min
  waf_logs_kms_key_arn     = module.kms_waf_logs.arn
}

# --- DNS -----------------------------------------------------------------------------------------
# The zone holds copies of every existing record (var.dns_records), including the apex and www records that
# point at Vercel, so resolution is identical before and after the name-server change at the registrar.
# Terraform adds exactly one new name: the API host (api.<domain>), brand new, so it needs no cutover.
resource "aws_route53_zone" "this" {
  #checkov:skip=CKV2_AWS_38:DNSSEC is enabled after stabilisation (plan section 2.2); the registrar must publish the DS record first
  #checkov:skip=CKV2_AWS_39:Query logging needs a us-east-1 log group; added with the DNS hardening step
  name = var.domain_name

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_route53_record" "existing" {
  for_each = { for r in var.dns_records : "${r.name}|${r.type}" => r }

  zone_id = aws_route53_zone.this.zone_id
  name    = each.value.name
  type    = each.value.type
  ttl     = each.value.ttl
  records = each.value.records
}

resource "aws_acm_certificate" "api" {
  count    = var.certificate_enabled ? 1 : 0
  provider = aws.us_east_1

  domain_name       = local.api_host
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

locals {
  api_validation = var.certificate_enabled ? one(aws_acm_certificate.api[0].domain_validation_options) : null
}

# The validation record lives in the Route 53 zone, which only answers once the registrar's name servers
# point at it (or earlier if you validate from the zone directly); enable var.certificate_enabled after that.
resource "aws_route53_record" "api_validation" {
  count = var.certificate_enabled ? 1 : 0

  zone_id         = aws_route53_zone.this.zone_id
  name            = local.api_validation.resource_record_name
  type            = local.api_validation.resource_record_type
  records         = [local.api_validation.resource_record_value]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "api" {
  count    = var.certificate_enabled ? 1 : 0
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.api[0].arn
  validation_record_fqdns = aws_route53_record.api_validation[*].fqdn
}

# The API host. Created together with the certificate and the distribution alias; nothing else in the zone changes.
resource "aws_route53_record" "api" {
  for_each = var.certificate_enabled ? toset(["A", "AAAA"]) : toset([])

  zone_id = aws_route53_zone.this.zone_id
  name    = local.api_host
  type    = each.value

  alias {
    name                   = module.cdn.domain_name
    zone_id                = module.cdn.hosted_zone_id
    evaluate_target_health = false
  }
}
