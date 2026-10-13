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
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
  region     = data.aws_region.current.region
}

# Account root delegates to IAM (access is then governed by IAM policies on the callers); AWS services
# are granted only what they need to write encrypted data on our behalf.
data "aws_iam_policy_document" "this" {
  #checkov:skip=CKV_AWS_109:Standard KMS root-delegation statement; access is governed by IAM policies
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

  dynamic "statement" {
    for_each = var.allow_cloudwatch_logs ? [1] : []
    content {
      sid       = "AllowCloudWatchLogs"
      actions   = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
      resources = ["*"]

      principals {
        type        = "Service"
        identifiers = ["logs.${local.region}.amazonaws.com"]
      }
      condition {
        test     = "ArnLike"
        variable = "kms:EncryptionContext:aws:logs:arn"
        values   = ["arn:${local.partition}:logs:${local.region}:${local.account_id}:*"]
      }
    }
  }

  dynamic "statement" {
    for_each = length(var.service_principals) > 0 ? [1] : []
    content {
      sid       = "AllowServicesInThisAccount"
      actions   = ["kms:Decrypt", "kms:GenerateDataKey*"]
      resources = ["*"]

      principals {
        type        = "Service"
        identifiers = var.service_principals
      }
      condition {
        test     = "StringEquals"
        variable = "aws:SourceAccount"
        values   = [local.account_id]
      }
    }
  }
}

resource "aws_kms_key" "this" {
  description             = var.description
  enable_key_rotation     = true
  deletion_window_in_days = var.deletion_window_in_days
  policy                  = data.aws_iam_policy_document.this.json
}

resource "aws_kms_alias" "this" {
  name          = "alias/${var.name}"
  target_key_id = aws_kms_key.this.key_id
}
