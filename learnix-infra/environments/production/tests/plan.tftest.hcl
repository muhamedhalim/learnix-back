# Offline plan of the production stack against mocked providers: dependency cycles, count/for_each inputs,
# type errors and variable validations, without touching AWS.

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "210987654321", arn = "arn:aws:iam::210987654321:user/test", user_id = "AIDATEST" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws", dns_suffix = "amazonaws.com" }
  }
  mock_data "aws_region" {
    defaults = { name = "eu-central-1", region = "eu-central-1" }
  }
  mock_data "aws_elb_service_account" {
    defaults = { arn = "arn:aws:iam::054676820928:root" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}

mock_provider "aws" {
  alias = "us_east_1"
  mock_data "aws_caller_identity" {
    defaults = { account_id = "210987654321" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
  mock_data "aws_region" {
    defaults = { name = "us-east-1", region = "us-east-1" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}

mock_provider "aws" {
  alias = "dr"
  mock_data "aws_caller_identity" {
    defaults = { account_id = "210987654321" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
  mock_data "aws_region" {
    defaults = { name = "eu-west-1", region = "eu-west-1" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}

variables {
  admin_email     = "admin@example.test"
  mail_from_email = "no-reply@example.test"
}

run "dns_zone_copy_keeps_vercel_records" {
  command = plan

  # F-12: only migrate receives the application role's credentials (it creates the role); api and worker
  # use the role through DB_USER / DB_PASSWORD and never see APP_DB_*. Values are unknown until apply.
  assert {
    condition     = contains(keys(module.migrate.secret_refs), "APP_DB_USER") && contains(keys(module.migrate.secret_refs), "APP_DB_PASSWORD")
    error_message = "migrate must receive the application database role credentials."
  }
  assert {
    condition     = !contains(keys(module.api.secret_refs), "APP_DB_PASSWORD") && !contains(keys(module.worker.secret_refs), "APP_DB_PASSWORD")
    error_message = "api and worker must not receive APP_DB_PASSWORD."
  }

  variables {
    dns_provider = "route53"
    dns_records = [
      { name = "learnix.school", type = "MX", ttl = 300, records = ["10 mx.example.test"] },
      { name = "www.learnix.school", type = "CNAME", ttl = 300, records = ["cname.vercel-dns.com"] },
    ]
  }

  # The backend's production-mode env validation refuses to boot without these (learnix-back
  # src/config/env.validation.ts); keep this list in sync with it.
  assert {
    condition     = alltrue([for k in ["NODE_ENV", "APP_ENV", "FRONTEND_URL", "BACKEND_URL", "CORS_ORIGINS", "PAYMENT_CAPTURE_GRACE_SECONDS", "PAYMENT_PROVIDER_CLOCK_SKEW_SECONDS", "DB_HOST", "DB_NAME", "REDIS_HOST", "S3_BUCKET", "MAIL_PROVIDER", "SMS_PROVIDER", "PUSH_PROVIDER", "ADMIN_INIT_EMAIL", "MARKETPLACE_ENABLED"] : contains(output.app_environment_keys, k)])
    error_message = "A variable the backend requires in production mode is missing from the task environment."
  }

  # Vercel keeps the frontend: the frontend origin is the apex, the API is its own host, CORS is an exact
  # allowlist (no wildcard, no preview URLs) and playback is served from the API host.
  assert {
    condition     = output.app_origins.FRONTEND_URL == "https://learnix.school" && output.app_origins.BACKEND_URL == "https://api.learnix.school"
    error_message = "FRONTEND_URL is the Vercel apex; BACKEND_URL is the API host."
  }

  assert {
    condition     = output.app_origins.CORS_ORIGINS == "https://learnix.school" && output.app_origins.VIDEO_PUBLIC_ORIGIN == "https://api.learnix.school"
    error_message = "CORS allows only the frontend origin; signed playback cookies are issued for the API host."
  }

  assert {
    condition     = !strcontains(output.app_origins.CORS_ORIGINS, "*") && !strcontains(output.app_origins.CORS_ORIGINS, "vercel.app")
    error_message = "No wildcard and no preview URL may reach the production CORS allowlist."
  }

  # No frontend hosting on AWS.
  assert {
    condition     = join(",", sort(keys(module.ecs.repository_urls))) == "api"
    error_message = "Only the api image repository exists; the frontend is not built or hosted on AWS."
  }

  assert {
    condition     = join(",", keys(output.deploy_roles)) == "api"
    error_message = "Only the backend pipeline gets an AWS deploy role."
  }

  # First apply: nothing may start tasks before an image exists in ECR.
  assert {
    condition     = length(module.worker.autoscaling_policies) == 0 && length(module.api.autoscaling_policies) == 0
    error_message = "Autoscaling targets must not exist while desired counts are 0 (min_capacity would start tasks without an image)."
  }

  assert {
    condition     = module.synthetics.started == false
    error_message = "The canary must stay stopped until the traffic switch."
  }

  assert {
    condition     = output.task_network.assignPublicIp == "DISABLED"
    error_message = "Production one-shot tasks run in the private app subnets without a public IP."
  }

  assert {
    condition     = module.backup.has_plan && !module.backup_dr_vault.has_plan
    error_message = "One backup plan in the primary region; the DR vault only receives copies."
  }
}

run "api_host_live_with_everything_on" {
  command = plan

  variables {
    dns_provider          = "route53"
    certificate_enabled   = true
    cors_extra_origins    = ["https://www.learnix.school"]
    api_desired_count     = 2
    worker_desired_count  = 1
    waf_block             = true
    video_public_key_pem  = "-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----"
    inject_vapid          = true
    inject_cloudfront_key = true
    extra_secrets = {
      EASYKASH_API_KEY = { secret = "easykash", key = "EASYKASH_API_KEY" }
    }
    canary_enabled   = true
    app_repositories = { api = "learnix/learnix-back" }
    sms_sender_id    = "LEARNIX"
  }

  assert {
    condition     = length(module.deploy_api) == 1
    error_message = "The backend pipeline gets an OIDC deploy role."
  }

  assert {
    condition     = output.app_origins.CORS_ORIGINS == "https://learnix.school,https://www.learnix.school"
    error_message = "An explicitly listed extra origin joins the allowlist; nothing else does."
  }

  assert {
    condition     = length(aws_route53_record.api) == 2 && aws_route53_record.api["A"].name == "api.learnix.school"
    error_message = "With the certificate enabled the API host gets A and AAAA aliases (only this name is new in the zone)."
  }

  assert {
    condition     = strcontains(output.deploy_health_alarms, "-alb-elb-5xx") && strcontains(output.deploy_health_alarms, "-application-errors") && !strcontains(output.deploy_health_alarms, "canary") && !strcontains(output.deploy_health_alarms, "backlog")
    error_message = "The deploy watches release-sensitive alarms only; alarms that breach on missing data (canary, backlog) would roll back every deploy."
  }

  assert {
    condition     = join(",", module.worker.autoscaling_policies) == "cpu,queue"
    error_message = "The worker scales on queue backlog per task and on CPU."
  }

  assert {
    condition     = join(",", module.api.autoscaling_policies) == "cpu"
    error_message = "Only the worker scales on queue depth."
  }

  assert {
    condition     = join(",", module.api.container_names) == "api,otel-init,cloudwatch-agent"
    error_message = "With Application Signals on, the api task has the app, the ADOT init container and the CloudWatch agent."
  }

  assert {
    condition     = module.synthetics.started == true
    error_message = "canary_enabled starts the canary."
  }
}

run "rejects_preview_urls_in_production_cors" {
  command = plan

  variables {
    cors_extra_origins = ["https://learnix-git-main-team.vercel.app"]
  }

  expect_failures = [var.cors_extra_origins]
}

run "rejects_wildcard_origin" {
  command = plan

  variables {
    cors_extra_origins = ["https://*.learnix.school"]
  }

  expect_failures = [var.cors_extra_origins]
}

# Default: Cloudflare stays authoritative (the apex and www are proxied to Vercel there).
run "cloudflare_default_creates_no_zone" {
  command = plan

  variables {
    dns_records = [
      { name = "learnix.school", type = "MX", ttl = 300, records = ["10 mx.example.test"] },
    ]
  }

  assert {
    condition     = length(aws_route53_zone.this) == 0 && length(aws_route53_record.existing) == 0
    error_message = "With dns_provider = cloudflare Terraform must not create or fill a Route 53 zone."
  }

  assert {
    condition     = length(aws_acm_certificate.api) == 0 && length(aws_acm_certificate_validation.api) == 0
    error_message = "No certificate is requested until certificate_enabled."
  }
}

run "cloudflare_certificate_waits_for_the_operators_record" {
  command = plan

  variables {
    certificate_enabled = true
  }

  assert {
    condition     = length(aws_acm_certificate.api) == 1 && length(aws_acm_certificate_validation.api) == 0 && length(aws_route53_record.api_validation) == 0
    error_message = "The certificate is requested, but nothing waits for validation (or attaches the alias) until certificate_validated."
  }
}

run "lean_launch_sizing_plans_cleanly" {
  command = plan

  variables {
    api_min_count        = 1
    db_multi_az          = false
    valkey_node_count    = 1
    api_desired_count    = 1
    worker_desired_count = 1
  }

  assert {
    condition     = var.api_min_count == 1 && var.db_multi_az == false && var.valkey_node_count == 1
    error_message = "The lean launch values must be accepted by the stack."
  }
}

run "rejects_zero_api_min_count" {
  command = plan

  variables {
    api_min_count = 0
  }

  expect_failures = [var.api_min_count]
}

run "rejects_zero_valkey_nodes" {
  command = plan

  variables {
    valkey_node_count = 0
  }

  expect_failures = [var.valkey_node_count]
}

run "cloudflare_certificate_validated_attaches_alias" {
  command = plan

  variables {
    certificate_enabled   = true
    certificate_validated = true
  }

  assert {
    condition     = length(aws_acm_certificate_validation.api) == 1 && length(aws_route53_record.api) == 0
    error_message = "Once validated the alias is attached; the api CNAME is published through cloudflare_dns_records, not Route 53."
  }
}
