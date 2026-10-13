variable "prefix" {
  description = "Secrets Manager name prefix, e.g. learnix/staging."
  type        = string
}

variable "kms_key_arn" {
  type = string
}

variable "core_version" {
  description = "Bump to regenerate ALL core secrets. Rotating the two encryption keys makes existing encrypted columns unreadable; never bump it on an environment holding data."
  type        = number
  default     = 1
}

variable "recovery_window_in_days" {
  type    = number
  default = 7
}
