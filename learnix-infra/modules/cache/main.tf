terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.7.0"
    }
  }
}

resource "aws_elasticache_subnet_group" "this" {
  name       = var.name
  subnet_ids = var.subnet_ids
}

resource "aws_security_group" "cache" {
  name_prefix = "${var.name}-cache-"
  description = "Valkey: ingress only from the groups listed in var.client_security_group_ids"
  vpc_id      = var.vpc_id

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "from_clients" {
  count = length(var.client_security_group_ids)

  security_group_id            = aws_security_group.cache.id
  description                  = "Valkey from application tasks"
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
  referenced_security_group_id = var.client_security_group_ids[count.index]
}

# BullMQ requires noeviction: an evicted queue key is a lost job.
resource "aws_elasticache_parameter_group" "this" {
  name        = "${var.name}-valkey8"
  family      = "valkey8"
  description = "Learnix Valkey (BullMQ: noeviction)"

  parameter {
    name  = "maxmemory-policy"
    value = "noeviction"
  }
}

# The AUTH token is generated as an ephemeral value and handed to ElastiCache and Secrets Manager
# through write-only arguments, so it never exists in Terraform state or plan output.
ephemeral "random_password" "auth_token" {
  length           = 48
  special          = true
  override_special = "!&#$^<>-"
}

resource "aws_elasticache_replication_group" "this" {
  #checkov:skip=CKV2_AWS_50:Automatic failover is enabled whenever var.node_count > 1 (production); staging is a single node
  #checkov:skip=CKV_AWS_31:Transit encryption + AUTH are enabled; checkov cannot see the write-only auth_token_wo argument
  replication_group_id = var.name
  description          = "Learnix queues and cache"

  engine               = "valkey"
  engine_version       = var.engine_version
  node_type            = var.node_type
  port                 = 6379
  parameter_group_name = aws_elasticache_parameter_group.this.name

  num_cache_clusters         = var.node_count
  automatic_failover_enabled = var.node_count > 1
  multi_az_enabled           = var.node_count > 1

  subnet_group_name  = aws_elasticache_subnet_group.this.name
  security_group_ids = [aws_security_group.cache.id]

  at_rest_encryption_enabled = true
  kms_key_id                 = var.kms_key_arn
  transit_encryption_enabled = true
  transit_encryption_mode    = "required"
  auth_token_wo              = ephemeral.random_password.auth_token.result
  auth_token_wo_version      = var.auth_token_version

  snapshot_retention_limit   = var.snapshot_retention_days
  snapshot_window            = "01:00-02:00"
  maintenance_window         = "sun:03:30-sun:04:30"
  auto_minor_version_upgrade = true
  apply_immediately          = var.apply_immediately
}

resource "aws_secretsmanager_secret" "auth" {
  #checkov:skip=CKV2_AWS_57:Rotation is a controlled operation (bump auth_token_version; the app restarts to pick it up), not an automatic one
  name                    = "${var.secret_prefix}/valkey"
  description             = "ElastiCache AUTH token for ${var.name} (injected as REDIS_AUTH_TOKEN)"
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = var.secret_recovery_days
}

resource "aws_secretsmanager_secret_version" "auth" {
  secret_id                = aws_secretsmanager_secret.auth.id
  secret_string_wo         = jsonencode({ REDIS_AUTH_TOKEN = ephemeral.random_password.auth_token.result })
  secret_string_wo_version = var.auth_token_version
}
