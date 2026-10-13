variable "name" {
  type = string
}

variable "domain" {
  description = "Top-level domain the browser app runs on, i.e. the Vercel-hosted frontend (e.g. learnix.school or staging.learnix.school)."
  type        = string
}

variable "session_sample_rate" {
  description = "Fraction of sessions recorded (cost scales with recorded events)."
  type        = number
  default     = 0.25

  validation {
    condition     = var.session_sample_rate > 0 && var.session_sample_rate <= 1
    error_message = "session_sample_rate must be in (0, 1]."
  }
}

variable "enable_xray" {
  description = "Enable X-Ray on the app monitor. Off: the API is cross-origin from the Vercel frontend, so joining traces would need the trace header in the API's CORS allowlist and a preflight on every call; browser monitoring stays independent of backend traces."
  type        = bool
  default     = false
}

variable "store_events_in_logs" {
  description = "Copy raw RUM events to CloudWatch Logs (needed for custom Logs Insights queries over browser events; adds ingestion cost)."
  type        = bool
  default     = false
}

variable "excluded_pages" {
  type    = list(string)
  default = []
}

variable "alarm_enabled" {
  description = "Plain bool (the topic ARN is unknown until apply, so it cannot drive count)."
  type        = bool
  default     = true
}

variable "alarm_topic_arn" {
  type    = string
  default = null
}

variable "js_error_threshold" {
  type    = number
  default = 50
}
