variable "region" {
  type    = string
  default = "eu-central-1"
}

variable "dr_region" {
  description = "Recovery region for replicated database backups."
  type        = string
  default     = "eu-west-1"
}

variable "project" {
  type    = string
  default = "learnix"
}

variable "owner" {
  type    = string
  default = "platform"
}

variable "cost_center" {
  type    = string
  default = "learnix"
}

# --- Domain: Vercel keeps the frontend, AWS serves the API host ----------------------------------------
variable "domain_name" {
  description = "The production apex, learnix.school. The frontend stays on Vercel at this name; this stack adds the API host under it."
  type        = string
  default     = "learnix.school"
}

variable "api_subdomain" {
  description = "Label of the API host under domain_name (api -> api.learnix.school). This is NEXT_PUBLIC_API_URL for the Vercel production environment, the EasyKash/Meta/OAuth callback host and the playback origin."
  type        = string
  default     = "api"

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?$", var.api_subdomain))
    error_message = "api_subdomain must be a single DNS label."
  }
}

variable "cors_extra_origins" {
  description = "Additional exact https origins allowed to call the API with credentials (for example a second Vercel production domain such as https://www.learnix.school). No wildcards and no *.vercel.app preview URLs: previews talk to staging, never to production."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for o in var.cors_extra_origins : can(regex("^https://[a-z0-9.-]+$", o))])
    error_message = "cors_extra_origins entries must be https origins without a path or wildcard."
  }
  validation {
    condition     = alltrue([for o in var.cors_extra_origins : !endswith(o, ".vercel.app")])
    error_message = "Vercel preview URLs must never be allowed to call the production API."
  }
}

variable "dns_records" {
  description = "EVERY record in the current (Cloudflare) zone, including the apex and www records that point at Vercel (copy the values Vercel shows for the domain; do not invent them), EXCEPT any _dmarc record Terraform manages for SES. Exported and reviewed before the name-server change; identical resolution before and after is the Phase 6 acceptance test."
  type = list(object({
    name    = string
    type    = string
    ttl     = number
    records = list(string)
  }))
  default = []
}

variable "dns_provider" {
  description = "Who answers DNS for the domain. \"cloudflare\" (default, the audited live setup: the apex and www are proxied to Vercel there): Terraform creates NO Route 53 zone and publishes every record it needs as the output cloudflare_dns_records for an operator to add (DNS only, not proxied). \"route53\": Terraform owns the zone, copies var.dns_records into it and writes the records itself (requires the registrar name-server change)."
  type        = string
  default     = "cloudflare"

  validation {
    condition     = contains(["cloudflare", "route53"], var.dns_provider)
    error_message = "dns_provider must be cloudflare or route53."
  }
}

variable "certificate_enabled" {
  description = "Request the us-east-1 certificate for the API host. With dns_provider = route53 it is validated and attached in the same apply (needs the zone to be authoritative). With cloudflare, apply once, add the validation record from the cloudflare_dns_records output (and a CAA record allowing amazon.com if the zone has CAA records), then set certificate_validated."
  type        = bool
  default     = false
}

variable "certificate_validated" {
  description = "dns_provider = cloudflare only: the ACM validation record exists in Cloudflare. Waits for issuance, attaches the alias to the distribution and outputs the api.<domain> CNAME to add (DNS only)."
  type        = bool
  default     = false
}

# --- Application ---------------------------------------------------------------------------------
variable "image_tag" {
  description = "Immutable tag of the first image (the pipeline deploys later ones). Also reported as GIT_SHA."
  type        = string
  default     = "bootstrap"
}

variable "api_desired_count" {
  type    = number
  default = 0
}

variable "worker_desired_count" {
  type    = number
  default = 0
}

variable "admin_email" {
  description = "Bootstrap admin account (ADMIN_INIT_EMAIL). The password is generated into Secrets Manager."
  type        = string
}

