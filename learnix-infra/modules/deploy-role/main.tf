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
  partition  = data.aws_partition.current.partition
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region

  service_arns = [for s in var.service_names : "arn:${local.partition}:ecs:${local.region}:${local.account_id}:service/${var.cluster_name}/${s}"]
  # Task definition ARNs end in :<revision>; the families are fixed by Terraform.
  task_definition_arns = [for f in var.task_definition_families : "arn:${local.partition}:ecs:${local.region}:${local.account_id}:task-definition/${f}:*"]
}

# GitHub Actions in one application repository, and only in jobs bound to the GitHub environment named
# var.github_environment (which carries the required reviewers), may assume this role.
data "aws_iam_policy_document" "trust" {
  #checkov:skip=CKV_AWS_358:The subject is pinned to one repository and one GitHub environment (repo:OWNER/REPO:environment:NAME); checkov cannot resolve var.github_repository, which the variable validation restricts to OWNER/REPO
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = ["arn:${local.partition}:iam::${local.account_id}:oidc-provider/token.actions.githubusercontent.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:environment:${var.github_environment}"]
    }
  }
}

resource "aws_iam_role" "this" {
  name                 = var.name
  assume_role_policy   = data.aws_iam_policy_document.trust.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "deploy" {
  #checkov:skip=CKV_AWS_356:"*" only on actions without resource-level permissions (ecr:GetAuthorizationToken, ecs:RegisterTaskDefinition/DescribeTaskDefinition, cloudwatch:DescribeAlarms, rds:DescribeDBSnapshots) or narrowed by the ecs:cluster condition
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid = "PushOwnImages"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeImages",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
    resources = var.ecr_repository_arns
  }
  statement {
    sid = "ReadTaskDefinitions"
    # Neither action supports resource-level permissions.
    actions   = ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition"]
    resources = ["*"]
  }
  statement {
    sid       = "RollServices"
    actions   = ["ecs:DescribeServices", "ecs:UpdateService"]
    resources = local.service_arns
  }
  statement {
    sid       = "RunOneShotTasks"
    actions   = ["ecs:RunTask"]
    resources = local.task_definition_arns
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [var.cluster_arn]
    }
  }
  statement {
    sid       = "WatchTasks"
    actions   = ["ecs:DescribeTasks", "ecs:ListTasks"]
    resources = ["*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [var.cluster_arn]
    }
  }
  statement {
    sid       = "PassOnlyTheseTaskRoles"
    actions   = ["iam:PassRole"]
    resources = var.pass_role_arns
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
  statement {
    sid       = "ReadOneShotLogs"
    actions   = ["logs:GetLogEvents", "logs:FilterLogEvents"]
    resources = [for g in var.log_group_names : "arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:${g}:*"]
  }
  statement {
    sid       = "CheckAlarmsAfterDeploy"
    actions   = ["cloudwatch:DescribeAlarms"]
    resources = ["*"]
  }

  dynamic "statement" {
    for_each = var.db_instance_arn == null ? [] : [1]
    content {
      sid       = "PreDeploySnapshot"
      actions   = ["rds:CreateDBSnapshot", "rds:AddTagsToResource"]
      resources = [var.db_instance_arn, "arn:${local.partition}:rds:${local.region}:${local.account_id}:snapshot:pre-deploy-*"]
    }
  }
  dynamic "statement" {
    for_each = var.db_instance_arn == null ? [] : [1]
    content {
      sid       = "WatchSnapshot"
      actions   = ["rds:DescribeDBSnapshots"]
      resources = ["*"]
    }
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "deploy"
  role   = aws_iam_role.this.id
  policy = data.aws_iam_policy_document.deploy.json
}
