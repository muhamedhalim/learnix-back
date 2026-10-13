variable "name" {
  type = string
}

variable "api_url" {
  description = "Public API origin the canary checks (it runs outside the VPC, like a user)."
  type        = string
}

variable "frontend_url" {
  description = "Optional origin of the Vercel-hosted frontend. When set, the canary also loads its public pages from outside AWS so a frontend outage pages too. Null skips those checks."
  type        = string
  default     = null
}

variable "checks" {
  description = "Ordered HTTP checks. target: api (default) or frontend. expect: optional substring the response body must contain."
  type = list(object({
    name   = string
    path   = string
    target = optional(string, "api")
    expect = optional(string)
  }))
  default = [
    { name = "api-readiness", path = "/api/v1/health/readiness" },
    { name = "public-catalog", path = "/api/v1/packages?limit=1" },
    { name = "home", path = "/ar", target = "frontend" },
    { name = "login-page", path = "/ar/auth/login", target = "frontend" },
  ]

  validation {
    condition     = alltrue([for c in var.checks : contains(["api", "frontend"], c.target)])
    error_message = "A check target is either api or frontend."
  }
}

variable "interval_minutes" {
  type    = number
  default = 5
}

variable "start" {
  description = "Start the canary on apply. False until the site is live (a canary against a dark site only pages)."
  type        = bool
  default     = false
}

variable "kms_key_arn" {
  type = string
}

variable "alarm_topic_arn" {
  type = string
}

variable "artifact_retention_days" {
  type    = number
  default = 31
}
