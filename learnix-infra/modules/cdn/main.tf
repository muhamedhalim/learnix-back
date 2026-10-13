terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source                = "hashicorp/aws"
      version               = "~> 6.0"
      configuration_aliases = [aws.us_east_1]
    }
  }
}

locals {
  alb_origin_id   = "alb"
  video_origin_id = "video"
  video_enabled   = var.video_public_key_pem != null && var.video_bucket != null
  custom_domain   = var.acm_certificate_arn != null && length(var.aliases) > 0
}

data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer" {
  name = "Managed-AllViewer"
}

# --- Origins -------------------------------------------------------------------------------------
resource "aws_cloudfront_vpc_origin" "alb" {
  vpc_origin_endpoint_config {
    name                   = "${var.name}-alb"
    arn                    = var.alb_arn
    http_port              = 80
    https_port             = 443
    origin_protocol_policy = var.alb_https ? "https-only" : "http-only"

    origin_ssl_protocols {
      quantity = 1
      items    = ["TLSv1.2"]
    }
  }
}

# The VPC origin owns a service-managed security group in our VPC; the ALB admits only that group.
data "aws_security_group" "vpc_origin_service" {
  vpc_id = var.vpc_id

  filter {
    name   = "group-name"
    values = ["CloudFront-VPCOrigins-Service-SG"]
  }

  depends_on = [aws_cloudfront_vpc_origin.alb]
}

resource "aws_cloudfront_origin_access_control" "video" {
  count = local.video_enabled ? 1 : 0

  name                              = "${var.name}-video"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# --- Playback authorisation: signed cookies are verified against this key group --------------------
resource "aws_cloudfront_public_key" "video" {
  count = local.video_enabled ? 1 : 0

  name        = "${var.name}-video"
  encoded_key = var.video_public_key_pem
}

resource "aws_cloudfront_key_group" "video" {
  count = local.video_enabled ? 1 : 0

  name  = "${var.name}-video"
  items = [aws_cloudfront_public_key.video[0].id]
}

# Playback responses come from S3, which cannot answer the browser's credentialed CORS check by itself.
# Only the listed frontend origins are echoed (never "*": credentials are involved).
resource "aws_cloudfront_response_headers_policy" "video" {
  #checkov:skip=CKV_AWS_259:HSTS preload is a permanent browser-list commitment made deliberately at production launch
  count = local.video_enabled ? 1 : 0

  name = "${var.name}-video-cors"

  lifecycle {
    precondition {
      condition     = length(var.cors_allowed_origins) > 0
      error_message = "Playback needs at least one frontend origin in cors_allowed_origins."
    }
  }

  cors_config {
    access_control_allow_credentials = true
    origin_override                  = true
    access_control_max_age_sec       = 3600

    access_control_allow_headers {
      items = ["Range", "Content-Type"]
    }
    access_control_allow_methods {
      items = ["GET", "HEAD", "OPTIONS"]
    }
    access_control_allow_origins {
      items = var.cors_allowed_origins
    }
    access_control_expose_headers {
      items = ["Content-Length", "Content-Range", "Content-Type"]
    }
  }

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      override                   = true
    }
    content_type_options {
      override = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
  }
}

resource "aws_cloudfront_response_headers_policy" "security" {
  #checkov:skip=CKV_AWS_259:HSTS max-age one year with includeSubDomains is set; preload is a permanent browser-list commitment made deliberately at production launch
  name = "${var.name}-security-headers"

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      override                   = true
    }
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "SAMEORIGIN"
      override     = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
  }
}

# --- WAF (CLOUDFRONT scope lives in us-east-1) ---------------------------------------------------
resource "aws_wafv2_ip_set" "allowed_v4" {
  provider = aws.us_east_1

  name               = "${var.name}-allowed-v4"
  scope              = "CLOUDFRONT"
  ip_address_version = "IPV4"
  addresses          = var.allowed_ipv4_cidrs
}

resource "aws_wafv2_ip_set" "allowed_v6" {
  provider = aws.us_east_1

  name               = "${var.name}-allowed-v6"
  scope              = "CLOUDFRONT"
  ip_address_version = "IPV6"
  addresses          = var.allowed_ipv6_cidrs
}

