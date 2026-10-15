variable "name" {
  description = "Service and container name (web, api, worker)."
  type        = string
}

variable "cluster_arn" {
  type = string
}

variable "cluster_name" {
  type = string
}

variable "image" {
  description = "Initial image (repository URL + immutable tag). The deploy pipeline registers later revisions."
  type        = string
}

variable "cpu" {
  type = number
}

variable "memory" {
  type = number
}

variable "desired_count" {
  description = "Initial count. 0 until the first image is pushed; autoscaling (min_count..max_count) is attached only when this is above 0."
  type        = number
  default     = 0
}

variable "min_count" {
  type    = number
  default = 1
}

variable "max_count" {
  description = "Above min_count enables CPU target tracking."
  type        = number
  default     = 1
}

variable "cpu_target_percent" {
  type    = number
  default = 60
}

variable "container_port" {
  description = "Null for services with no listener (worker, migrate)."
  type        = number
  default     = null
}

variable "command" {
  type    = list(string)
  default = null
}

variable "environment" {
  description = "Non-secret environment variables."
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "Environment variable name -> Secrets Manager valueFrom (<secret arn>:<json key>::)."
  type        = map(string)
  default     = {}
}

variable "secret_arns" {
  description = "Secret ARNs the execution role may read (those referenced in var.secrets). Only used when var.secrets is non-empty."
  type        = list(string)
  default     = []
}

variable "attach_task_policy" {
  description = "True when task_policy_json is supplied. A plain bool because the policy document is unknown until apply."
  type        = bool
  default     = false
}

variable "task_policy_json" {
  description = "IAM policy for the task role (what the application itself may call)."
  type        = string
  default     = null
}

variable "kms_key_arn" {
  description = "Key for the log group and for decrypting secrets."
  type        = string
}

variable "subnet_ids" {
  type = list(string)
}

variable "security_group_ids" {
  type = list(string)
}

variable "assign_public_ip" {
  type    = bool
  default = false
}

variable "target_group_arn" {
  type    = string
  default = null
}

variable "health_check_grace_seconds" {
  type    = number
  default = 90
}

variable "read_only_root_filesystem" {
  description = "Hardening. Each path in writable_paths becomes a task volume. Fargate creates such a volume root-owned (0755) unless the image declares the same path with VOLUME after chown-ing it to the runtime user; both Learnix Dockerfiles do that for /tmp (and /app/.next/cache in web). Enabled in staging first; turn on in production once staging has run with it."
  type        = bool
  default     = false
}

variable "writable_paths" {
  description = "Container paths backed by ephemeral volumes (the root filesystem is read-only). Each must be declared with VOLUME in the image."
  type        = list(string)
  default     = ["/tmp"]
}

# --- CloudWatch Application Signals (ADOT auto-instrumentation + CloudWatch agent sidecar) -------
variable "application_signals" {
  description = "Adds the ADOT Node.js init container and a CloudWatch agent sidecar, and sets the OTEL_* variables on the app container (AWS docs: Application Signals on ECS, sidecar strategy). Traces go to X-Ray, RED metrics to Application Signals."
  type = object({
    enabled          = bool
    environment      = optional(string, "")
    agent_image      = optional(string, "public.ecr.aws/cloudwatch-agent/cloudwatch-agent:1.300073.2b1889")
    instrument_image = optional(string, "public.ecr.aws/aws-observability/adot-autoinstrumentation-node:v0.13.0")
    agent_cpu        = optional(number, 64)
    agent_memory_mib = optional(number, 128)
  })
  default = { enabled = false }
}

# --- Queue-depth autoscaling (worker) ------------------------------------------------------------
variable "queue_scaling" {
  description = "Target tracking on backlog per running task: (custom backlog metric) / (Container Insights RunningTaskCount). Null disables it. Requires max_count > min_count."
  type = object({
    namespace         = string
    metric_name       = string
    dimensions        = map(string)
    backlog_per_task  = number
    scale_in_cooldown = optional(number, 300)
  })
  default = null
}

variable "container_health_check" {
  description = "HTTP liveness check run inside the container by ECS (services without a load balancer, e.g. the worker). Use the liveness path, not readiness: a Redis or database blip must not make ECS kill every worker."
  type = object({
    port         = number
    path         = string
    interval     = optional(number, 30)
    timeout      = optional(number, 10)
    retries      = optional(number, 3)
    start_period = optional(number, 90)
  })
  default = null
}

variable "stop_timeout_seconds" {
  description = "Time to drain in-flight requests and jobs before SIGKILL (Fargate maximum is 120)."
  type        = number
  default     = 60
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "create_service" {
  description = "False for one-shot task definitions (migrate), which are run with `aws ecs run-task`."
  type        = bool
  default     = true
}
