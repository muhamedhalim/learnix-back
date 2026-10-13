data "aws_region" "current" {}

locals {
  region = data.aws_region.current.region

  queue_widget = var.queue_backlog_metric == null ? [] : [{
    type   = "metric"
    width  = 12
    height = 6
    properties = {
      title  = "Queue backlog vs worker tasks"
      region = local.region
      period = 60
      metrics = [
        concat(
          [var.queue_backlog_metric.namespace, var.queue_backlog_metric.metric_name],
          flatten([for k, v in var.queue_backlog_metric.dimensions : [k, v]]),
          [{ stat = "Average" }],
        ),
        ["ECS/ContainerInsights", "RunningTaskCount", "ClusterName", var.ecs_cluster_name, "ServiceName", "worker", { stat = "Average", yAxis = "right" }],
      ]
    }
  }]

  dashboard_widgets = concat([
    {
      type = "metric", width = 12, height = 6
      properties = {
        title  = "Load balancer: requests and 5xx"
        region = local.region
        stat   = "Sum"
        period = 300
        metrics = [
          ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", var.alb_arn_suffix],
          [".", "HTTPCode_Target_5XX_Count", ".", "."],
          [".", "HTTPCode_ELB_5XX_Count", ".", "."],
        ]
      }
    },
    {
      type = "metric", width = 12, height = 6
      properties = {
        title   = "Load balancer: target response time (p95)"
        region  = local.region
        stat    = "p95"
        period  = 300
        metrics = [["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", var.alb_arn_suffix]]
      }
    },
    {
      type = "metric", width = 12, height = 6
      properties = {
        title   = "ECS CPU by service"
        region  = local.region
        stat    = "Average"
        period  = 300
        metrics = [for s in var.ecs_service_names : ["AWS/ECS", "CPUUtilization", "ClusterName", var.ecs_cluster_name, "ServiceName", s]]
      }
    },
    {
      type = "metric", width = 12, height = 6
      properties = {
        title   = "ECS memory by service"
        region  = local.region
        stat    = "Average"
        period  = 300
        metrics = [for s in var.ecs_service_names : ["AWS/ECS", "MemoryUtilization", "ClusterName", var.ecs_cluster_name, "ServiceName", s]]
      }
    },
    {
      type = "metric", width = 12, height = 6
      properties = {
        title  = "RDS: CPU and connections"
        region = local.region
        period = 300
        metrics = [
          ["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", var.rds_instance_identifier, { stat = "Average" }],
          [".", "DatabaseConnections", ".", ".", { stat = "Maximum", yAxis = "right" }],
        ]
      }
    },
    {
      type = "metric", width = 12, height = 6
      properties = {
        title  = "Valkey: memory and CPU"
        region = local.region
        period = 300
        metrics = [
          ["AWS/ElastiCache", "DatabaseMemoryUsagePercentage", "ReplicationGroupId", var.valkey_replication_group_id, { stat = "Maximum" }],
          [".", "EngineCPUUtilization", ".", ".", { stat = "Average" }],
        ]
      }
    },
    {
      type = "metric", width = 12, height = 6
      properties = {
        title  = "Application errors and provider feedback"
        region = local.region
        stat   = "Sum"
        period = 300
        metrics = [
          ["Learnix/${var.name}", "ApplicationErrors"],
          [".", "SmsDeliveryFailures"],
          [".", "MailBouncesAndComplaints"],
        ]
      }
    },
  ], local.queue_widget)
}

resource "aws_cloudwatch_dashboard" "this" {
  dashboard_name = "${var.name}-overview"
  dashboard_body = jsonencode({ widgets = local.dashboard_widgets })
}
