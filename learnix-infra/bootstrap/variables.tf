variable "region" {
  description = "Region for the state bucket and KMS key."
  type        = string
  default     = "eu-central-1"
}

variable "project" {
  type    = string
  default = "learnix"
}

variable "environment" {
  description = "Account this bootstrap runs in. Drives names and the GitHub environment (infra-<environment>) trusted for apply."
  type        = string

  validation {
    condition     = contains(["management", "log-archive", "staging", "production"], var.environment)
    error_message = "environment must be management, log-archive, staging or production."
  }
}

variable "github_repository" {
  description = "GitHub repository allowed to assume the CI roles, as OWNER/REPO."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository must look like OWNER/REPO."
  }
}

variable "create_oidc_provider" {
  description = "Create the GitHub OIDC provider. Set false if the account already has one (only one per account is allowed)."
  type        = bool
  default     = true
}

variable "owner" {
  type    = string
  default = "platform"
}

variable "cost_center" {
  type    = string
  default = "learnix"
}
