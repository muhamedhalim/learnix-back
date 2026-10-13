terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

# Private-by-default bucket: Block Public Access, TLS-only, bucket-owner-enforced, encrypted, versioned.
resource "aws_s3_bucket" "this" {
  #checkov:skip=CKV_AWS_18:Access logging is enabled only where var.access_log_bucket is set; staging keeps cost down
  #checkov:skip=CKV_AWS_144:Cross-region replication is a Stage 2 item (plan section 7)
  #checkov:skip=CKV2_AWS_62:Event notifications are not needed on this bucket
  #checkov:skip=CKV_AWS_21:Versioning is a deliberate per-bucket choice (var.versioning); reproducible outputs are not versioned
  bucket        = var.name
  force_destroy = var.force_destroy
}

resource "aws_s3_bucket_public_access_block" "this" {
  bucket                  = aws_s3_bucket.this.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = var.kms_key_arn == null ? "AES256" : "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
    bucket_key_enabled = var.kms_key_arn == null ? null : true
  }
}

resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id
  versioning_configuration {
    status = var.versioning ? "Enabled" : "Suspended"
  }
}

resource "aws_s3_bucket_logging" "this" {
  count = var.access_logging_enabled ? 1 : 0

  bucket        = aws_s3_bucket.this.id
  target_bucket = var.access_log_bucket
  target_prefix = "s3/${var.name}/"
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  #checkov:skip=CKV_AWS_300:The abort-incomplete-multipart rule (7 days) is defined below; the checker does not follow the mixed static/dynamic rules
  bucket = aws_s3_bucket.this.id

  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  dynamic "rule" {
    for_each = var.versioning ? [1] : []
    content {
      id     = "expire-noncurrent-versions"
      status = "Enabled"
      filter {}
      noncurrent_version_expiration {
        noncurrent_days = var.noncurrent_version_days
      }
    }
  }

  dynamic "rule" {
    for_each = var.glacier_after_days == null ? [] : [1]
    content {
      id     = "archive-to-glacier"
      status = "Enabled"
      filter {}
      transition {
        days          = var.glacier_after_days
        storage_class = "GLACIER"
      }
    }
  }

  dynamic "rule" {
    for_each = var.expire_after_days == null ? [] : [1]
    content {
      id     = "expire-objects"
      status = "Enabled"
      filter {}
      expiration {
        days = var.expire_after_days
      }
    }
  }

  depends_on = [aws_s3_bucket_versioning.this]
}

resource "aws_s3_bucket_cors_configuration" "this" {
  count = length(var.cors_allowed_origins) == 0 ? 0 : 1

  bucket = aws_s3_bucket.this.id
  cors_rule {
    allowed_origins = var.cors_allowed_origins
    allowed_methods = var.cors_allowed_methods
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

data "aws_iam_policy_document" "this" {
  source_policy_documents = var.extra_policy_documents

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.this.arn, "${aws_s3_bucket.this.arn}/*"]

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

resource "aws_s3_bucket_policy" "this" {
  bucket = aws_s3_bucket.this.id
  policy = data.aws_iam_policy_document.this.json

  depends_on = [aws_s3_bucket_public_access_block.this]
}