resource "aws_wafv2_web_acl" "this" {
  #checkov:skip=CKV_AWS_192:The Log4j (AMR) rule is in AWSManagedRulesKnownBadInputsRuleSet below
  provider = aws.us_east_1

  name  = var.name
  scope = "CLOUDFRONT"

  default_action {
    allow {}
  }

  # Staging gate: anything that is not an allowlisted address (or a provider webhook path) is blocked.
  # Takes the place of the never-built Cloudflare Access gate.
  dynamic "rule" {
    for_each = var.restrict_to_allowlist ? [1] : []
    content {
      name     = "block-unless-allowlisted"
      priority = 0

      action {
        block {}
      }

      statement {
        not_statement {
          statement {
            or_statement {
              statement {
                ip_set_reference_statement {
                  arn = aws_wafv2_ip_set.allowed_v4.arn
                }
              }
              statement {
                ip_set_reference_statement {
                  arn = aws_wafv2_ip_set.allowed_v6.arn
                }
              }
              dynamic "statement" {
                for_each = var.open_path_prefixes
                content {
                  byte_match_statement {
                    search_string         = statement.value
                    positional_constraint = "STARTS_WITH"
                    field_to_match {
                      uri_path {}
                    }
                    text_transformation {
                      priority = 0
                      type     = "NONE"
                    }
                  }
                }
              }
            }
          }
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "${var.name}-allowlist"
        sampled_requests_enabled   = true
      }
    }
  }

  # Per-IP rate limits. The general limit is deliberately generous (schools and carriers share addresses
  # behind NAT); the auth limit is strict. COUNT first, then BLOCK once tuned.
  dynamic "rule" {
    for_each = var.rate_limit_per_5min == null ? [] : [1]
    content {
      name     = "rate-limit-general"
      priority = 5

      action {
        dynamic "count" {
          for_each = var.rate_rules_block ? [] : [1]
          content {}
        }
        dynamic "block" {
          for_each = var.rate_rules_block ? [1] : []
          content {}
        }
      }

      statement {
        rate_based_statement {
          limit              = var.rate_limit_per_5min
          aggregate_key_type = "IP"
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "${var.name}-rate-general"
        sampled_requests_enabled   = true
      }
    }
  }

  dynamic "rule" {
    for_each = var.auth_rate_limit_per_5min == null ? [] : [1]
    content {
      name     = "rate-limit-auth"
      priority = 6

      action {
        dynamic "count" {
          for_each = var.rate_rules_block ? [] : [1]
          content {}
        }
        dynamic "block" {
          for_each = var.rate_rules_block ? [1] : []
          content {}
        }
      }

      statement {
        rate_based_statement {
          limit              = var.auth_rate_limit_per_5min
          aggregate_key_type = "IP"

          scope_down_statement {
            byte_match_statement {
              search_string         = "/api/v1/auth/"
              positional_constraint = "STARTS_WITH"
              field_to_match {
                uri_path {}
              }
              text_transformation {
                priority = 0
                type     = "NONE"
              }
            }
          }
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "${var.name}-rate-auth"
        sampled_requests_enabled   = true
      }
    }
  }

  dynamic "rule" {
    for_each = { for i, g in var.managed_rule_groups : g => i }
    content {
      name     = rule.key
      priority = 10 + rule.value

      # COUNT first (plan: tune on staging, then BLOCK). "none" lets the group's own actions apply.
      override_action {
        dynamic "count" {
          for_each = var.waf_block_managed_rules ? [] : [1]
          content {}
        }
        dynamic "none" {
          for_each = var.waf_block_managed_rules ? [1] : []
          content {}
        }
      }

      statement {
        managed_rule_group_statement {
          name        = rule.key
          vendor_name = "AWS"
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "${var.name}-${rule.key}"
        sampled_requests_enabled   = true
      }
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = var.name
    sampled_requests_enabled   = true
  }
}

resource "aws_cloudwatch_log_group" "waf" {
  #checkov:skip=CKV_AWS_338:Retention is var.log_retention_days (30 d per the plan); long-term audit trail is the organization CloudTrail
  provider = aws.us_east_1

  # WAF requires the aws-waf-logs- prefix.
  name              = "aws-waf-logs-${var.name}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.waf_logs_kms_key_arn
}

resource "aws_wafv2_web_acl_logging_configuration" "this" {
  provider = aws.us_east_1

  resource_arn            = aws_wafv2_web_acl.this.arn
  log_destination_configs = [aws_cloudwatch_log_group.waf.arn]

  redacted_fields {
    single_header {
      name = "authorization"
    }
  }
  redacted_fields {
    single_header {
      name = "cookie"
    }
  }
}

# --- Distribution -------------------------------------------------------------------------------
resource "aws_cloudfront_distribution" "this" {
  #checkov:skip=CKV_AWS_305:API host: the root path has no content, every route lives under /api/v1 or /video
  #checkov:skip=CKV_AWS_174:TLSv1.2_2021 is set whenever a custom domain certificate is attached; the default *.cloudfront.net certificate (staging before DNS delegation) cannot take a minimum version
  #checkov:skip=CKV_AWS_68:WAF is attached through web_acl_id (checkov cannot resolve the cross-region reference)
  #checkov:skip=CKV_AWS_86:Standard access logging is not enabled in staging; flat-rate plan forbids real-time logs
  #checkov:skip=CKV_AWS_310:A single ALB origin has no failover target; video has no replica bucket in Stage 1
  #checkov:skip=CKV_AWS_374:No geo restriction: Egypt is the main audience, learners travel and use VPNs
  #checkov:skip=CKV2_AWS_32:A response headers policy is attached to every behaviour
  #checkov:skip=CKV2_AWS_47:Log4j rule is in the web ACL KnownBadInputs managed group
  enabled         = true
  is_ipv6_enabled = true
  http_version    = "http2and3"
  comment         = var.name
  aliases         = local.custom_domain ? var.aliases : []
  price_class     = var.price_class
  web_acl_id      = aws_wafv2_web_acl.this.arn

  origin {
    origin_id   = local.alb_origin_id
    domain_name = var.alb_dns_name

    vpc_origin_config {
      vpc_origin_id            = aws_cloudfront_vpc_origin.alb.id
      origin_read_timeout      = 60
      origin_keepalive_timeout = 5
    }
  }

  dynamic "origin" {
    for_each = local.video_enabled ? [1] : []
    content {
      origin_id                = local.video_origin_id
      domain_name              = var.video_bucket.regional_domain_name
      origin_access_control_id = aws_cloudfront_origin_access_control.video[0].id
    }
  }

  # This distribution fronts the API host only (api.<domain>); the Next.js frontend is hosted on Vercel.
  # Public images served (and marked immutable) by the API media proxy.
  ordered_cache_behavior {
    path_pattern               = "/api/v1/media/public/*"
    target_origin_id           = local.alb_origin_id
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  # HLS output: reachable only with CloudFront signed cookies issued by the API after an access check.
  # The player runs on the Vercel origin and sends the cookies cross-origin (same site), so this
  # behaviour answers with an exact-origin credentialed CORS policy.
  dynamic "ordered_cache_behavior" {
    for_each = local.video_enabled ? [1] : []
    content {
      path_pattern               = "/video/*"
      target_origin_id           = local.video_origin_id
      viewer_protocol_policy     = "https-only"
      allowed_methods            = ["GET", "HEAD", "OPTIONS"]
      cached_methods             = ["GET", "HEAD"]
      compress                   = false
      cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
      response_headers_policy_id = aws_cloudfront_response_headers_policy.video[0].id
      trusted_key_groups         = [aws_cloudfront_key_group.video[0].id]
    }
  }

  # Everything else is the dynamic API: no caching, all headers, cookies and query strings forwarded
  # (the NestJS app answers CORS preflights itself, with its own exact-origin allowlist).
  default_cache_behavior {
    target_origin_id           = local.alb_origin_id
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn            = local.custom_domain ? var.acm_certificate_arn : null
    cloudfront_default_certificate = local.custom_domain ? null : true
    ssl_support_method             = local.custom_domain ? "sni-only" : null
    minimum_protocol_version       = local.custom_domain ? "TLSv1.2_2021" : null
  }
}

data "aws_iam_policy_document" "video_bucket" {
  count = local.video_enabled ? 1 : 0

  statement {
    sid       = "AllowCloudFrontServicePrincipalReadOnly"
    actions   = ["s3:GetObject"]
    resources = ["${var.video_bucket.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.this.arn]
    }
  }
}
