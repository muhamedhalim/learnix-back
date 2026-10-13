output "address" {
  value = aws_db_instance.this.address
}

output "port" {
  value = aws_db_instance.this.port
}

output "database_name" {
  value = aws_db_instance.this.db_name
}

output "master_secret_arn" {
  description = "RDS-managed secret holding {username, password}. Injected as DB_USER / DB_PASSWORD."
  value       = aws_db_instance.this.master_user_secret[0].secret_arn
}

output "instance_identifier" {
  value = aws_db_instance.this.identifier
}

output "security_group_id" {
  value = aws_security_group.db.id
}

output "arn" {
  value = aws_db_instance.this.arn
}
