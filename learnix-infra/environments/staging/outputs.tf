output "frontend_url" {
  description = "Origin of the staging frontend (Vercel)."
  value       = local.frontend_url
}

output "api_url" {
  description = "Public staging API origin. NEXT_PUBLIC_API_URL for the Vercel staging/preview environment."
  value       = local.api_url
}

# Values the operator copies into the Vercel staging scope (a branch-scoped Preview variable or a custom
# environment). Terraform never writes to Vercel. Public values only.
output "vercel_environment" {
  value = {
    NEXT_PUBLIC_API_URL                 = local.api_url
    NEXT_PUBLIC_SITE_URL                = local.frontend_url
    NEXT_PUBLIC_APP_ENV                 = "staging"
    NEXT_PUBLIC_RUM_APP_MONITOR_ID      = module.rum.app_monitor_id
    NEXT_PUBLIC_RUM_IDENTITY_POOL_ID    = module.rum.identity_pool_id
    NEXT_PUBLIC_RUM_GUEST_ROLE_ARN      = module.rum.guest_role_arn
    NEXT_PUBLIC_RUM_REGION              = module.rum.region
    NEXT_PUBLIC_RUM_SESSION_SAMPLE_RATE = "1"
  }
}

output "provider_callback_urls" {
  description = "Sandbox/test callback URLs for the provider dashboards (Paymob test, Meta test app, OAuth test apps). They point at the API host."
  value = {
    paymob_webhook         = "${local.api_url}/api/v1/payments/webhook"
    paymob_webhook_alt     = "${local.api_url}/api/v1/payments/webhook/callback"
    paymob_marketplace     = "${local.api_url}/api/v1/marketplace/webhooks/payment"
    meta_whatsapp_webhook  = "${local.api_url}/api/v1/webhooks/whatsapp"
    meeting_oauth_callback = "${local.api_url}/api/v1/teacher/meeting-accounts/callback"
  }
}

# Effective origin configuration of api/worker/migrate, asserted by tests/plan.tftest.hcl.
output "app_origins" {
  value = local.origin_environment
}

output "cloudfront_domain_name" {
  value = module.cdn.domain_name
}

output "cloudfront_distribution_id" {
  value = module.cdn.distribution_id
}

output "name_servers" {
  description = "Add these as NS records for var.domain_name in the parent zone (stage 1 -> stage 2 of the custom domain)."
  value       = one(aws_route53_zone.this[*].name_servers)
}

output "ecr_repositories" {
  value = module.ecs.repository_urls
}

output "ecs_cluster" {
  value = module.ecs.cluster_name
}

output "migrate_task_definition_family" {
  value = module.migrate.task_definition_family
}

output "task_network" {
  description = "awsvpcConfiguration for `aws ecs run-task` (migrate): public subnets with a public IP (staging has no NAT). Passed verbatim by scripts/ecs-deploy.sh --network (GitHub variable TASK_NETWORK)."
  value = {
    subnets        = module.network.public_subnet_ids
    securityGroups = [aws_security_group.app.id]
    assignPublicIp = "ENABLED"
  }
}

output "secrets" {
  description = "Secret containers. core and valkey are filled by Terraform (write-only); the others are filled by an operator."
  value = {
    core     = module.secrets.core_arn
    valkey   = module.cache.auth_secret_arn
    database = module.database.master_secret_arn
    external = module.secrets.external_arns
  }
}

output "buckets" {
  value = {
    files        = module.files_bucket.id
    video_source = module.media.source_bucket.id
    video_output = module.media.output_bucket.id
    logs         = module.logs_bucket.id
  }
}

output "alerts_topic_arn" {
  value = module.observability.alerts_topic_arn
}

output "cloudfront_key_pair_id" {
  description = "CLOUDFRONT_KEY_PAIR_ID (null until video_public_key_pem is provided)."
  value       = module.cdn.video_key_pair_id
}

# Public values for the NEXT_PUBLIC_RUM_* variables of the Vercel build (see vercel_environment).
output "rum" {
  value = {
    app_monitor_id   = module.rum.app_monitor_id
    identity_pool_id = module.rum.identity_pool_id
    guest_role_arn   = module.rum.guest_role_arn
    region           = module.rum.region
  }
}

output "dashboard_name" {
  value = module.observability.dashboard_name
}

# Repository variable for the backend pipeline (AWS_DEPLOY_ROLE_ARN in learnix-back). The frontend has none.
output "deploy_roles" {
  value = {
    api = one(module.deploy_api[*].role_arn)
  }
}

# Names (not values) of the non-secret variables api/worker/migrate receive; asserted by tests/plan.tftest.hcl
# against what the backend requires in production mode.
output "app_environment_keys" {
  value = sort(keys(local.app_environment))
}
