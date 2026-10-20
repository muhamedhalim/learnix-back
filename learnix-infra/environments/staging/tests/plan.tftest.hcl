# Offline plan of the whole staging stack against mocked providers: catches dependency cycles,
# bad for_each/count inputs, type errors and variable validation without touching AWS.

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012", arn = "arn:aws:iam::123456789012:user/test", user_id = "AIDATEST" }
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
    defaults = { account_id = "123456789012" }
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


variables {
  admin_email        = "admin@staging.example.test"
  mail_from_email    = "no-reply@staging.example.test"
  mail_allowlist     = ["qa@example.test"]
  allowed_ipv4_cidrs = ["203.0.113.0/24"]
  frontend_url       = "https://staging-web.example.test"
}

run "default_stage_one" {
  command = plan

  # F-12: only migrate receives the application role's credentials (it creates the role); api and worker
  # use the role through DB_USER / DB_PASSWORD and never see APP_DB_*. Values are unknown until apply.
  assert {
    condition     = contains(keys(module.migrate.secret_refs), "APP_DB_USER") && contains(keys(module.migrate.secret_refs), "APP_DB_PASSWORD")
    error_message = "migrate must receive the application database role credentials."
  }
  assert {
    condition     = !contains(keys(module.api.secret_refs), "APP_DB_PASSWORD")
    error_message = "api and worker must not receive APP_DB_PASSWORD."
  }

  # Vercel hosts the staging frontend; AWS serves the API on the distribution's own name until the custom
  # domain exists. CORS is exactly the frontend origin.
  assert {
    condition     = output.app_origins.FRONTEND_URL == "https://staging-web.example.test" && output.app_origins.CORS_ORIGINS == "https://staging-web.example.test"
    error_message = "FRONTEND_URL and CORS_ORIGINS are the Vercel staging origin."
  }

  assert {
    condition     = join(",", sort(keys(module.ecs.repository_urls))) == "api" && join(",", keys(output.deploy_roles)) == "api"
    error_message = "Staging builds and hosts no frontend image and creates no frontend deploy role."
  }

  assert {
    condition     = !strcontains(output.app_origins.CORS_ORIGINS, "*")
    error_message = "No wildcard in the staging CORS allowlist."
  }

  # The backend's production-mode env validation refuses to boot without these (learnix-back
  # src/config/env.validation.ts); keep this list in sync with it.
  assert {
    condition     = alltrue([for k in ["NODE_ENV", "APP_ENV", "FRONTEND_URL", "BACKEND_URL", "CORS_ORIGINS", "PAYMENT_CAPTURE_GRACE_SECONDS", "PAYMENT_PROVIDER_CLOCK_SKEW_SECONDS", "DB_HOST", "DB_NAME", "REDIS_HOST", "S3_BUCKET", "MAIL_PROVIDER", "SMS_PROVIDER", "PUSH_PROVIDER", "ADMIN_INIT_EMAIL", "MARKETPLACE_ENABLED"] : contains(output.app_environment_keys, k)])
    error_message = "A variable the backend requires in production mode is missing from the task environment."
  }
}

run "custom_domain_with_split_roles_and_video" {
  command = plan

  variables {
    domain_name           = "staging.example.test"
    frontend_url          = null
    custom_domain_enabled = true
    split_roles           = true
    api_desired_count     = 2
    worker_desired_count  = 1
    video_public_key_pem  = "-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----"
    inject_vapid          = true
    inject_cloudfront_key = true
    extra_secrets = {
      EASYKASH_API_KEY = { secret = "easykash", key = "EASYKASH_API_KEY" }
    }
    app_repositories = { api = "learnix/learnix-back" }
    sms_sender_id    = "LEARNIX"
  }

  assert {
    condition     = join(",", module.worker[0].autoscaling_policies) == "cpu,queue"
    error_message = "The split staging worker scales on queue depth and CPU."
  }

  assert {
    condition     = length(module.deploy_api) == 1
    error_message = "The backend pipeline gets an OIDC deploy role."
  }

  assert {
    condition     = output.frontend_url == "https://staging.example.test" && output.api_url == "https://api.staging.example.test"
    error_message = "With a delegated zone the Vercel staging frontend is the zone apex and the API is api.<zone>."
  }

  assert {
    condition     = output.app_origins.CORS_ORIGINS == "https://staging.example.test"
    error_message = "CORS allows only the staging frontend origin."
  }

  assert {
    condition     = output.app_origins.BACKEND_URL == "https://api.staging.example.test" && output.app_origins.VIDEO_PUBLIC_ORIGIN == "https://api.staging.example.test"
    error_message = "The API and the playback origin are the AWS host, separate from the frontend."
  }

  assert {
    condition     = length(aws_route53_record.api) == 2 && aws_route53_record.api["A"].name == "api.staging.example.test"
    error_message = "The API host gets A and AAAA aliases."
  }
}

run "rejects_custom_domain_without_a_name" {
  command = plan

  variables {
    custom_domain_enabled = true
  }

  expect_failures = [var.custom_domain_enabled]
}

run "rejects_empty_mail_allowlist" {
  command = plan

  variables {
    mail_allowlist = []
  }

  expect_failures = [var.mail_allowlist]
}

run "rejects_missing_frontend_origin" {
  command = plan

  variables {
    frontend_url = null
  }

  expect_failures = [var.frontend_url]
}

run "rejects_wildcard_cors_origin" {
  command = plan

  variables {
    cors_extra_origins = ["https://*.vercel.app"]
  }

  expect_failures = [var.cors_extra_origins]
}