variable "mail_from_email" {
  description = "Sender on the verified SES identity, e.g. no-reply@learnix.school."
  type        = string
}

variable "vapid_subject" {
  type    = string
  default = "mailto:ops@learnix.school"
}

variable "dmarc_policy" {
  description = "none while warming up; quarantine after 30 days of clean reports."
  type        = string
  default     = "none"
}

variable "video_public_key_pem" {
  description = "Public half of the playback signing key. Null leaves /video/* unrouted."
  type        = string
  default     = null
}

variable "inject_vapid" {
  type    = bool
  default = false
}

variable "inject_cloudfront_key" {
  type    = bool
  default = false
}

variable "extra_secrets" {
  description = "ENV_NAME => {secret = <easykash|meta-whatsapp|meetings>, key = <json key>}."
  type = map(object({
    secret = string
    key    = string
  }))
  default = {}
}

variable "extra_environment" {
  description = "Additional non-secret environment variables for api/worker/migrate (e.g. EASYKASH_CASH_EXPIRY_HOURS)."
  type        = map(string)
  default     = {}
}

# --- Edge protection -----------------------------------------------------------------------------
variable "waf_block" {
  description = "False: managed rule groups and rate rules only COUNT (tune on real traffic). True: they block."
  type        = bool
  default     = false
}

variable "rate_limit_per_5min" {
  description = "Per-IP requests per 5 minutes. Generous on purpose: schools and carriers share addresses behind NAT."
  type        = number
  default     = 6000
}

variable "auth_rate_limit_per_5min" {
  type    = number
  default = 100
}

# --- Sizing --------------------------------------------------------------------------------------
variable "db_instance_class" {
  type    = string
  default = "db.t4g.small"
}

variable "valkey_node_type" {
  type    = string
  default = "cache.t4g.micro"
}

variable "nat_gateway_count" {
  description = "1 in Stage 1 (egress depends on one AZ); 2 from Stage 2."
  type        = number
  default     = 1
}

variable "alert_emails" {
  type    = list(string)
  default = []
}

# --- Observability, hardening, scaling -----------------------------------------------------------
variable "application_signals_enabled" {
  description = "ADOT auto-instrumentation + CloudWatch agent sidecar on api and worker (X-Ray traces, Application Signals). Needs Application Signals enabled once per account (runbook)."
  type        = bool
  default     = true
}

variable "read_only_root_filesystem" {
  description = "Read-only root filesystem for api and worker. Staging has run with it since 2026-10-13; set false only to debug."
  type        = bool
  default     = true
}

variable "worker_max_count" {
  type    = number
  default = 4
}

variable "worker_backlog_per_task" {
  description = "Target queued jobs per worker task for queue-depth autoscaling."
  type        = number
  default     = 100
}

variable "rum_session_sample_rate" {
  type    = number
  default = 0.25
}

variable "canary_enabled" {
  description = "Start the Synthetics heartbeat canary. Set true once the API host is live (it checks the API and, from outside AWS, the Vercel site)."
  type        = bool
  default     = false
}

variable "backup_monthly_retention_days" {
  type    = number
  default = 365
}

# --- Application pipelines -----------------------------------------------------------------------
variable "app_repositories" {
  description = "OWNER/REPO of the backend repository whose GitHub Actions may deploy here (OIDC). Null skips that role. The frontend is deployed by Vercel and needs none."
  type = object({
    api = optional(string)
  })
  default = {}
}

# --- SMS (AWS End User Messaging) ----------------------------------------------------------------
variable "sms_sender_id" {
  description = "Registered Egypt alphanumeric sender ID (or its ARN / a pool ARN). Null until the registration is approved."
  type        = string
  default     = null
}

variable "sms_protect_configuration_id" {
  description = "Protect configuration that allows only Egypt (+20) destinations (created in the console; see AWS-DEPLOYMENT-RUNBOOK.md)."
  type        = string
  default     = null
}
