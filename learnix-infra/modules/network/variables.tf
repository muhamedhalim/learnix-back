variable "name" {
  type = string
}

variable "cidr" {
  description = "VPC CIDR (a /16 is expected; /20 subnets are carved from it)."
  type        = string

  validation {
    condition     = can(cidrhost(var.cidr, 0)) && tonumber(split("/", var.cidr)[1]) == 16
    error_message = "cidr must be a /16."
  }
}

variable "azs" {
  description = "Availability zones (two in Stage 1)."
  type        = list(string)

  validation {
    condition     = length(var.azs) >= 2 && length(var.azs) <= 3
    error_message = "Use two or three availability zones."
  }
}

variable "nat_gateway_count" {
  description = "0 in staging (tasks use public IPs), 1 in production Stage 1, 2 from Stage 2."
  type        = number
  default     = 0

  validation {
    condition     = var.nat_gateway_count >= 0 && var.nat_gateway_count <= 3
    error_message = "nat_gateway_count must be 0..3."
  }
}

variable "logs_kms_key_arn" {
  type = string
}

variable "flow_log_retention_days" {
  type    = number
  default = 30
}
