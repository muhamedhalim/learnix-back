variable "region" {
  type    = string
  default = "eu-central-1"
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

# --- Access gate ---------------------------------------------------------------------------------
variable "allowed_ipv4_cidrs" {
  description = "Addresses that may reach staging (office / VPN / QA). Everything else is blocked by WAF."
  type        = list(string)
  default     = []
}

variable "allowed_ipv6_cidrs" {
  type    = list(string)
  default = []
}

variable "open_path_prefixes" {
  description = "Paths reachable from anywhere even behind the allowlist. Provider webhooks (HMAC-authenticated), and the two public read paths that Vercel's servers call themselves (the image optimizer and the sitemap fetch come from Vercel egress addresses, which cannot be allowlisted). Staging data is synthetic; testers' browsers call the API from their allowlisted addresses."
  type        = list(string)
  default = [
    "/api/v1/payments/webhook",
    "/api/v1/marketplace/webhooks/payment",
    "/api/v1/webhooks/whatsapp",
    "/api/v1/media/public/",
    "/api/v1/marketplace/courses",
  ]
}

# --- Domain: the staging frontend stays on Vercel, AWS serves the API host ------------------------
variable "domain_name" {
  description = "Delegated sub-zone for this environment, e.g. staging.learnix.school. Null keeps the default cloudfront.net name for the API. When set, the Vercel staging frontend is served at this name unless frontend_url says otherwise."
  type        = string
  default     = null
}

variable "frontend_url" {
  description = "Exact https origin of the Vercel staging frontend, when it is not https://<domain_name> (for example a stable branch URL). It becomes FRONTEND_URL and the first CORS origin."
  type        = string
  default     = null

  validation {
    condition     = var.frontend_url != null || var.domain_name != null
    error_message = "Staging needs the origin of its Vercel frontend: set frontend_url or domain_name."
  }
  validation {
    condition     = var.frontend_url == null || can(regex("^https://[a-z0-9.-]+$", var.frontend_url))
    error_message = "frontend_url must be an https origin without a path or wildcard."
  }
}

variable "api_subdomain" {
  description = "Label of the API host under domain_name (api -> api.staging.learnix.school) once custom_domain_enabled is true."
  type        = string
  default     = "api"

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?$", var.api_subdomain))
    error_message = "api_subdomain must be a single DNS label."
  }
}

variable "cors_extra_origins" {
  description = "Additional exact https origins allowed to call the staging API with credentials (for example a stable Vercel branch URL). No wildcards: a *.vercel.app pattern would trust every Vercel project."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for o in var.cors_extra_origins : can(regex("^https://[a-z0-9.-]+$", o))])
    error_message = "cors_extra_origins entries must be https origins without a path or wildcard."
  }
}

variable "dns_records" {
  description = "Records for the Vercel-hosted staging frontend inside the delegated zone (typically one A record at the zone apex; copy the value from Vercel's domain settings). Only used when domain_name is set."
  type = list(object({
    name    = string
    type    = string
    ttl     = number
    records = list(string)
  }))
  default = []
}

variable "custom_domain_enabled" {
  description = "Second stage: after NS records for domain_name are delegated to the zone, request the API certificate and attach the api.<domain_name> alias."
  type        = bool
  default     = false

  validation {
    condition     = !var.custom_domain_enabled || var.domain_name != null
    error_message = "custom_domain_enabled needs domain_name."
  }
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

variable "split_roles" {
  description = "False: one api service runs PROCESS_ROLE=all (cheapest). True: separate api and worker services (use to test the role split and cron locks)."
  type        = bool
  default     = false
}

variable "admin_email" {
  description = "Bootstrap admin account (ADMIN_INIT_EMAIL). The password is generated into Secrets Manager."
  type        = string
}

variable "mail_from_email" {
  description = "Sender; must be on a verified SES identity (staging domain) and distinct from production."
  type        = string
}

variable "mail_allowlist" {
  description = "Recipients staging may email (SES sandbox plus the app's own guard)."
  type        = list(string)

  validation {
    condition     = length(var.mail_allowlist) > 0
    error_message = "Staging must have a mail allowlist."
  }
}

variable "vapid_subject" {
  description = "mailto: contact for Web Push."
  type        = string
  default     = "mailto:ops@learnix.school"
}

variable "video_public_key_pem" {
  description = "Public half of the playback signing key. Null leaves /video/* unrouted (safe default). Create the pair with openssl and store the private half in the cloudfront-signing secret."
  type        = string
  default     = null
}

variable "inject_vapid" {
  description = "Inject VAPID keys into the tasks. Set true after the vapid secret has been filled."
  type        = bool
  default     = false
}

variable "inject_cloudfront_key" {
  description = "Inject the playback signing key into the tasks. Set true after the cloudfront-signing secret has been filled."
  type        = bool
  default     = false
}

variable "extra_secrets" {
  description = "Further task environment variables read from an operator-filled secret: ENV_NAME => {secret = <easykash|meta-whatsapp|meetings>, key = <json key>}."
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

# --- Sizing and safety ---------------------------------------------------------------------------
variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "valkey_node_type" {
  type    = string
  default = "cache.t4g.micro"
}

variable "alert_emails" {
  type    = list(string)
  default = []
}

variable "force_destroy" {
  description = "Allow terraform destroy to remove non-empty buckets and repositories. Staging holds only synthetic data."
  type        = bool
  default     = true
}

# --- Observability and hardening -----------------------------------------------------------------
variable "application_signals_enabled" {
  description = "ADOT auto-instrumentation + CloudWatch agent sidecar on api/worker (X-Ray traces, Application Signals). Needs Application Signals enabled once per account (runbook)."
  type        = bool
  default     = true
}

variable "read_only_root_filesystem" {
  description = "Read-only root filesystem for api and worker (writable /tmp). Staging proves it before production turns it on."
  type        = bool
  default     = true
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
