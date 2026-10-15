output "core_arn" {
  value = aws_secretsmanager_secret.core.arn
}

output "external_arns" {
  description = "Secret containers filled by an operator, keyed by name."
  value       = { for k, s in aws_secretsmanager_secret.external : k => s.arn }
}

output "db_app_arn" {
  description = "Secret holding the application database role {username, password}."
  value       = aws_secretsmanager_secret.db_app.arn
}
