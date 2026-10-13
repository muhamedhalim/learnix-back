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

locals {
  account_id = data.aws_caller_identity.current.account_id
}

# Originals (MediaConvert input). Browsers upload straight here with presigned multipart URLs.
# SSE-S3 so MediaConvert needs no KMS grant; moved to Glacier after var.source_glacier_after_days
# so a failed or changed ladder can be re-run from the source without paying Standard storage.
module "source" {
  source = "../s3-bucket"

  name                   = "${var.name}-video-source-${local.account_id}"
  versioning             = false
  glacier_after_days     = var.source_glacier_after_days
  expire_after_days      = var.source_expire_after_days
  force_destroy          = var.force_destroy
  cors_allowed_origins   = var.upload_origins
  access_logging_enabled = var.access_logging_enabled
  access_log_bucket      = var.access_log_bucket
}

# HLS renditions and posters (CloudFront OAC reads them). Reproducible from the source, so no versioning.
module "output" {
  source = "../s3-bucket"

  name                   = "${var.name}-video-output-${local.account_id}"
  versioning             = false
  force_destroy          = var.force_destroy
  extra_policy_documents = var.output_bucket_policy_documents
  access_logging_enabled = var.access_logging_enabled
  access_log_bucket      = var.access_log_bucket
}

# --- Role MediaConvert assumes -------------------------------------------------------------------
data "aws_iam_policy_document" "mediaconvert_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["mediaconvert.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

data "aws_iam_policy_document" "mediaconvert" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${module.source.arn}/*"]
  }
  statement {
    actions   = ["s3:PutObject"]
    resources = ["${module.output.arn}/*"]
  }
}

resource "aws_iam_role" "mediaconvert" {
  name               = "${var.name}-mediaconvert"
  assume_role_policy = data.aws_iam_policy_document.mediaconvert_assume.json
}

resource "aws_iam_role_policy" "mediaconvert" {
  name   = "source-read-output-write"
  role   = aws_iam_role.mediaconvert.id
  policy = data.aws_iam_policy_document.mediaconvert.json
}

# --- Job state changes -> SQS (the app consumes them; a 5-minute reconcile cron is the fallback) ----
resource "aws_sqs_queue" "dlq" {
  #checkov:skip=CKV_AWS_27:Encrypted with SQS-managed SSE; a CMK would need an EventBridge grant for no extra protection of job metadata
  name                      = "${var.name}-media-events-dlq"
  sqs_managed_sse_enabled   = true
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "events" {
  #checkov:skip=CKV_AWS_27:Encrypted with SQS-managed SSE, see the DLQ
  name                       = "${var.name}-media-events"
  sqs_managed_sse_enabled    = true
  visibility_timeout_seconds = 120
  message_retention_seconds  = 345600
  receive_wait_time_seconds  = 20

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_cloudwatch_event_rule" "job_state" {
  name        = "${var.name}-mediaconvert-job-state"
  description = "Terminal MediaConvert job states for Learnix video assets"

  event_pattern = jsonencode({
    source        = ["aws.mediaconvert"]
    "detail-type" = ["MediaConvert Job State Change"]
    detail        = { status = ["COMPLETE", "ERROR", "CANCELED"] }
  })
}

resource "aws_cloudwatch_event_target" "job_state" {
  rule = aws_cloudwatch_event_rule.job_state.name
  arn  = aws_sqs_queue.events.arn
}

data "aws_iam_policy_document" "events_queue" {
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.events.arn]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.job_state.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "events" {
  queue_url = aws_sqs_queue.events.url
  policy    = data.aws_iam_policy_document.events_queue.json
}
