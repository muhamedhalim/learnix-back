# IAM Identity Center must be enabled once in the console (organization instance, in
# the primary region). Users are created or synced there; this file manages groups,
# permission sets and assignments only. No IAM users or access keys exist anywhere.

data "aws_ssoadmin_instances" "this" {}

locals {
  sso_instance_arn  = tolist(data.aws_ssoadmin_instances.this.arns)[0]
  identity_store_id = tolist(data.aws_ssoadmin_instances.this.identity_store_ids)[0]
  # Keys must be known at plan time, so assignments are keyed by logical name, never by account ID.
  member_accounts = {
    log_archive = aws_organizations_account.log_archive.id
    staging     = aws_organizations_account.staging.id
    production  = aws_organizations_account.production.id
  }

  groups = {
    platform-admins = "Full administration of all accounts (use sparingly; MFA enforced in Identity Center)."
    read-only       = "Read-only access to workload and log-archive accounts."
    billing         = "Billing and cost access in the management account."
  }

  permission_sets = {
    PlatformAdmin = {
      description = "Administrator access"
      duration    = "PT4H"
      policy_arn  = "arn:aws:iam::aws:policy/AdministratorAccess"
    }
    ReadOnly = {
      description = "Read-only access"
      duration    = "PT8H"
      policy_arn  = "arn:aws:iam::aws:policy/ReadOnlyAccess"
    }
    Billing = {
      description = "Billing and cost access"
      duration    = "PT4H"
      policy_arn  = "arn:aws:iam::aws:policy/job-function/Billing"
    }
  }

  assignments = merge(
    { for name, id in local.member_accounts : "platform-admins-PlatformAdmin-${name}" => { group = "platform-admins", ps = "PlatformAdmin", account = id } },
    { "platform-admins-PlatformAdmin-mgmt" = { group = "platform-admins", ps = "PlatformAdmin", account = local.management_account_id } },
    { for name, id in local.member_accounts : "read-only-ReadOnly-${name}" => { group = "read-only", ps = "ReadOnly", account = id } },
    { "billing-Billing-mgmt" = { group = "billing", ps = "Billing", account = local.management_account_id } },
  )
}

resource "aws_identitystore_group" "this" {
  for_each          = local.groups
  identity_store_id = local.identity_store_id
  display_name      = "${var.project}-${each.key}"
  description       = each.value
}

resource "aws_ssoadmin_permission_set" "this" {
  for_each         = local.permission_sets
  instance_arn     = local.sso_instance_arn
  name             = each.key
  description      = each.value.description
  session_duration = each.value.duration
}

resource "aws_ssoadmin_managed_policy_attachment" "this" {
  #checkov:skip=CKV_AWS_274:PlatformAdmin is the deliberate break-glass administrator permission set (4 h session, MFA enforced)
  for_each           = local.permission_sets
  instance_arn       = local.sso_instance_arn
  permission_set_arn = aws_ssoadmin_permission_set.this[each.key].arn
  managed_policy_arn = each.value.policy_arn
}

resource "aws_ssoadmin_account_assignment" "this" {
  for_each = local.assignments

  instance_arn       = local.sso_instance_arn
  permission_set_arn = aws_ssoadmin_permission_set.this[each.value.ps].arn
  principal_id       = aws_identitystore_group.this[each.value.group].group_id
  principal_type     = "GROUP"
  target_id          = each.value.account
  target_type        = "AWS_ACCOUNT"

  depends_on = [aws_ssoadmin_managed_policy_attachment.this]
}
