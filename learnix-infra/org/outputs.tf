output "organization_id" {
  value = aws_organizations_organization.this.id
}

output "account_ids" {
  description = "Use these for the per-account bootstrap and for log_archive_account_id (stage 2)."
  value = {
    management  = local.management_account_id
    log_archive = aws_organizations_account.log_archive.id
    staging     = aws_organizations_account.staging.id
    production  = aws_organizations_account.production.id
  }
}

output "organizational_units" {
  value = {
    security  = aws_organizations_organizational_unit.security.id
    workloads = aws_organizations_organizational_unit.workloads.id
  }
}

output "cloudtrail_arn" {
  value = local.stage2 ? aws_cloudtrail.org[0].arn : null
}
