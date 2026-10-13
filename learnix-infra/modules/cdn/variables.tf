variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "alb_arn" {
  type = string
}

variable "alb_dns_name" {
  type = string
}

variable "alb_https" {
  description = "True when the ALB listener is HTTPS (production origin certificate)."
  type        = bool
  default     = false
}

variable "aliases" {
  description = "Viewer-facing domain names (empty until the custom domain is enabled)."
  type        = list(string)
  default     = []
}

variable "acm_certificate_arn" {
  description = "Validated us-east-1 certificate covering var.aliases. Null serves the default *.cloudfront.net certificate."
  type        = string
  default     = null
}

variable "price_class" {
  description = "PriceClass_All is required for Middle East / Africa edge locations (Egyptian audience)."
  type        = string
  default     = "PriceClass_All"
}

variable "video_bucket" {
  description = "HLS output bucket served at /video/*. Null removes the behaviour."
  type = object({
    arn                  = string
    regional_domain_name = string
  })
  default = null
}

variable "video_public_key_pem" {
  description = "Public half of the playback signing key (the private half lives only in Secrets Manager). Null removes /video/* so nothing unsigned can ever be served."
  type        = string
  default     = null
}

variable "cors_allowed_origins" {
  description = "Exact frontend origins (Vercel) allowed to fetch /video/* with credentials. Never wildcards: signed cookies travel with these requests."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for o in var.cors_allowed_origins : can(regex("^https://[a-z0-9.-]+(:[0-9]+)?$", o))])
    error_message = "cors_allowed_origins must be https origins without a path or wildcard."
  }
}

variable "restrict_to_allowlist" {
  description = "Block every request that is not from allowed_*_cidrs or under open_path_prefixes (staging gate)."
  type        = bool
  default     = true
}

variable "allowed_ipv4_cidrs" {
  type    = list(string)
  default = []
}

variable "allowed_ipv6_cidrs" {
  type    = list(string)
  default = []
}

variable "open_path_prefixes" {
  description = "Paths reachable from anywhere even behind the gate (provider webhooks that authenticate by HMAC)."
  type        = list(string)
  default     = []
}

variable "managed_rule_groups" {
  type = list(string)
  default = [
    "AWSManagedRulesCommonRuleSet",
    "AWSManagedRulesKnownBadInputsRuleSet",
    "AWSManagedRulesAmazonIpReputationList",
  ]
}

variable "waf_block_managed_rules" {
  description = "False keeps managed rule groups in COUNT mode (tuning); true blocks."
  type        = bool
  default     = false
}

variable "waf_logs_kms_key_arn" {
  description = "us-east-1 KMS key for the WAF log group."
  type        = string
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "rate_limit_per_5min" {
  description = "Per-IP request limit over 5 minutes for the whole API host. Null disables the rule."
  type        = number
  default     = null
}

variable "auth_rate_limit_per_5min" {
  description = "Stricter per-IP limit for /api/v1/auth/*. Null disables the rule."
  type        = number
  default     = null
}

variable "rate_rules_block" {
  description = "False keeps the rate rules in COUNT mode (tuning); true blocks."
  type        = bool
  default     = false
}
