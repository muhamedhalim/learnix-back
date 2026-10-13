locals {
  # The staging frontend is a Vercel deployment (a branch domain such as https://staging.learnix.school, or an
  # explicit var.frontend_url); AWS serves only the API host. Before the custom domain exists the API answers
  # on the distribution's cloudfront.net name.
  # The .invalid fallback is unreachable: variable validation rejects a plan with neither input set.
  frontend_url = var.frontend_url != null ? var.frontend_url : (var.domain_name != null ? "https://${var.domain_name}" : "https://frontend-not-configured.invalid")
  # The custom name is a pure function of the variables (certificate, alias and DNS use it); only the URL the
  # application advertises falls back to the distribution's own name, which depends on the distribution.
  api_custom_host  = try("${var.api_subdomain}.${var.domain_name}", null)
  api_host         = var.custom_domain_enabled ? local.api_custom_host : module.cdn.domain_name
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

# Egress: HTTPS to the internet (image pulls, Paymob, Meta, AWS APIs) and the data stores.
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
module "cdn" {
  source    = "../../modules/cdn"
  providers = { aws = aws, aws.us_east_1 = aws.us_east_1 }

  name         = local.name
  vpc_id       = module.network.vpc_id
  alb_arn      = module.alb.arn
  alb_dns_name = module.alb.dns_name
  alb_https    = module.alb.https

  aliases             = var.custom_domain_enabled ? [local.api_custom_host] : []
  acm_certificate_arn = var.custom_domain_enabled ? aws_acm_certificate_validation.api[0].certificate_arn : null

  video_bucket         = module.media.output_bucket
  video_public_key_pem = var.video_public_key_pem
  cors_allowed_origins = local.frontend_origins

  restrict_to_allowlist = true
  allowed_ipv4_cidrs    = var.allowed_ipv4_cidrs
  allowed_ipv6_cidrs    = var.allowed_ipv6_cidrs
  open_path_prefixes    = var.open_path_prefixes
  waf_logs_kms_key_arn  = module.kms_waf_logs.arn
}

# --- DNS: delegated sub-zone, certificate, alias ---------------------------------------------------
# Stage 1 (custom_domain_enabled = false): the zone is created and its name servers are published as an
# output. The operator adds NS records for it in the parent zone. Stage 2: enable the custom domain.
resource "aws_route53_zone" "this" {
  #checkov:skip=CKV2_AWS_38:DNSSEC is enabled after stabilisation (plan section 2.2); the parent zone must publish the DS record first
  #checkov:skip=CKV2_AWS_39:Query logging needs a us-east-1 log group; staging DNS holds a handful of records
  count = var.domain_name == null ? 0 : 1

  name = var.domain_name
}

resource "aws_acm_certificate" "api" {
  count    = var.custom_domain_enabled ? 1 : 0
  provider = aws.us_east_1

  domain_name       = local.api_custom_host
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

# A single-name certificate has exactly one validation record. The key is the (static) domain name, so the
# plan never depends on provider-computed set contents.
locals {
  api_validation = var.custom_domain_enabled ? one(aws_acm_certificate.api[0].domain_validation_options) : null
}

resource "aws_route53_record" "api_validation" {
  count = var.custom_domain_enabled ? 1 : 0

  zone_id         = aws_route53_zone.this[0].zone_id
  name            = local.api_validation.resource_record_name
  type            = local.api_validation.resource_record_type
  records         = [local.api_validation.resource_record_value]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "api" {
  count    = var.custom_domain_enabled ? 1 : 0
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.api[0].arn
  validation_record_fqdns = aws_route53_record.api_validation[*].fqdn
}

# Records for the Vercel-hosted staging frontend itself (the zone apex), supplied by the operator from Vercel's
# domain settings. Nothing here is guessed.
resource "aws_route53_record" "frontend" {
  for_each = var.domain_name == null ? {} : { for r in var.dns_records : "${r.name}|${r.type}" => r }

  zone_id = aws_route53_zone.this[0].zone_id
  name    = each.value.name
  type    = each.value.type
  ttl     = each.value.ttl
  records = each.value.records
}

# The API host.
resource "aws_route53_record" "api" {
  for_each = var.custom_domain_enabled ? toset(["A", "AAAA"]) : toset([])

  zone_id = aws_route53_zone.this[0].zone_id
  name    = local.api_custom_host
  type    = each.value

  alias {
    name                   = module.cdn.domain_name
    zone_id                = module.cdn.hosted_zone_id
    evaluate_target_health = false
  }
}
