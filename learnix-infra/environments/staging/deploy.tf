# OIDC role for the backend pipeline, bound to the repository's `staging` GitHub environment. The frontend
# deploys through Vercel and gets no AWS role.
locals {
  backend_services = concat([module.api], module.worker, [module.migrate])
}

module "deploy_api" {
  source = "../../modules/deploy-role"
  count  = var.app_repositories.api == null ? 0 : 1

  name               = "${local.name}-gha-deploy-api"
  github_repository  = var.app_repositories.api
  github_environment = "staging"

  cluster_name             = module.ecs.cluster_name
  cluster_arn              = module.ecs.cluster_arn
  service_names            = var.split_roles ? ["api", "worker"] : ["api"]
  task_definition_families = [for s in local.backend_services : s.task_definition_family]
  ecr_repository_arns      = [module.ecs.repository_arns["api"]]
  pass_role_arns           = flatten([for s in local.backend_services : [s.task_role_arn, s.execution_role_arn]])
  log_group_names          = [module.migrate.log_group_name]
}
