output "frontend_url" {
  description = "Where the frontend is served (Vercel, unchanged)."
  value       = local.frontend_url
}

output "api_url" {
  description = "Public API origin (api host behind CloudFront + WAF). NEXT_PUBLIC_API_URL for the Vercel production environment."
  value       = local.api_url
}

# Values the operator copies into Vercel (Project > Settings > Environment Variables) and the provider
# dashboards. Terraform never writes to Vercel. Public values only.
output "vercel_environment" {
  description = "Production-scope Vercel variables; apply them only at launch (the existing production values are not overwritten by this stack)."
  value = {
    NEXT_PUBLIC_API_URL                 = local.api_url
    NEXT_PUBLIC_SITE_URL                = local.frontend_url
    NEXT_PUBLIC_APP_ENV                 = "production"
    NEXT_PUBLIC_RUM_APP_MONITOR_ID      = module.rum.app_monitor_id
    NEXT_PUBLIC_RUM_IDENTITY_POOL_ID    = module.rum.identity_pool_id
    NEXT_PUBLIC_RUM_GUEST_ROLE_ARN      = module.rum.guest_role_arn
    NEXT_PUBLIC_RUM_REGION              = module.rum.region
    NEXT_PUBLIC_RUM_SESSION_SAMPLE_RATE = tostring(var.rum_session_sample_rate)
  }
}

output "provider_callback_urls" {
  description = "Callback and webhook URLs to register in the provider dashboards (Paymob, Meta, Zoom/Google/Microsoft). They point at the API host, not at the Vercel site."
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
  description = "dns_provider = route53 only: set these as the domain's name servers at the registrar (Name.com) after the dig diff is clean. Null with cloudflare."
  value       = one(aws_route53_zone.this[*].name_servers)
}

# Everything DNS has to contain for AWS, when Cloudflare stays authoritative. Add each as DNS only (grey cloud,
# never proxied). Records already in the zone (MX, DMARC with its rua, Vercel's apex and www) are not touched,
# and Terraform deliberately publishes no DMARC record here: keep the existing one.
output "cloudflare_dns_records" {
  description = "Records to add in Cloudflare when dns_provider = cloudflare: ACM validation (after certificate_enabled), the api CNAME (after certificate_validated) and the SES DKIM / MAIL FROM records."
  value = local.route53 ? [] : concat(
    [for o in(var.certificate_enabled ? aws_acm_certificate.api[0].domain_validation_options : []) : { name = o.resource_record_name, type = o.resource_record_type, value = o.resource_record_value, note = "ACM validation for the API certificate" }],
    local.certificate_issued ? [{ name = local.api_host, type = "CNAME", value = module.cdn.domain_name, note = "API host: CloudFront (DNS only)" }] : [],
    module.messaging.dns_records_required,
    [{ name = var.domain_name, type = "CAA", value = "0 issue \"amazon.com\"", note = "Only if the zone has CAA records: ACM cannot issue otherwise (add alongside the existing issuers)" }],
  )
}

output "ecr_repositories" {
  value = module.ecs.repository_urls
}

output "ecs_cluster" {
  value = module.ecs.cluster_name
}

output "deploy_health_alarms" {
  description = "GitHub environment variable DEPLOY_ALARMS: comma-separated alarms ecs-deploy.sh watches around a release."
  value       = join(",", module.observability.deploy_health_alarms)
}

output "migrate_task_definition_family" {
  value = module.migrate.task_definition_family
}

output "task_network" {
  description = "awsvpcConfiguration for `aws ecs run-task` (migrate): private app subnets, no public IP (egress through NAT). Passed verbatim by scripts/ecs-deploy.sh --network (GitHub variable TASK_NETWORK)."
  value = {
    subnets        = module.network.app_subnet_ids
    securityGroups = [aws_security_group.app.id]
    assignPublicIp = "DISABLED"
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

output "nat_egress_ips" {
  description = "Static egress addresses: allowlist these where a provider requires fixed source IPs."
  value       = module.network.nat_public_ips
}

output "dr_backup_replication_arn" {
  value = aws_db_instance_automated_backups_replication.dr.id
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
output "backup_vaults" {
  value = {
    primary = module.backup.vault_name
    dr      = module.backup_dr_vault.vault_arn
  }
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
