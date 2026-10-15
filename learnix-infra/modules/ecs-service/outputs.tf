output "service_name" {
  value = one(aws_ecs_service.this[*].name)
}

output "task_definition_family" {
  value = aws_ecs_task_definition.this.family
}

output "task_role_arn" {
  value = aws_iam_role.task.arn
}

output "execution_role_arn" {
  value = aws_iam_role.execution.arn
}

output "log_group_name" {
  value = aws_cloudwatch_log_group.this.name
}

output "container_names" {
  value = concat([local.app_container.name], local.signals ? [local.init_container.name, local.agent_container.name] : [])
}

output "autoscaling_policies" {
  description = "Kinds of scaling attached: cpu, queue."
  value       = concat(length(aws_appautoscaling_policy.cpu) > 0 ? ["cpu"] : [], length(aws_appautoscaling_policy.queue) > 0 ? ["queue"] : [])
}

output "secret_refs" {
  description = "Environment variable name to Secrets Manager reference (ARN:key::) injected into the container. References only, never values."
  value       = var.secrets
}
