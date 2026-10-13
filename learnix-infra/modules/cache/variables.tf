variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  type = list(string)
}

variable "client_security_group_ids" {
  type = list(string)
}

variable "kms_key_arn" {
  type = string
}

variable "secret_prefix" {
  description = "Secrets Manager name prefix, e.g. learnix/staging."
  type        = string
}

variable "engine_version" {
  type    = string
  default = "8.0"
}

variable "node_type" {
  type    = string
  default = "cache.t4g.micro"
}

variable "node_count" {
  description = "1 in staging; 2 (primary + replica, automatic failover) in production."
  type        = number
  default     = 1
}

variable "auth_token_version" {
  description = "Bump to rotate the AUTH token (re-generates it and rewrites the secret)."
  type        = number
  default     = 1
}

variable "snapshot_retention_days" {
  type    = number
  default = 1
}

variable "secret_recovery_days" {
  type    = number
  default = 7
}

variable "apply_immediately" {
  type    = bool
  default = false
}
