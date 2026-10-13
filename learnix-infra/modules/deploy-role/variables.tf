variable "name" {
  type = string
}

variable "github_repository" {
  description = "OWNER/REPO of the application repository (learnix-back or learnix-front)."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository must look like OWNER/REPO."
  }
}

variable "github_environment" {
  description = "GitHub environment whose jobs may assume the role (staging or production, with required reviewers on production)."
  type        = string
}

variable "cluster_name" {
  type = string
}

variable "cluster_arn" {
  type = string
}

variable "service_names" {
  type = list(string)
}

variable "task_definition_families" {
  description = "Families the pipeline may register and run (services plus one-shot tasks such as migrate)."
  type        = list(string)
}

variable "ecr_repository_arns" {
  type = list(string)
}

variable "pass_role_arns" {
  description = "Task and execution roles of those task definitions."
  type        = list(string)
}

variable "log_group_names" {
  description = "Log groups the pipeline may read (the migrate task's output)."
  type        = list(string)
  default     = []
}

variable "db_instance_arn" {
  description = "Set to allow a pre-deploy manual snapshot (production api pipeline)."
  type        = string
  default     = null
}
