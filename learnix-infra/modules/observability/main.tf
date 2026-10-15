terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

locals {
  alarm_actions = [aws_sns_topic.alerts.arn]
  dlqs          = toset(var.dead_letter_queue_names)
}

resource "aws_sns_topic" "alerts" {
  name              = "${var.name}-alerts"
  kms_master_key_id = var.kms_key_arn
}

resource "aws_sns_topic_subscription" "email" {
  for_each = toset(var.alert_emails)

  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = each.value
}

# --- Edge / load balancer ------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${var.name}-alb-5xx"
  alarm_description   = "The load balancer or its targets are returning 5xx responses"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  dimensions          = { LoadBalancer = var.alb_arn_suffix }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 2
  threshold           = var.alb_5xx_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# 502/503/504 produced by the load balancer itself (no healthy target, connection reset): invisible to the
# target-5xx alarm above, and exactly what a broken release looks like.
resource "aws_cloudwatch_metric_alarm" "alb_elb_5xx" {
  alarm_name          = "${var.name}-alb-elb-5xx"
  alarm_description   = "The load balancer itself is returning 5xx (no healthy targets, resets or timeouts)"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_ELB_5XX_Count"
  dimensions          = { LoadBalancer = var.alb_arn_suffix }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 2
  threshold           = var.alb_5xx_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "unhealthy_targets" {
  for_each = var.target_group_arn_suffixes

  alarm_name          = "${var.name}-${each.key}-unhealthy-targets"
  alarm_description   = "A ${each.key} task is failing its load balancer health check"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  dimensions          = { LoadBalancer = var.alb_arn_suffix, TargetGroup = each.value }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# --- ECS -----------------------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "ecs_cpu" {
  for_each = toset(var.ecs_service_names)

  alarm_name          = "${var.name}-${each.value}-cpu-high"
  alarm_description   = "${each.value} CPU above 85% for 10 minutes (autoscaling cannot keep up or is capped)"
  namespace           = "AWS/ECS"
  metric_name         = "CPUUtilization"
  dimensions          = { ClusterName = var.ecs_cluster_name, ServiceName = each.value }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = 85
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "ecs_memory" {
  for_each = toset(var.ecs_service_names)

  alarm_name          = "${var.name}-${each.value}-memory-high"
  alarm_description   = "${each.value} memory above 85% for 10 minutes (OOM kills are next)"
  namespace           = "AWS/ECS"
  metric_name         = "MemoryUtilization"
  dimensions          = { ClusterName = var.ecs_cluster_name, ServiceName = each.value }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = 85
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}

# --- RDS -----------------------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "${var.name}-rds-cpu-high"
  alarm_description   = "Database CPU above 80% for 15 minutes"
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  dimensions          = { DBInstanceIdentifier = var.rds_instance_identifier }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "rds_storage" {
  alarm_name          = "${var.name}-rds-free-storage-low"
  alarm_description   = "Database free storage below ${var.rds_free_storage_bytes_threshold / 1073741824} GiB"
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  dimensions          = { DBInstanceIdentifier = var.rds_instance_identifier }
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.rds_free_storage_bytes_threshold
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "rds_connections" {
  alarm_name          = "${var.name}-rds-connections-high"
  alarm_description   = "Database connections above ${var.rds_connections_threshold} (pool sizes x tasks too large for this instance class)"
  namespace           = "AWS/RDS"
  metric_name         = "DatabaseConnections"
  dimensions          = { DBInstanceIdentifier = var.rds_instance_identifier }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = var.rds_connections_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}

# --- Valkey (BullMQ uses noeviction: a full cache rejects writes) ----------------------------------
resource "aws_cloudwatch_metric_alarm" "valkey_memory" {
  alarm_name          = "${var.name}-valkey-memory-high"
  alarm_description   = "Valkey memory above 75%; with noeviction a full instance rejects queue writes"
  namespace           = "AWS/ElastiCache"
  metric_name         = "DatabaseMemoryUsagePercentage"
  dimensions          = { ReplicationGroupId = var.valkey_replication_group_id }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 75
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "valkey_cpu" {
  alarm_name          = "${var.name}-valkey-cpu-high"
  alarm_description   = "Valkey engine CPU above 80% for 15 minutes"
  namespace           = "AWS/ElastiCache"
  metric_name         = "EngineCPUUtilization"
  dimensions          = { ReplicationGroupId = var.valkey_replication_group_id }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}

# --- Dead-letter queues: anything in one is a lost event --------------------------------------------
resource "aws_cloudwatch_metric_alarm" "dlq" {
  for_each = local.dlqs

  alarm_name          = "${var.name}-dlq-${each.value}"
  alarm_description   = "Messages are sitting in ${each.value}: events failed processing five times"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = each.value }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}

# --- Application errors (JSON logs: {"level":"error", ...}) -----------------------------------------
resource "aws_cloudwatch_log_metric_filter" "errors" {
  for_each = toset(var.app_log_group_names)

  name           = "${var.name}-errors"
  log_group_name = each.value
  pattern        = "{ $.level = \"error\" }"

  metric_transformation {
    namespace     = "Learnix/${var.name}"
    name          = "ApplicationErrors"
    value         = "1"
    default_value = "0"
    dimensions    = {}
  }
}

resource "aws_cloudwatch_metric_alarm" "app_errors" {
  alarm_name          = "${var.name}-application-errors"
  alarm_description   = "More than ${var.app_error_threshold} error-level log lines in 5 minutes across the application"
  namespace           = "Learnix/${var.name}"
  metric_name         = "ApplicationErrors"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.app_error_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions

  depends_on = [aws_cloudwatch_log_metric_filter.errors]
}
