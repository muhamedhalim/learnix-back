variable "name" {
  description = "Name prefix; must contain the environment (e.g. learnix-staging) so the app's isolation guard accepts the bucket names."
  type        = string
}

variable "upload_origins" {
  description = "Browser origins allowed to PUT parts directly to the source bucket."
  type        = list(string)
  default     = []
}

variable "output_bucket_policy_documents" {
  description = "Policy documents (JSON) merged into the output bucket policy (the CloudFront OAC read grant)."
  type        = list(string)
  default     = []
}

variable "source_glacier_after_days" {
  type    = number
  default = 30
}

variable "source_expire_after_days" {
  description = "Delete originals after this many days (staging only). Null keeps them."
  type        = number
  default     = null
}

variable "force_destroy" {
  type    = bool
  default = false
}

variable "access_logging_enabled" {
  type    = bool
  default = false
}

variable "access_log_bucket" {
  type    = string
  default = null
}
