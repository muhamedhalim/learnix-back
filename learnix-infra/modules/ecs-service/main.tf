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
data "aws_region" "current" {}

locals {
  partition = data.aws_partition.current.partition
  region    = data.aws_region.current.region
  family    = "${var.cluster_name}-${var.name}"

  # Scratch volumes are only needed (and only mounted) when the root filesystem is read-only.
  writable = var.read_only_root_filesystem ? { for i, path in var.writable_paths : "scratch-${i}" => path } : {}

  signals     = var.application_signals.enabled
  otel_volume = "opentelemetry-auto-instrumentation-node"
  otel_path   = "/otel-auto-instrumentation-node"

  # Values from the AWS guide "Enable Application Signals on Amazon ECS (sidecar strategy), Node.js".
  # Sampling: the X-Ray sampler reads the account's X-Ray sampling rules through the agent (port 2000);
  # the default rule is 1 request/second plus 5%.
  signals_environment = local.signals ? {
    OTEL_RESOURCE_ATTRIBUTES                       = "service.name=${var.name},deployment.environment=${var.application_signals.environment == "" ? var.cluster_name : var.application_signals.environment},aws.log.group.names=${aws_cloudwatch_log_group.this.name}"
    OTEL_AWS_APPLICATION_SIGNALS_ENABLED           = "true"
    OTEL_AWS_APPLICATION_SIGNALS_EXPORTER_ENDPOINT = "http://localhost:4316/v1/metrics"
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT             = "http://localhost:4316/v1/traces"
    OTEL_EXPORTER_OTLP_PROTOCOL                    = "http/protobuf"
    OTEL_METRICS_EXPORTER                          = "none"
    OTEL_LOGS_EXPORTER                             = "none"
    OTEL_TRACES_SAMPLER                            = "xray"
    OTEL_TRACES_SAMPLER_ARG                        = "endpoint=http://localhost:2000"
    OTEL_PROPAGATORS                               = "tracecontext,baggage,xray"
    NODE_OPTIONS                                   = "--require ${local.otel_path}/autoinstrumentation.js"
  } : {}

  app_env     = merge(var.environment, local.signals_environment)
  environment = [for k in sort(keys(local.app_env)) : { name = k, value = local.app_env[k] }]
  secrets     = [for k in sort(keys(var.secrets)) : { name = k, valueFrom = var.secrets[k] }]

  log_configuration = {
    logDriver = "awslogs"
    options = {
      "awslogs-group"         = aws_cloudwatch_log_group.this.name
      "awslogs-region"        = local.region
      "awslogs-stream-prefix" = var.name
    }
  }

  app_mounts = concat(
    [for k, path in local.writable : { sourceVolume = k, containerPath = path, readOnly = false }],
    local.signals ? [{ sourceVolume = local.otel_volume, containerPath = local.otel_path, readOnly = true }] : [],
  )

  app_container = {
    name                   = var.name
    image                  = var.image
    essential              = true
    command                = var.command
    readonlyRootFilesystem = var.read_only_root_filesystem
    stopTimeout            = var.stop_timeout_seconds
    environment            = local.environment
    secrets                = local.secrets
    linuxParameters        = { initProcessEnabled = true }
    portMappings           = var.container_port == null ? [] : [{ containerPort = var.container_port, protocol = "tcp" }]
    mountPoints            = local.app_mounts
    dependsOn              = local.signals ? [{ containerName = "otel-init", condition = "SUCCESS" }] : []
    logConfiguration       = local.log_configuration
  }

  # Copies the instrumentation into the shared volume, then exits.
  init_container = {
    name                   = "otel-init"
    image                  = var.application_signals.instrument_image
    essential              = false
    readonlyRootFilesystem = false
    command                = ["cp", "-a", "/autoinstrumentation/.", local.otel_path]
    mountPoints            = [{ sourceVolume = local.otel_volume, containerPath = local.otel_path, readOnly = false }]
    logConfiguration       = local.log_configuration
  }

  agent_container = {
    name              = "cloudwatch-agent"
    image             = var.application_signals.agent_image
    essential         = false
    cpu               = var.application_signals.agent_cpu
    memoryReservation = var.application_signals.agent_memory_mib
    environment = [{
      name = "CW_CONFIG_CONTENT"
      value = jsonencode({
        traces = { traces_collected = { application_signals = {} } }
        logs   = { metrics_collected = { application_signals = {} } }
      })
    }]
    logConfiguration = local.log_configuration
  }

  autoscaling = var.create_service && var.desired_count > 0 && var.max_count > var.min_count

  containers = concat([jsonencode(local.app_container)], local.signals ? [jsonencode(local.init_container), jsonencode(local.agent_container)] : [])
}

resource "aws_cloudwatch_log_group" "this" {
  #checkov:skip=CKV_AWS_338:Retention is var.log_retention_days (30 d per the plan); long-term audit trail is the organization CloudTrail
  name              = "/learnix/${var.cluster_name}/${var.name}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
}

