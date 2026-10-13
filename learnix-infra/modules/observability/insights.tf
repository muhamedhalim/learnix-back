# --- Logs Insights saved queries (the triage views that replace Sentry's issue list) --------------
# Learnix logs one JSON object per line (LOG_FORMAT=json): level, context, message. Structured events
# (http_request, sms_delivery, ses_*, database_query_performance) are a JSON string inside `message`.
# One query per file in queries/ (kept out of HCL heredocs so linters parse this file).
locals {
  saved_queries = {
    for f in fileset("${path.module}/queries", "*.logsql") : trimsuffix(f, ".logsql") => file("${path.module}/queries/${f}")
  }
}

resource "aws_cloudwatch_query_definition" "this" {
  for_each = local.saved_queries

  name            = "${var.name}/${each.key}"
  log_group_names = var.app_log_group_names
  query_string    = each.value
}

# --- Error-rate anomaly detection ----------------------------------------------------------------
# Complements the fixed threshold in main.tf: catches a sustained rise that stays under it.
resource "aws_cloudwatch_metric_alarm" "app_errors_anomaly" {
  alarm_name          = "${var.name}-application-errors-anomaly"
  alarm_description   = "Error-level log lines are above the learned band for 3 consecutive 5-minute periods"
  comparison_operator = "GreaterThanUpperThreshold"
  evaluation_periods  = 3
  threshold_metric_id = "band"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions

  metric_query {
    id          = "errors"
    return_data = true
    metric {
      namespace   = "Learnix/${var.name}"
      metric_name = "ApplicationErrors"
      period      = 300
      stat        = "Sum"
    }
  }

  metric_query {
    id          = "band"
    expression  = "ANOMALY_DETECTION_BAND(errors, ${var.error_anomaly_band_width})"
    label       = "Expected errors"
    return_data = true
  }

  depends_on = [aws_cloudwatch_log_metric_filter.errors]
}

# --- Provider feedback (worker SQS consumers) ----------------------------------------------------
resource "aws_cloudwatch_log_metric_filter" "sms_failures" {
  count = var.worker_log_group_name == null ? 0 : 1

  name           = "${var.name}-sms-delivery-failures"
  log_group_name = var.worker_log_group_name
  pattern        = "{ $.context = \"SmsEventsConsumer\" && $.level = \"warn\" }"

  metric_transformation {
    namespace     = "Learnix/${var.name}"
    name          = "SmsDeliveryFailures"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "sms_failures" {
  count = var.worker_log_group_name == null ? 0 : 1

  alarm_name          = "${var.name}-sms-delivery-failures"
  alarm_description   = "More than ${var.sms_failure_threshold} SMS messages failed at the carrier or handset in an hour"
  namespace           = "Learnix/${var.name}"
  metric_name         = "SmsDeliveryFailures"
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = var.sms_failure_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions

  depends_on = [aws_cloudwatch_log_metric_filter.sms_failures]
}

resource "aws_cloudwatch_log_metric_filter" "mail_feedback" {
  count = var.worker_log_group_name == null ? 0 : 1

  name           = "${var.name}-ses-bounces-complaints"
  log_group_name = var.worker_log_group_name
  pattern        = "{ $.context = \"MailEventsConsumer\" && $.level = \"warn\" }"

  metric_transformation {
    namespace     = "Learnix/${var.name}"
    name          = "MailBouncesAndComplaints"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "mail_feedback" {
  count = var.worker_log_group_name == null ? 0 : 1

  alarm_name          = "${var.name}-ses-bounces-complaints"
  alarm_description   = "More than ${var.mail_feedback_threshold} SES bounces or complaints in an hour; SES pauses sending for accounts whose rates stay high"
  namespace           = "Learnix/${var.name}"
  metric_name         = "MailBouncesAndComplaints"
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = var.mail_feedback_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions

  depends_on = [aws_cloudwatch_log_metric_filter.mail_feedback]
}

# --- Queue backlog (published by the worker; also drives worker autoscaling) ---------------------
resource "aws_cloudwatch_metric_alarm" "queue_backlog" {
  count = var.queue_backlog_metric == null ? 0 : 1

  alarm_name          = "${var.name}-queue-backlog"
  alarm_description   = "More than ${var.queue_backlog_metric.threshold} jobs waiting for 15 minutes, or the worker stopped publishing: workers are capped, failing or not running"
  namespace           = var.queue_backlog_metric.namespace
  metric_name         = var.queue_backlog_metric.metric_name
  dimensions          = var.queue_backlog_metric.dimensions
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = var.queue_backlog_metric.threshold
  comparison_operator = "GreaterThanThreshold"
  # The worker publishes every minute; silence means it is not running.
  treat_missing_data = "breaching"
  alarm_actions      = local.alarm_actions
  ok_actions         = local.alarm_actions
}
