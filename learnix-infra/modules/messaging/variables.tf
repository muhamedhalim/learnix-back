variable "name" {
  type = string
}

variable "kms_key_arn" {
  description = "Key for the SNS topics. Its policy must let ses.amazonaws.com and sms-voice.amazonaws.com use it."
  type        = string
}

variable "domain" {
  description = "Sending domain. Null skips the domain identity (SES stays sandbox-only with verified addresses)."
  type        = string
  default     = null
}

variable "zone_id" {
  description = "Route 53 zone that holds var.domain. Null leaves DKIM / MAIL FROM / DMARC records to the operator."
  type        = string
  default     = null
}

variable "manage_dns_records" {
  description = "Create the DKIM / MAIL FROM / DMARC records in var.zone_id. A plain bool because the zone id is unknown until apply."
  type        = bool
  default     = false
}

variable "dmarc_policy" {
  description = "none during warm-up; quarantine after 30 days of clean reports."
  type        = string
  default     = "none"

  validation {
    condition     = contains(["none", "quarantine", "reject"], var.dmarc_policy)
    error_message = "dmarc_policy must be none, quarantine or reject."
  }
}