# --- Roles ---------------------------------------------------------------------------------------
data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Execution role: pull the image, write logs, read ONLY the secrets this service references.
resource "aws_iam_role" "execution" {
  name               = "${local.family}-exec"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  count = length(var.secrets) == 0 ? 0 : 1

  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = var.secret_arns
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [var.kms_key_arn]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  count = length(var.secrets) == 0 ? 0 : 1

  name   = "read-referenced-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets[0].json
}

# Task role: what the application itself may call. Empty unless the caller supplies a policy.
resource "aws_iam_role" "task" {
  name               = "${local.family}-task"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

# The CloudWatch agent sidecar runs with the task role: X-Ray segments and Application Signals metrics.
resource "aws_iam_role_policy_attachment" "cloudwatch_agent" {
  count = local.signals ? 1 : 0

  role       = aws_iam_role.task.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/CloudWatchAgentServerPolicy"
}

resource "aws_iam_role_policy" "task" {
  count = var.attach_task_policy ? 1 : 0

  name   = "application"
  role   = aws_iam_role.task.id
  policy = var.task_policy_json
}

# --- Task definition and service -----------------------------------------------------------------
resource "aws_ecs_task_definition" "this" {
  family                   = local.family
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  dynamic "volume" {
    for_each = local.writable
    content {
      name = volume.key
    }
  }

  dynamic "volume" {
    for_each = local.signals ? [local.otel_volume] : []
    content {
      name = volume.value
    }
  }

  container_definitions = "[${join(",", local.containers)}]"
}

resource "aws_ecs_service" "this" {
  #checkov:skip=CKV_AWS_333:var.assign_public_ip is true only in staging (no NAT gateway); the task security groups admit nothing but the internal ALB
  count = var.create_service ? 1 : 0

  name            = var.name
  cluster         = var.cluster_arn
  task_definition = aws_ecs_task_definition.this.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  enable_execute_command             = false
  propagate_tags                     = "SERVICE"
  health_check_grace_period_seconds  = var.container_port == null ? null : var.health_check_grace_seconds
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = var.security_group_ids
    assign_public_ip = var.assign_public_ip
  }

  dynamic "load_balancer" {
    for_each = var.container_port == null ? [] : [1]
    content {
      target_group_arn = var.target_group_arn
      container_name   = var.name
      container_port   = var.container_port
    }
  }

  lifecycle {
    # The task definition revision is owned by the deploy pipeline (it registers a copy of the latest
    # Terraform revision with the new image tag); the desired count by autoscaling.
    ignore_changes = [task_definition, desired_count]
  }
}

# Created only once the service is scaled up (desired_count > 0): a scalable target with min_capacity >= 1
# would otherwise start tasks before the first image exists in ECR.
resource "aws_appautoscaling_target" "this" {
  count = local.autoscaling ? 1 : 0

  service_namespace  = "ecs"
  resource_id        = "service/${var.cluster_name}/${aws_ecs_service.this[0].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.min_count
  max_capacity       = var.max_count
}

resource "aws_appautoscaling_policy" "cpu" {
  count = local.autoscaling ? 1 : 0

  name               = "${local.family}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.this[0].service_namespace
  resource_id        = aws_appautoscaling_target.this[0].resource_id
  scalable_dimension = aws_appautoscaling_target.this[0].scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value       = var.cpu_target_percent
    scale_in_cooldown  = 300
    scale_out_cooldown = 60

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

# Worker: keep (queued jobs / running tasks) near the target. The application publishes the backlog
# metric (QUEUE_METRICS_NAMESPACE); RunningTaskCount comes from Container Insights.
resource "aws_appautoscaling_policy" "queue" {
  count = local.autoscaling && var.queue_scaling != null ? 1 : 0

  name               = "${local.family}-queue-backlog"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.this[0].service_namespace
  resource_id        = aws_appautoscaling_target.this[0].resource_id
  scalable_dimension = aws_appautoscaling_target.this[0].scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value       = var.queue_scaling.backlog_per_task
    scale_in_cooldown  = var.queue_scaling.scale_in_cooldown
    scale_out_cooldown = 60

    customized_metric_specification {
      metrics {
        id          = "backlog"
        return_data = false
        metric_stat {
          stat = "Average"
          metric {
            namespace   = var.queue_scaling.namespace
            metric_name = var.queue_scaling.metric_name
            dynamic "dimensions" {
              for_each = var.queue_scaling.dimensions
              content {
                name  = dimensions.key
                value = dimensions.value
              }
            }
          }
        }
      }

      metrics {
        id          = "tasks"
        return_data = false
        metric_stat {
          stat = "Average"
          metric {
            namespace   = "ECS/ContainerInsights"
            metric_name = "RunningTaskCount"
            dimensions {
              name  = "ClusterName"
              value = var.cluster_name
            }
            dimensions {
              name  = "ServiceName"
              value = var.name
            }
          }
        }
      }

      metrics {
        id          = "per_task"
        label       = "Queued jobs per running task"
        expression  = "backlog / IF(tasks < 1, 1, tasks)"
        return_data = true
      }
    }
  }
}
