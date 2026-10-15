output "alerts_topic_arn" {
  value = aws_sns_topic.alerts.arn
}

output "dashboard_name" {
  value = aws_cloudwatch_dashboard.this.dashboard_name
}

# Alarms that react to a bad release and treat missing data as healthy. ecs-deploy.sh refuses to start while
# one of them fires and rolls back when one fires afterwards. Deliberately excludes alarms that breach on
# missing data (canary, queue backlog) and slow-moving ones (RDS CPU, storage).
output "deploy_health_alarms" {
  value = concat(
    [aws_cloudwatch_metric_alarm.alb_5xx.alarm_name, aws_cloudwatch_metric_alarm.alb_elb_5xx.alarm_name, aws_cloudwatch_metric_alarm.app_errors.alarm_name],
    [for a in aws_cloudwatch_metric_alarm.unhealthy_targets : a.alarm_name],
  )
}
