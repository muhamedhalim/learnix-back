terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id    = data.aws_caller_identity.current.account_id
  region        = data.aws_region.current.region
  domain        = var.domain
  identity      = local.domain != null
  publish_roles = { ses = "ses.amazonaws.com", sms = "sms-voice.amazonaws.com" }
}

# --- Delivery feedback plumbing: service -> SNS -> SQS (+ DLQ), consumed by the worker ---------------
resource "aws_sns_topic" "feed" {
  for_each = local.publish_roles

  name              = "${var.name}-${each.key}-events"
  kms_master_key_id = var.kms_key_arn
}

data "aws_iam_policy_document" "topic" {
  for_each = local.publish_roles

  statement {
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.feed[each.key].arn]

    principals {
      type        = "Service"
      identifiers = [each.value]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "feed" {
  for_each = local.publish_roles

  arn    = aws_sns_topic.feed[each.key].arn
  policy = data.aws_iam_policy_document.topic[each.key].json
}

resource "aws_sqs_queue" "dlq" {
  #checkov:skip=CKV_AWS_27:Encrypted with SQS-managed SSE (SNS cannot deliver to a queue under a CMK it has no grant on)
  for_each = local.publish_roles

  name                      = "${var.name}-${each.key}-events-dlq"
  sqs_managed_sse_enabled   = true
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "feed" {
  #checkov:skip=CKV_AWS_27:Encrypted with SQS-managed SSE, see the DLQ
  for_each = local.publish_roles

  name                       = "${var.name}-${each.key}-events"
  sqs_managed_sse_enabled    = true
  visibility_timeout_seconds = 60
  message_retention_seconds  = 345600
  receive_wait_time_seconds  = 20

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq[each.key].arn
    maxReceiveCount     = 5
  })
}

data "aws_iam_policy_document" "queue" {
  for_each = local.publish_roles

  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.feed[each.key].arn]

    principals {
      type        = "Service"
      identifiers = ["sns.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_sns_topic.feed[each.key].arn]
    }
  }
}

resource "aws_sqs_queue_policy" "feed" {
  for_each = local.publish_roles

  queue_url = aws_sqs_queue.feed[each.key].url
  policy    = data.aws_iam_policy_document.queue[each.key].json
}

resource "aws_sns_topic_subscription" "feed" {
  for_each = local.publish_roles

  topic_arn            = aws_sns_topic.feed[each.key].arn
  protocol             = "sqs"
  endpoint             = aws_sqs_queue.feed[each.key].arn
  raw_message_delivery = true
}

# --- SES -----------------------------------------------------------------------------------------
resource "aws_sesv2_configuration_set" "this" {
  configuration_set_name = var.name

  delivery_options {
    tls_policy = "REQUIRE"
  }
  reputation_options {
    reputation_metrics_enabled = true
  }
  sending_options {
    sending_enabled = true
  }
  suppression_options {
    suppressed_reasons = ["BOUNCE", "COMPLAINT"]
  }
}

resource "aws_sesv2_configuration_set_event_destination" "feedback" {
  configuration_set_name = aws_sesv2_configuration_set.this.configuration_set_name
  event_destination_name = "feedback-to-sns"

  event_destination {
    enabled              = true
    matching_event_types = ["BOUNCE", "COMPLAINT", "REJECT", "DELIVERY_DELAY"]

    sns_destination {
      topic_arn = aws_sns_topic.feed["ses"].arn
    }
  }

  depends_on = [aws_sns_topic_policy.feed]
}

# Domain identity with Easy DKIM and a custom MAIL FROM (SPF/DMARC alignment). Created only when the
# environment owns a domain; until then SES stays in sandbox with individually verified addresses.
resource "aws_sesv2_email_identity" "domain" {
  count = local.identity ? 1 : 0

  email_identity         = local.domain
  configuration_set_name = aws_sesv2_configuration_set.this.configuration_set_name

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

resource "aws_sesv2_email_identity_mail_from_attributes" "domain" {
  count = local.identity ? 1 : 0

  email_identity         = aws_sesv2_email_identity.domain[0].email_identity
  mail_from_domain       = "bounce.${local.domain}"
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}

resource "aws_route53_record" "dkim" {
  count = local.identity && var.manage_dns_records ? 3 : 0

  zone_id = var.zone_id
  name    = "${aws_sesv2_email_identity.domain[0].dkim_signing_attributes[0].tokens[count.index]}._domainkey.${local.domain}"
  type    = "CNAME"
  ttl     = 600
  records = ["${aws_sesv2_email_identity.domain[0].dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}

resource "aws_route53_record" "mail_from_mx" {
  count = local.identity && var.manage_dns_records ? 1 : 0

  zone_id = var.zone_id
  name    = "bounce.${local.domain}"
  type    = "MX"
  ttl     = 600
  records = ["10 feedback-smtp.${local.region}.amazonses.com"]
}

resource "aws_route53_record" "mail_from_spf" {
  count = local.identity && var.manage_dns_records ? 1 : 0

  zone_id = var.zone_id
  name    = "bounce.${local.domain}"
  type    = "TXT"
  ttl     = 600
  records = ["v=spf1 include:amazonses.com ~all"]
}

resource "aws_route53_record" "dmarc" {
  count = local.identity && var.manage_dns_records ? 1 : 0

  zone_id = var.zone_id
  name    = "_dmarc.${local.domain}"
  type    = "TXT"
  ttl     = 600
  records = ["v=DMARC1; p=${var.dmarc_policy}"]
}

# --- SMS (AWS End User Messaging) ---------------------------------------------------------------
# The sender ID needs a registration approved by AWS (manual, see docs), the Egypt-only protect
# configuration has no Terraform resource yet (manual step), and the app also enforces +20 itself.
resource "aws_pinpointsmsvoicev2_configuration_set" "sms" {
  name                 = var.name
  default_message_type = "TRANSACTIONAL"
}

resource "aws_pinpointsmsvoicev2_event_destination" "sms" {
  configuration_set_name = aws_pinpointsmsvoicev2_configuration_set.sms.name
  event_destination_name = "delivery-to-sns"
  matching_event_types   = ["TEXT_SUCCESSFUL", "TEXT_DELIVERED", "TEXT_BLOCKED", "TEXT_CARRIER_UNREACHABLE", "TEXT_INVALID", "TEXT_UNREACHABLE", "TEXT_TTL_EXPIRED", "TEXT_UNKNOWN"]

  sns_destination {
    topic_arn = aws_sns_topic.feed["sms"].arn
  }

  depends_on = [aws_sns_topic_policy.feed]
}
