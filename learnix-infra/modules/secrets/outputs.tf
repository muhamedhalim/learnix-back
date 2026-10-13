output "core_arn" {
  value = aws_secretsmanager_secret.core.arn
}

output "external_arns" {
  description = "Secret containers filled by an operator, keyed by name."
  value       = { for k, s in aws_secretsmanager_secret.external : k => s.arn }
}
