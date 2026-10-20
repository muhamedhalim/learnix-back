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

locals {
  partition = data.aws_partition.current.partition
  root_arn  = "arn:${local.partition}:iam::${data.aws_caller_identity.current.account_id}:root"
}

resource "aws_backup_vault" "this" {
  name          = "${var.name}-vault"
  kms_key_arn   = var.kms_key_arn
  force_destroy = var.force_destroy
}

# Recovery points can only be deleted by the root user (break-glass), not by any role, including the
# Terraform apply role. Lifecycle expiry by AWS Backup itself is unaffected.
data "aws_iam_policy_document" "vault" {
  count = var.deny_delete ? 1 : 0

  statement {
    sid    = "DenyRecoveryPointDeletion"
    effect = "Deny"
    actions = [
      "backup:DeleteRecoveryPoint",
      "backup:UpdateRecoveryPointLifecycle",
      "backup:PutBackupVaultAccessPolicy",
      "backup:DeleteBackupVaultAccessPolicy",
    ]
    resources = [aws_backup_vault.this.arn]

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
    condition {
      test     = "StringNotEquals"
      variable = "aws:PrincipalArn"
      values   = [local.root_arn]
    }
  }
}

resource "aws_backup_vault_policy" "this" {
  count = var.deny_delete ? 1 : 0

  backup_vault_name = aws_backup_vault.this.name
  policy            = data.aws_iam_policy_document.vault[0].json
}

# --- Plan (source region only) --------------------------------------------------------------------
data "aws_iam_policy_document" "assume" {
  count = var.create_plan ? 1 : 0

  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["backup.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "backup" {
  count = var.create_plan ? 1 : 0

  name               = "${var.name}-backup"
  assume_role_policy = data.aws_iam_policy_document.assume[0].json
}

resource "aws_iam_role_policy_attachment" "backup" {
  # The S3 policies are published at the policy root; the other two under service-role/.
  for_each = var.create_plan ? {
    AWSBackupServiceRolePolicyForBackup    = "service-role/"
    AWSBackupServiceRolePolicyForRestores  = "service-role/"
    AWSBackupServiceRolePolicyForS3Backup  = ""
    AWSBackupServiceRolePolicyForS3Restore = ""
  } : {}

  role       = aws_iam_role.backup[0].name
  policy_arn = "arn:${local.partition}:iam::aws:policy/${each.value}${each.key}"
}

resource "aws_backup_plan" "this" {
  count = var.create_plan ? 1 : 0

  name = "${var.name}-plan"

  rule {
    rule_name         = "daily"
    target_vault_name = aws_backup_vault.this.name
    schedule          = "cron(0 2 * * ? *)"
    start_window      = 60
    completion_window = 360

    lifecycle {
      delete_after = var.daily_retention_days
    }

    dynamic "copy_action" {
      for_each = var.copy_destination_vault_arn == null ? [] : [1]
      content {
        destination_vault_arn = var.copy_destination_vault_arn
        lifecycle {
          delete_after = var.copy_retention_days
        }
      }
    }
  }

  dynamic "rule" {
    for_each = var.monthly_retention_days > 0 ? [1] : []
    content {
      rule_name         = "monthly"
      target_vault_name = aws_backup_vault.this.name
      schedule          = "cron(0 3 1 * ? *)"
      start_window      = 60
      completion_window = 720

      lifecycle {
        delete_after = var.monthly_retention_days
      }
    }
  }
}

resource "aws_backup_selection" "this" {
  count = var.create_plan ? 1 : 0

  name         = "${var.name}-resources"
  plan_id      = aws_backup_plan.this[0].id
  iam_role_arn = aws_iam_role.backup[0].arn
  resources    = var.resource_arns

  depends_on = [aws_iam_role_policy_attachment.backup]
}
