# Service control policies. They never apply to the management account itself,
# which is why that account hosts no workloads.

data "aws_iam_policy_document" "region_allowlist" {
  statement {
    sid    = "DenyOutsideAllowedRegions"
    effect = "Deny"

    # Global services that have no regional endpoint in the allowed set.
    not_actions = [
      "account:*",
      "billing:*",
      "budgets:*",
      "ce:*",
      "cloudfront:*",
      "cur:*",
      "globalaccelerator:*",
      "health:*",
      "iam:*",
      "organizations:*",
      "payments:*",
      "route53:*",
      "route53domains:*",
      "shield:*",
      "sts:*",
      "support:*",
      "tax:*",
      "trustedadvisor:*",
      "waf:*",
    ]

    resources = ["*"]

    condition {
      test     = "StringNotEquals"
      variable = "aws:RequestedRegion"
      values   = var.allowed_regions
    }
  }
}

data "aws_iam_policy_document" "guardrails" {
  statement {
    sid       = "DenyRootUser"
    effect    = "Deny"
    actions   = ["*"]
    resources = ["*"]

    condition {
      test     = "StringLike"
      variable = "aws:PrincipalArn"
      values   = ["arn:aws:iam::*:root"]
    }
  }

  statement {
    sid       = "DenyLeavingOrganization"
    effect    = "Deny"
    actions   = ["organizations:LeaveOrganization"]
    resources = ["*"]
  }

  statement {
    sid    = "DenyAuditAndSecurityTampering"
    effect = "Deny"
    actions = [
      "access-analyzer:DeleteAnalyzer",
      "cloudtrail:DeleteTrail",
      "cloudtrail:PutEventSelectors",
      "cloudtrail:StopLogging",
      "cloudtrail:UpdateTrail",
      "config:DeleteConfigurationRecorder",
      "config:StopConfigurationRecorder",
      "ec2:DisableEbsEncryptionByDefault",
      "guardduty:DeleteDetector",
      "guardduty:DisassociateFromMasterAccount",
      "guardduty:StopMonitoringMembers",
    ]
    resources = ["*"]
  }
}

resource "aws_organizations_policy" "region_allowlist" {
  name        = "${var.project}-region-allowlist"
  description = "Deny API calls outside the approved regions."
  type        = "SERVICE_CONTROL_POLICY"
  content     = data.aws_iam_policy_document.region_allowlist.json
}

resource "aws_organizations_policy" "guardrails" {
  name        = "${var.project}-guardrails"
  description = "No root usage, no leaving the org, no tampering with audit/security services."
  type        = "SERVICE_CONTROL_POLICY"
  content     = data.aws_iam_policy_document.guardrails.json
}

locals {
  scp_targets = {
    security  = aws_organizations_organizational_unit.security.id
    workloads = aws_organizations_organizational_unit.workloads.id
  }
}

resource "aws_organizations_policy_attachment" "region_allowlist" {
  for_each  = local.scp_targets
  policy_id = aws_organizations_policy.region_allowlist.id
  target_id = each.value
}

resource "aws_organizations_policy_attachment" "guardrails" {
  for_each  = local.scp_targets
  policy_id = aws_organizations_policy.guardrails.id
  target_id = each.value
}
