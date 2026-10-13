variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  description = "Data-tier subnets (no internet route)."
  type        = list(string)
}

variable "client_security_group_ids" {
  description = "Security groups of the tasks that may connect."
  type        = list(string)
}

variable "kms_key_arn" {
  type = string
}

variable "engine_version" {
  description = "PostgreSQL 16 minor. Extensions used by the migrations (uuid-ossp, pg_trgm, pgcrypto) ship with RDS."
  type        = string
  default     = "16.9"
}

variable "instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "database_name" {
  description = "Must identify itself as staging in staging (environment-isolation guard), e.g. learnix_staging."
  type        = string
}

variable "master_username" {
  type    = string
  default = "learnix_admin"
}

variable "allocated_storage_gb" {
  type    = number
  default = 20
}

variable "max_allocated_storage_gb" {
  type    = number
  default = 100
}

variable "multi_az" {
  type    = bool
  default = false
}

variable "backup_retention_days" {
  type    = number
  default = 7
}

variable "deletion_protection" {
  type    = bool
  default = false
}

variable "skip_final_snapshot" {
  type    = bool
  default = true
}

variable "slow_query_ms" {
  type    = number
  default = 500
}

variable "apply_immediately" {
  type    = bool
  default = false
}
