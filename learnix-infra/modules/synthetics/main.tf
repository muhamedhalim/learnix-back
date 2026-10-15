terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.7"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  partition  = data.aws_partition.current.partition
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region
  # Canary names: lowercase, max 21 characters.
  canary_name = substr(replace(lower("${var.name}-heartbeat"), "/[^a-z0-9_-]/", "-"), 0, 21)
}

# Newest Node.js/Puppeteer runtime at plan time, so the canary never sits on a deprecated runtime.
data "aws_synthetics_runtime_version" "node" {
  prefix = "syn-nodejs-puppeteer"
  latest = true
}

data "archive_file" "canary" {
  type        = "zip"
  output_path = "${path.module}/.build/${local.canary_name}.zip"

  source {
    content  = file("${path.module}/canary/index.js")
    filename = "nodejs/node_modules/heartbeat.js"
  }
}

module "artifacts" {
  source = "../s3-bucket"

  name              = "${var.name}-canary-artifacts-${local.account_id}"
  kms_key_arn       = var.kms_key_arn
  versioning        = false
  expire_after_days = var.artifact_retention_days
  force_destroy     = true
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "canary" {
  name               = "${var.name}-canary"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

# The minimum documented for a canary execution role: write artifacts, logs and its own metrics.
data "aws_iam_policy_document" "canary" {
  #checkov:skip=CKV_AWS_356:s3:ListAllMyBuckets/GetBucketLocation and xray:PutTraceSegments have no resource-level permissions; PutMetricData is pinned to the CloudWatchSynthetics namespace
  statement {
    sid       = "Artifacts"
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = ["${module.artifacts.arn}/*"]
  }
  statement {
    sid       = "ArtifactBucket"
    actions   = ["s3:GetBucketLocation", "s3:ListAllMyBuckets"]
    resources = ["*"]
  }
  statement {
    sid       = "ArtifactKey"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [var.kms_key_arn]
  }
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:/aws/lambda/cwsyn-*"]
  }
  statement {
    sid       = "Metrics"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["CloudWatchSynthetics"]
    }
  }
  statement {
    sid       = "Traces"
    actions   = ["xray:PutTraceSegments"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "canary" {
  name   = "canary-execution"
  role   = aws_iam_role.canary.id
  policy = data.aws_iam_policy_document.canary.json
}

resource "aws_synthetics_canary" "heartbeat" {
  name                 = local.canary_name
  artifact_s3_location = "s3://${module.artifacts.id}/"
  execution_role_arn   = aws_iam_role.canary.arn
  runtime_version      = data.aws_synthetics_runtime_version.node.version_name
  handler              = "heartbeat.handler"
  zip_file             = data.archive_file.canary.output_path
  start_canary         = var.start
  delete_lambda        = true

  success_retention_period = 7
  failure_retention_period = 31

  schedule {
    expression = "rate(${var.interval_minutes} minutes)"
  }

  run_config {
    timeout_in_seconds = 60
    active_tracing     = true
    environment_variables = {
      API_URL      = var.api_url
      FRONTEND_URL = coalesce(var.frontend_url, var.api_url)
      CHECKS       = jsonencode([for c in var.checks : c if c.target == "api" || var.frontend_url != null])
    }
  }

  artifact_config {
    s3_encryption {
      encryption_mode = "SSE_KMS"
      kms_key_arn     = var.kms_key_arn
    }
  }

  depends_on = [aws_iam_role_policy.canary]
}

resource "aws_cloudwatch_metric_alarm" "failed" {
  alarm_name          = "${var.name}-canary-failed"
  alarm_description   = "The ${local.canary_name} canary failed 2 of the last 3 runs: the API (or the Vercel frontend) is unreachable or a check regressed"
  namespace           = "CloudWatchSynthetics"
  metric_name         = "SuccessPercent"
  dimensions          = { CanaryName = aws_synthetics_canary.heartbeat.name }
  statistic           = "Average"
  period              = var.interval_minutes * 60
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = 100
  comparison_operator = "LessThanThreshold"
  # A stopped canary publishes nothing: that must not look like an outage (it would also roll back deploys).
  treat_missing_data = var.start ? "breaching" : "notBreaching"
  alarm_actions      = [var.alarm_topic_arn]
  ok_actions         = [var.alarm_topic_arn]
}
