variable "region" {
  type    = string
  default = "eu-central-1"
}

variable "project" {
  type    = string
  default = "learnix"
}

variable "owner" {
  type    = string
  default = "platform"
}

variable "cost_center" {
  type    = string
  default = "learnix"
}

variable "account_emails" {
  description = "Unique root e-mail address per member account (use plus-addressing on a mailbox you control)."
  type = object({
    log_archive = string
    staging     = string
    production  = string
  })
}

variable "log_archive_account_id" {
  description = "Empty on the first apply. After the accounts exist, set to the log-archive account ID and apply again (stage 2)."
  type        = string
  default     = ""

  validation {
    condition     = var.log_archive_account_id == "" || can(regex("^[0-9]{12}$", var.log_archive_account_id))
    error_message = "log_archive_account_id must be empty or a 12-digit account ID."
  }
}

variable "allowed_regions" {
  description = "Regions members may use: primary, CloudFront/WAF/ACM (us-east-1) and DR (eu-west-1)."
  type        = list(string)
  default     = ["eu-central-1", "us-east-1", "eu-west-1"]
}

variable "alert_emails" {
  description = "Recipients for budget and cost-anomaly alerts."
  type        = list(string)

  validation {
    condition     = length(var.alert_emails) > 0
    error_message = "Provide at least one alert e-mail address."
  }
}

variable "log_retention_days" {
  description = "Days to keep CloudTrail objects in the log-archive bucket."
  type        = number
  default     = 400
}

variable "budgets_usd" {
  description = "Monthly budgets (USD). Defaults follow the approved plan section 6.6."
  type = object({
    production     = number
    staging        = number
    mediaconvert   = number
    sms            = number
    cloudwatch     = number
    anomaly_impact = number
  })
  default = {
    production     = 650
    staging        = 130
    mediaconvert   = 75
    sms            = 150
    cloudwatch     = 40
    anomaly_impact = 20
  }
}

variable "service_budget_filters" {
  description = "Cost Explorer SERVICE names for the per-service budgets. VERIFY the exact names in Cost Explorer before applying."
  type = object({
    mediaconvert = string
    sms          = string
    cloudwatch   = string
  })
  default = {
    mediaconvert = "AWS Elemental MediaConvert"
    sms          = "AWS End User Messaging"
    cloudwatch   = "AmazonCloudWatch"
  }
}
