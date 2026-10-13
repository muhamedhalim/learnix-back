variable "name" {
  type = string
}

variable "kms_key_arn" {
  description = "SSE-KMS key. Null selects SSE-S3 (needed for ALB logs and for CloudFront-served HLS segments, which would otherwise cost a KMS request each)."
  type        = string
  default     = null
}

variable "versioning" {
  type    = bool
  default = true
}

variable "noncurrent_version_days" {
  type    = number
  default = 30
}

variable "glacier_after_days" {
  type    = number
  default = null
}

variable "expire_after_days" {
  type    = number
  default = null
}

variable "force_destroy" {
  description = "Allow terraform destroy to delete a non-empty bucket. Only ever true in staging."
  type        = bool
  default     = false
}

variable "access_logging_enabled" {
  description = "Write S3 server access logs to access_log_bucket. A plain bool because the bucket name is unknown until apply."
  type        = bool
  default     = false
}

variable "access_log_bucket" {
  type    = string
  default = null
}

variable "cors_allowed_origins" {
  type    = list(string)
  default = []
}

variable "cors_allowed_methods" {
  type    = list(string)
  default = ["GET", "HEAD", "PUT"]
}

variable "extra_policy_documents" {
  description = "Additional bucket policy documents (JSON) merged with the TLS-only deny."
  type        = list(string)
  default     = []
}
