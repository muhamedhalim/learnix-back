output "vault_arn" {
  value = aws_backup_vault.this.arn
}

output "vault_name" {
  value = aws_backup_vault.this.name
}

output "plan_id" {
  value = one(aws_backup_plan.this[*].id)
}

output "has_plan" {
  value = var.create_plan
}
