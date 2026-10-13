variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "vpc_cidr" {
  type = string
}

variable "subnet_ids" {
  description = "Private subnets (an internal ALB needs at least two AZs)."
  type        = list(string)
}

variable "targets" {
  description = "Target groups by name. Empty paths means the group is only reachable as the default."
  type = map(object({
    port        = number
    health_path = string
    paths       = list(string)
    priority    = number
  }))
}

variable "default_target" {
  description = "Key in targets that receives everything no rule matches."
  type        = string
}

variable "certificate_arn" {
  description = "Regional ACM certificate. Null serves plain HTTP on 80 (inside the VPC only)."
  type        = string
  default     = null
}

variable "access_logging_enabled" {
  type    = bool
  default = false
}

variable "access_log_prefix" {
  description = "Key prefix for the access logs; the log bucket policy must grant the ELB log writer this prefix."
  type        = string
  default     = "alb"
}

variable "access_log_bucket" {
  type    = string
  default = null
}

variable "deletion_protection" {
  type    = bool
  default = false
}
