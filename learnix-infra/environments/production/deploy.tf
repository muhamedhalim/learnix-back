# OIDC role for the backend pipeline (learnix-back deploys api + worker + migrate), bound to the repository's
# `production` GitHub environment (required reviewers). The frontend deploys through Vercel's Git integration
# and gets no AWS role.
module "deploy_api" {
  source = "../../modules/deploy-role"
  count  = var.app_repositories.api == null ? 0 : 1

  name               = "${local.name}-gha-deploy-api"
  github_repository  = var.app_repositories.api
  github_environment = "production"

  cluster_name             = module.ecs.cluster_name
  cluster_arn              = module.ecs.cluster_arn
  service_names            = ["api", "worker"]
  task_definition_families = [module.api.task_definition_family, module.worker.task_definition_family, module.migrate.task_definition_family]
  ecr_repository_arns      = [module.ecs.repository_arns["api"]]
  pass_role_arns = [
    module.api.task_role_arn, module.api.execution_role_arn,
    module.worker.task_role_arn, module.worker.execution_role_arn,
    module.migrate.task_role_arn, module.migrate.execution_role_arn,
  ]
  log_group_names = [module.migrate.log_group_name]
  db_instance_arn = module.database.arn
}
