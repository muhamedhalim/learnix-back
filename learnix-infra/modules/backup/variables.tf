variable "name" {
  description = "Prefix for the vault, plan and role names."
  type        = string
}

variable "kms_key_arn" {
  description = "Key that encrypts recovery points in this vault (same region as the vault)."
  type        = string
}

variable "create_plan" {
  description = "False for a copy-destination vault only (the DR region)."
  type        = bool
  default     = true
}

variable "resource_arns" {
  description = "Resources protected by the plan (RDS instance and versioned S3 bucket ARNs)."
  type        = list(string)
  default     = []
}

variable "daily_retention_days" {
  type    = number
  default = 35
}

variable "monthly_retention_days" {
  description = "Monthly recovery points (first of the month). 0 disables the monthly rule."
  type        = number
  default     = 365
}

variable "copy_destination_vault_arn" {
  description = "Vault in another region (or account) that receives a copy of every daily recovery point. Null disables copying."
  type        = string
  default     = null
}

variable "copy_retention_days" {
  type    = number
  default = 35
}

variable "deny_delete" {
  description = "Vault access policy that denies deleting recovery points and changing the vault's policy to everyone except the account root. Vault Lock (immutable) is a separate, irreversible Stage 4 step."
  type        = bool
  default     = true
}

variable "force_destroy" {
  description = "Staging only: lets terraform destroy remove a vault that still holds recovery points."
  type        = bool
  default     = false
}
