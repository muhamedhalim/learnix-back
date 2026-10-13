terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

# CloudWatch RUM replaces Vercel Analytics and Sentry's browser capture (errors, page views, web
# vitals, failed fetches). The browser authenticates as an unauthenticated Cognito guest whose role
# can do exactly one thing: PutRumEvents to this app monitor.

resource "aws_cognito_identity_pool" "rum" {
  #checkov:skip=CKV_AWS_366:Browser RUM must send events before login; the guest role can only call rum:PutRumEvents on this one app monitor
  identity_pool_name               = "${var.name}-rum"
  allow_unauthenticated_identities = true
  # aws-rum-web uses the basic (classic) flow: GetId -> GetOpenIdToken -> AssumeRoleWithWebIdentity.
  allow_classic_flow = true
}

data "aws_iam_policy_document" "guest_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = ["cognito-identity.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "cognito-identity.amazonaws.com:aud"
      values   = [aws_cognito_identity_pool.rum.id]
    }
    condition {
      test     = "ForAnyValue:StringLike"
      variable = "cognito-identity.amazonaws.com:amr"
      values   = ["unauthenticated"]
    }
  }
}

resource "aws_iam_role" "guest" {
  name               = "${var.name}-rum-guest"
  assume_role_policy = data.aws_iam_policy_document.guest_assume.json
}

resource "aws_rum_app_monitor" "this" {
  name           = var.name
  domain         = var.domain
  cw_log_enabled = var.store_events_in_logs

  app_monitor_configuration {
    allow_cookies       = true
    enable_xray         = var.enable_xray
    identity_pool_id    = aws_cognito_identity_pool.rum.id
    guest_role_arn      = aws_iam_role.guest.arn
    session_sample_rate = var.session_sample_rate
    telemetries         = ["errors", "performance", "http"]
    excluded_pages      = var.excluded_pages
  }
}

data "aws_iam_policy_document" "guest" {
  statement {
    actions   = ["rum:PutRumEvents"]
    resources = [aws_rum_app_monitor.this.arn]
  }
}

resource "aws_iam_role_policy" "guest" {
  name   = "put-rum-events"
  role   = aws_iam_role.guest.id
  policy = data.aws_iam_policy_document.guest.json
}

resource "aws_cognito_identity_pool_roles_attachment" "rum" {
  identity_pool_id = aws_cognito_identity_pool.rum.id
  roles = {
    unauthenticated = aws_iam_role.guest.arn
  }
}

# Alarm on a jump in browser JavaScript errors (RUM's own metric).
resource "aws_cloudwatch_metric_alarm" "js_errors" {
  count = var.alarm_enabled ? 1 : 0

  alarm_name          = "${var.name}-browser-js-errors"
  alarm_description   = "More than ${var.js_error_threshold} JavaScript errors reported by browsers in 15 minutes"
  namespace           = "AWS/RUM"
  metric_name         = "JsErrorCount"
  dimensions          = { application_name = aws_rum_app_monitor.this.name }
  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 1
  threshold           = var.js_error_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
}

data "aws_region" "current" {}
