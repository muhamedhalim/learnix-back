output "primary_endpoint" {
  value = aws_elasticache_replication_group.this.primary_endpoint_address
}

output "port" {
  value = 6379
}

output "auth_secret_arn" {
  description = "Secret {REDIS_AUTH_TOKEN}. The container entrypoint composes REDIS_URL (rediss://) from it."
  value       = aws_secretsmanager_secret.auth.arn
}

output "replication_group_id" {
  value = aws_elasticache_replication_group.this.replication_group_id
}

output "security_group_id" {
  value = aws_security_group.cache.id
}
