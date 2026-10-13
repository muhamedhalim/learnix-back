terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

data "aws_partition" "current" {}

locals {
  partition = data.aws_partition.current.partition
}

resource "aws_db_subnet_group" "this" {
  name       = var.name
  subnet_ids = var.subnet_ids
}

resource "aws_security_group" "db" {
  name_prefix = "${var.name}-db-"
  description = "PostgreSQL: ingress only from the groups listed in var.client_security_group_ids"
  vpc_id      = var.vpc_id

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "from_clients" {
  count = length(var.client_security_group_ids)

  security_group_id            = aws_security_group.db.id
  description                  = "PostgreSQL from application tasks"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = var.client_security_group_ids[count.index]
}

# TLS is mandatory server-side as well as client-side (the app verifies with the RDS CA bundle).
resource "aws_db_parameter_group" "this" {
  name_prefix = "${var.name}-pg16-"
  family      = "postgres16"
  description = "Learnix PostgreSQL 16"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name  = "log_min_duration_statement"
    value = tostring(var.slow_query_ms)
  }
  parameter {
    name  = "log_connections"
    value = "1"
  }
  parameter {
    name  = "log_disconnections"
    value = "1"
  }
  parameter {
    name         = "log_lock_waits"
    value        = "1"
    apply_method = "pending-reboot"
  }

  lifecycle {
    create_before_destroy = true
  }
}

data "aws_iam_policy_document" "monitoring_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["monitoring.rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "monitoring" {
  name               = "${var.name}-rds-monitoring"
  assume_role_policy = data.aws_iam_policy_document.monitoring_assume.json
}

resource "aws_iam_role_policy_attachment" "monitoring" {
  role       = aws_iam_role.monitoring.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

resource "aws_db_instance" "this" {
  #checkov:skip=CKV_AWS_293:Deletion protection is var.deletion_protection (false in staging, true in production)
  #checkov:skip=CKV_AWS_157:Multi-AZ is a per-environment decision (var.multi_az); staging is single-AZ by design
  identifier = var.name

  engine               = "postgres"
  engine_version       = var.engine_version
  instance_class       = var.instance_class
  db_name              = var.database_name
  username             = var.master_username
  parameter_group_name = aws_db_parameter_group.this.name

  # RDS creates and rotates the master secret in Secrets Manager; no password is ever in this
  # configuration or in Terraform state.
  manage_master_user_password   = true
  master_user_secret_kms_key_id = var.kms_key_arn

  allocated_storage     = var.allocated_storage_gb
  max_allocated_storage = var.max_allocated_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = var.kms_key_arn

  multi_az               = var.multi_az
  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible    = false
  port                   = 5432

  iam_database_authentication_enabled = true
  auto_minor_version_upgrade          = true
  copy_tags_to_snapshot               = true
  deletion_protection                 = var.deletion_protection
  skip_final_snapshot                 = var.skip_final_snapshot
  final_snapshot_identifier           = var.skip_final_snapshot ? null : "${var.name}-final"
  delete_automated_backups            = var.skip_final_snapshot

  backup_retention_period = var.backup_retention_days
  backup_window           = "01:00-02:00"
  maintenance_window      = "sun:02:30-sun:03:30"

  performance_insights_enabled          = true
  performance_insights_kms_key_id       = var.kms_key_arn
  performance_insights_retention_period = 7
  monitoring_interval                   = 60
  monitoring_role_arn                   = aws_iam_role.monitoring.arn
  enabled_cloudwatch_logs_exports       = ["postgresql", "upgrade"]

  apply_immediately = var.apply_immediately
}
