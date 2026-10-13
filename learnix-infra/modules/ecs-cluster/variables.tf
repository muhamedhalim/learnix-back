variable "name" {
  type = string
}

variable "kms_key_arn" {
  type = string
}

variable "repositories" {
  description = "Repository names created under <name>/ (e.g. api, web)."
  type        = list(string)
}

variable "keep_images" {
  type    = number
  default = 30
}

variable "force_delete_repositories" {
  description = "Delete repositories that still hold images on destroy. Staging only."
  type        = bool
  default     = false
}
