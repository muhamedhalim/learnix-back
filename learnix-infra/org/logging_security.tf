# Stage 2 resources (need log_archive_account_id): org CloudTrail with its immutable-ish
# log bucket in the log-archive account, and GuardDuty with log-archive as delegated admin.

locals {
  trail_name = "${var.project}-org-trail"
  trail_arn  = "arn:aws:cloudtrail:${var.region}:${local.management_account_id}:trail/${local.trail_name}"
  log_bucket = "${var.project}-org-cloudtrail-${var.log_archive_account_id}"
}

# --- CloudTrail log bucket (log-archive account) ---------------------------
resource "aws_s3_bucket" "cloudtrail" {
  #checkov:skip=CKV_AWS_18:This is the audit-log bucket; logging it to itself adds no value
  #checkov:skip=CKV_AWS_144:Cross-region replication deferred to growth Stage 2
  #checkov:skip=CKV_AWS_145:SSE-S3 chosen to avoid a cross-account CMK policy; revisit in Stage 2
  #checkov:skip=CKV2_AWS_62:No event consumers for the log bucket
  count    = local.stage2 ? 1 : 0
  provider = aws.log_archive
  bucket   = local.log_bucket

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "cloudtrail" {
  count    = local.stage2 ? 1 : 0
  provider = aws.log_archive
  bucket   = aws_s3_bucket.cloudtrail[0].id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "cloudtrail" {
  count                   = local.stage2 ? 1 : 0
  provider                = aws.log_archive
  bucket                  = aws_s3_bucket.cloudtrail[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "cloudtrail" {
  count    = local.stage2 ? 1 : 0
  provider = aws.log_archive
  bucket   = aws_s3_bucket.cloudtrail[0].id

  versioning_configuration {
    status = "Enabled"
  }
}

# SSE-S3 on purpose: a CMK would need a cross-account key policy for CloudTrail.
# Revisit with a CMK in Stage 2 of the growth plan.
resource "aws_s3_bucket_server_side_encryption_configuration" "cloudtrail" {
  count    = local.stage2 ? 1 : 0
  provider = aws.log_archive
  bucket   = aws_s3_bucket.cloudtrail[0].id

  rule {
    bucket_key_enabled = true

    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "cloudtrail" {
  count    = local.stage2 ? 1 : 0
  provider = aws.log_archive
  bucket   = aws_s3_bucket.cloudtrail[0].id

  rule {
    id     = "retention"
    status = "Enabled"

    filter {}

    expiration {
      days = var.log_retention_days
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.cloudtrail]
}

data "aws_iam_policy_document" "cloudtrail_bucket" {
  count = local.stage2 ? 1 : 0

  statement {
    sid       = "AWSCloudTrailAclCheck"
    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.cloudtrail[0].arn]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.trail_arn]
    }
  }

  statement {
    sid     = "AWSCloudTrailWrite"
    actions = ["s3:PutObject"]
    resources = [
      "${aws_s3_bucket.cloudtrail[0].arn}/AWSLogs/${local.management_account_id}/*",
      "${aws_s3_bucket.cloudtrail[0].arn}/AWSLogs/${aws_organizations_organization.this.id}/*",
    ]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.trail_arn]
    }
  }

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.cloudtrail[0].arn, "${aws_s3_bucket.cloudtrail[0].arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "cloudtrail" {
  count    = local.stage2 ? 1 : 0
  provider = aws.log_archive
  bucket   = aws_s3_bucket.cloudtrail[0].id
  policy   = data.aws_iam_policy_document.cloudtrail_bucket[0].json

  depends_on = [aws_s3_bucket_public_access_block.cloudtrail]
}

# --- Organization trail (management account) -------------------------------
resource "aws_cloudtrail" "org" {
  #checkov:skip=CKV_AWS_35:Trail KMS needs a cross-account key policy; deferred to Stage 2 (log bucket is SSE-S3)
  #checkov:skip=CKV_AWS_252:No SNS consumers yet; GuardDuty and Budgets cover alerting
  #checkov:skip=CKV2_AWS_10:CloudWatch Logs delivery adds ingestion cost; S3 plus Athena is the audit path for now
  count = local.stage2 ? 1 : 0

  name                          = local.trail_name
  s3_bucket_name                = aws_s3_bucket.cloudtrail[0].id
  is_organization_trail         = true
  is_multi_region_trail         = true
  include_global_service_events = true
  enable_log_file_validation    = true

  depends_on = [
    aws_s3_bucket_policy.cloudtrail,
    aws_organizations_organization.this,
  ]
}

# --- GuardDuty: log-archive account is the delegated administrator -----------
resource "aws_guardduty_organization_admin_account" "this" {
  count            = local.stage2 ? 1 : 0
  admin_account_id = var.log_archive_account_id

  depends_on = [aws_organizations_organization.this]
}

resource "aws_guardduty_detector" "admin" {
  count    = local.stage2 ? 1 : 0
  provider = aws.log_archive
  enable   = true
}

# Foundational protection only; S3/EKS/malware features are cost-gated decisions (plan section 10).
resource "aws_guardduty_organization_configuration" "this" {
  count                            = local.stage2 ? 1 : 0
  provider                         = aws.log_archive
  detector_id                      = aws_guardduty_detector.admin[0].id
  auto_enable_organization_members = "ALL"

  depends_on = [aws_guardduty_organization_admin_account.this]
}

# --- IAM Access Analyzer across the organization ----------------------------
resource "aws_accessanalyzer_analyzer" "org" {
  analyzer_name = "${var.project}-org"
  type          = "ORGANIZATION"

  depends_on = [aws_organizations_organization.this]
}

# --- Account-level S3 Block Public Access (management account) --------------
resource "aws_s3_account_public_access_block" "management" {
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
