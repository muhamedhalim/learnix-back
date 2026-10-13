# The Organization is normally created in the console when the management account is
# set up. Import it before the first apply:
#   terraform import aws_organizations_organization.this <org-id>
resource "aws_organizations_organization" "this" {
  feature_set          = "ALL"
  enabled_policy_types = ["SERVICE_CONTROL_POLICY"]

  aws_service_access_principals = [
    "access-analyzer.amazonaws.com",
    "backup.amazonaws.com",
    "cloudtrail.amazonaws.com",
    "guardduty.amazonaws.com",
    "malware-protection.guardduty.amazonaws.com",
    "sso.amazonaws.com",
  ]

  lifecycle {
    prevent_destroy = true
  }
}

locals {
  root_id = aws_organizations_organization.this.roots[0].id
}

resource "aws_organizations_organizational_unit" "security" {
  name      = "Security"
  parent_id = local.root_id
}

resource "aws_organizations_organizational_unit" "workloads" {
  name      = "Workloads"
  parent_id = local.root_id
}

resource "aws_organizations_account" "log_archive" {
  name                       = "${var.project}-log-archive"
  email                      = var.account_emails.log_archive
  parent_id                  = aws_organizations_organizational_unit.security.id
  iam_user_access_to_billing = "DENY"

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [role_name, iam_user_access_to_billing]
  }
}

resource "aws_organizations_account" "staging" {
  name                       = "${var.project}-staging"
  email                      = var.account_emails.staging
  parent_id                  = aws_organizations_organizational_unit.workloads.id
  iam_user_access_to_billing = "DENY"

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [role_name, iam_user_access_to_billing]
  }
}

resource "aws_organizations_account" "production" {
  name                       = "${var.project}-prod"
  email                      = var.account_emails.production
  parent_id                  = aws_organizations_organizational_unit.workloads.id
  iam_user_access_to_billing = "DENY"

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [role_name, iam_user_access_to_billing]
  }
}
