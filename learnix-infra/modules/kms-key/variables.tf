variable "name" {
  description = "Alias name without the alias/ prefix."
  type        = string
}

variable "description" {
  type = string
}

variable "allow_cloudwatch_logs" {
  description = "Let CloudWatch Logs in this account/region use the key (log groups, WAF logs)."
  type        = bool
  default     = false
}

variable "service_principals" {
  description = "AWS service principals (e.g. cloudwatch.amazonaws.com, events.amazonaws.com) allowed to use the key for this account's resources (SNS/SQS publishers)."
  type        = list(string)
  default     = []
}

variable "deletion_window_in_days" {
  type    = number
  default = 30
}
