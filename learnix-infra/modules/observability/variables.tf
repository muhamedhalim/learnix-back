variable "name" {
  type = string
}

variable "kms_key_arn" {
  description = "Key for the alerts topic; its policy must let cloudwatch.amazonaws.com use it."
  type        = string
}

variable "alert_emails" {
  description = "Addresses subscribed to the alerts topic (each must confirm the subscription)."
  type        = list(string)
  default     = []
}

variable "alb_arn_suffix" {
  type = string
}

variable "target_group_arn_suffixes" {
  type = map(string)
}

variable "alb_5xx_threshold" {
  type    = number
  default = 10
}

variable "ecs_cluster_name" {
  type = string
}

variable "ecs_service_names" {
  type = list(string)
}

variable "rds_instance_identifier" {
  type = string
}

variable "rds_free_storage_bytes_threshold" {
  description = "Alarm when free storage drops below this many bytes."
  type        = number
  default     = 5368709120
}

variable "rds_connections_threshold" {
  type    = number
  default = 60
}

variable "valkey_replication_group_id" {
  type = string
}

variable "dead_letter_queue_names" {
  type = list(string)
}

variable "app_log_group_names" {
  description = "Log groups carrying the application JSON logs."
  type        = list(string)
}

variable "app_error_threshold" {
  type    = number
  default = 20
}

variable "worker_log_group_name" {
  description = "Log group of the worker (SQS feedback consumers run there). Null skips the provider-feedback metrics."
  type        = string
  default     = null
}

variable "sms_failure_threshold" {
  description = "SMS delivery failures (carrier/handset) per hour that raise an alarm."
  type        = number
  default     = 10
}

variable "mail_feedback_threshold" {
  description = "SES bounces + complaints per hour that raise an alarm (account reputation protection)."
  type        = number
  default     = 10
}

variable "queue_backlog_metric" {
  description = "Custom backlog metric published by the worker (QUEUE_METRICS_NAMESPACE). Null skips the backlog alarm and dashboard widget."
  type = object({
    namespace   = string
    metric_name = string
    dimensions  = map(string)
    threshold   = optional(number, 1000)
  })
  default = null
}

variable "error_anomaly_band_width" {
  description = "Standard deviations for the error-rate anomaly band (higher = fewer alerts)."
  type        = number
  default     = 3
}
