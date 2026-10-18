# Terraform state for an environment that shares its AWS account with another environment's bootstrap/.
# Creates ONLY the state bucket and its KMS key (no OIDC provider, no CI roles), so it never collides with
# the roles the staging bootstrap owns in the same account (learnix-gha-plan / learnix-gha-apply).
# First apply runs with local state; afterwards the state is migrated into the bucket it created
# (see README.md in this directory).
terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = local.tags
  }
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
  bucket     = "${var.project}-${var.environment}-tfstate-${local.account_id}"

  tags = {
    Project     = var.project
    Environment = var.environment
    Component   = "bootstrap"
    Owner       = var.owner
    CostCenter  = var.cost_center
    DataClass   = "internal"
    ManagedBy   = "terraform"
  }
}

check "expected_account" {
  assert {
    condition     = local.account_id == var.expected_account_id
    error_message = "Wrong AWS account: credentials resolve to ${local.account_id}, expected ${var.expected_account_id}."
  }
}

data "aws_iam_policy_document" "state_key" {
  #checkov:skip=CKV_AWS_109:Standard KMS root-delegation statement; access is then governed by IAM policies
  #checkov:skip=CKV_AWS_111:Standard KMS root-delegation statement, see above
  #checkov:skip=CKV_AWS_356:Key policies must use resource "*" (the key itself)
  statement {
    sid       = "EnableIamPolicies"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${local.account_id}:root"]
    }
  }
}

resource "aws_kms_key" "state" {
  description             = "${var.project}-${var.environment} Terraform state"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.state_key.json

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "state" {
  name          = "alias/${var.project}-${var.environment}-tfstate"
  target_key_id = aws_kms_key.state.key_id
}

resource "aws_s3_bucket" "state" {
  #checkov:skip=CKV_AWS_18:Access logging deferred; object history is covered by versioning
  #checkov:skip=CKV_AWS_144:Cross-region replication deferred; state is recreatable from code plus imports
  #checkov:skip=CKV2_AWS_62:No event consumers for the state bucket
  bucket = local.bucket

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    bucket_key_enabled = true

    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.state.arn
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    id     = "expire-noncurrent-and-abort-multipart"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 90
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.state]
}

data "aws_iam_policy_document" "state_bucket" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]

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

  # The account's read-only CI plan role (owned by another environment's bootstrap) must not read this state.
  dynamic "statement" {
    for_each = length(var.deny_read_role_names) > 0 ? [1] : []

    content {
      sid       = "DenyOtherEnvironmentCiRoles"
      effect    = "Deny"
      actions   = ["s3:*"]
      resources = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]

      principals {
        type        = "AWS"
        identifiers = ["*"]
      }

      condition {
        test     = "ArnLike"
        variable = "aws:PrincipalArn"
        values   = [for r in var.deny_read_role_names : "arn:${local.partition}:iam::${local.account_id}:role/${r}"]
      }
    }
  }
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = data.aws_iam_policy_document.state_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.state]
}

variable "region" {
  type    = string
  default = "eu-central-1"
}

variable "project" {
  type    = string
  default = "learnix"
}

variable "environment" {
  type = string

  validation {
    condition     = var.environment == "production"
    error_message = "bootstrap-state is only for production (staging owns bootstrap/ in this account)."
  }
}

variable "expected_account_id" {
  type = string
}

variable "deny_read_role_names" {
  description = "IAM role names in this account (belonging to other environments) denied all access to this state bucket."
  type        = list(string)
  default     = []
}

variable "owner" {
  type    = string
  default = "platform"
}

variable "cost_center" {
  type    = string
  default = "learnix"
}

output "state_bucket" {
  value = aws_s3_bucket.state.id
}

output "state_kms_key_arn" {
  value = aws_kms_key.state.arn
}

output "backend_hcl" {
  description = "Contents for environments/production/backend.hcl."
  value       = <<-EOT
    bucket       = "${aws_s3_bucket.state.id}"
    region       = "${var.region}"
    encrypt      = true
    kms_key_id   = "${aws_kms_key.state.arn}"
    use_lockfile = true
  EOT
}
