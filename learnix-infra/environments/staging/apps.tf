locals {
  # Secret references injected as environment variables (ECS resolves them at task start).
  core_secret_keys = [
    "JWT_SECRET",
    "JWT_REFRESH_SECRET",
    "COOKIE_SECRET",
    "MEETING_TOKEN_ENCRYPTION_KEY",
    "PAYOUT_ACCOUNT_ENCRYPTION_KEY",
    "ADMIN_INIT_PASSWORD",
    "METRICS_BEARER_TOKEN",
  ]

  app_secrets = merge(
    {
      DB_USER          = "${module.database.master_secret_arn}:username::"
      DB_PASSWORD      = "${module.database.master_secret_arn}:password::"
      REDIS_AUTH_TOKEN = "${module.cache.auth_secret_arn}:REDIS_AUTH_TOKEN::"
    },
    { for k in local.core_secret_keys : k => "${module.secrets.core_arn}:${k}::" },
    var.inject_vapid ? {
      VAPID_PUBLIC_KEY  = "${module.secrets.external_arns["vapid"]}:VAPID_PUBLIC_KEY::"
      VAPID_PRIVATE_KEY = "${module.secrets.external_arns["vapid"]}:VAPID_PRIVATE_KEY::"
    } : {},
    var.inject_cloudfront_key ? {
      CLOUDFRONT_PRIVATE_KEY_B64 = "${module.secrets.external_arns["cloudfront-signing"]}:CLOUDFRONT_PRIVATE_KEY_B64::"
    } : {},
    { for k, v in var.extra_secrets : k => "${module.secrets.external_arns[v.secret]}:${v.key}::" },
  )

  app_secret_arns = distinct([for ref in values(local.app_secrets) : join(":", slice(split(":", ref), 0, 7))])

  # Vercel hosts the frontend (FRONTEND_URL); the API is its own public origin (BACKEND_URL) and also serves the
  # signed video playback (VIDEO_PUBLIC_ORIGIN). CORS is an exact-origin credentialed allowlist: the frontend plus
  # any explicitly listed extra origin. Kept apart so tests can read it even when other values are unknown.
  origin_environment = {
    FRONTEND_URL        = local.frontend_url
    BACKEND_URL         = local.api_url
    CORS_ORIGINS        = join(",", local.frontend_origins)
    VIDEO_PUBLIC_ORIGIN = local.api_url
  }

  # Non-secret configuration shared by api, worker and migrate (see learnix-back/docs/AWS_RUNTIME_ENV.md).
  app_environment = merge(
    local.origin_environment,
    {
      NODE_ENV             = "production"
      APP_ENV              = "staging"
      PORT                 = "3000"
      RUN_MIGRATIONS       = "false"
      TRUST_PROXY_HOPS     = "2"
      LOG_FORMAT           = "json"
      REQUIRE_TLS_BACKENDS = "true"
      GIT_SHA              = var.image_tag

      DB_HOST              = module.database.address
      DB_PORT              = tostring(module.database.port)
      DB_NAME              = module.database.database_name
      DATABASE_SSL_CA_FILE = "/app/certs/rds-ca-bundle.pem"

      REDIS_HOST      = module.cache.primary_endpoint
      REDIS_PORT      = tostring(module.cache.port)
      REDIS_NAMESPACE = "staging"

      S3_BUCKET              = module.files_bucket.id
      S3_REGION              = var.region
      AWS_REGION             = var.region
      VIDEO_SOURCE_BUCKET    = module.media.source_bucket.id
      VIDEO_OUTPUT_BUCKET    = module.media.output_bucket.id
      MEDIACONVERT_ROLE_ARN  = module.media.mediaconvert_role_arn
      MEDIA_EVENTS_QUEUE_URL = module.media.events_queue_url

      # Required in production mode (NODE_ENV=production on both): the app refuses to boot without them.
      PAYMENT_CAPTURE_GRACE_SECONDS       = "300"
      PAYMENT_PROVIDER_CLOCK_SKEW_SECONDS = "120"

      MAIL_PROVIDER         = "ses"
      SES_REGION            = var.region
      SES_CONFIGURATION_SET = module.messaging.ses_configuration_set
      MAIL_FROM_EMAIL       = var.mail_from_email
      MAIL_ALLOWLIST        = join(",", var.mail_allowlist)
      MAIL_EVENTS_QUEUE_URL = module.messaging.mail_events_queue_url

      SMS_PROVIDER              = "aws"
      SMS_MODE                  = "sandbox"
      SMS_AWS_CONFIGURATION_SET = module.messaging.sms_configuration_set
      SMS_EVENTS_QUEUE_URL      = module.messaging.sms_events_queue_url

      QUEUE_METRICS_NAMESPACE   = local.queue_metric.namespace
      QUEUE_METRICS_ENVIRONMENT = local.queue_metric.dimensions.Environment

      PUSH_PROVIDER = "webpush"
      VAPID_SUBJECT = var.vapid_subject

      PAYMOB_EXPECTED_MODE = "test"
      ADMIN_INIT_EMAIL     = var.admin_email
    },
    module.cdn.video_key_pair_id == null ? {} : { CLOUDFRONT_KEY_PAIR_ID = module.cdn.video_key_pair_id },
    # Egypt sender ID and the Egypt-only protect configuration exist only after AWS approves the
    # registration (runbook); until then the app logs that SMS is disabled.
    var.sms_sender_id == null ? {} : { SMS_AWS_ORIGINATION_IDENTITY = var.sms_sender_id },
    var.sms_protect_configuration_id == null ? {} : { SMS_AWS_PROTECT_CONFIGURATION_ID = var.sms_protect_configuration_id },
    var.extra_environment,
  )

  # Published every minute by the process that runs queue consumers (worker, or api with PROCESS_ROLE=all).
  queue_metric = {
    namespace   = "Learnix/Queues"
    metric_name = "QueueBacklog"
    dimensions  = { Environment = local.name }
  }

  files_arn  = module.files_bucket.arn
  source_arn = module.media.source_bucket.arn
  output_arn = module.media.output_bucket.arn
}

module "ecs" {
  source = "../../modules/ecs-cluster"

  name                      = local.name
  kms_key_arn               = module.kms.arn
  repositories              = ["api"]
  force_delete_repositories = var.force_destroy
}

# --- Task role policies --------------------------------------------------------------------------
# API: presign / verify / delete uploads and read output metadata. Worker: everything the API may do
# plus transcoding, mail, SMS and the event queues it consumes.
data "aws_iam_policy_document" "api" {
  statement {
    sid = "ObjectAccess"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:AbortMultipartUpload",
      "s3:ListMultipartUploadParts",
    ]
    resources = ["${local.files_arn}/*", "${local.source_arn}/*", "${local.output_arn}/*"]
  }
  statement {
    sid       = "ListBuckets"
    actions   = ["s3:ListBucket"]
    resources = [local.files_arn, local.source_arn, local.output_arn]
  }
  statement {
    sid       = "DecryptFiles"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [module.kms.arn]
  }
}

data "aws_iam_policy_document" "worker" {
  source_policy_documents = [data.aws_iam_policy_document.api.json]

  statement {
    sid       = "Transcode"
    actions   = ["mediaconvert:CreateJob", "mediaconvert:GetJob", "mediaconvert:ListJobs", "mediaconvert:DescribeEndpoints"]
    resources = ["arn:${data.aws_partition.current.partition}:mediaconvert:${var.region}:${local.account_id}:*"]
  }
  statement {
    sid       = "HandMediaConvertItsRole"
    actions   = ["iam:PassRole"]
    resources = [module.media.mediaconvert_role_arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["mediaconvert.amazonaws.com"]
    }
  }
  statement {
    sid       = "ConsumeEventQueues"
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"]
    resources = [module.media.events_queue_arn, module.messaging.mail_events_queue_arn, module.messaging.sms_events_queue_arn]
  }
  statement {
    sid     = "SendMail"
    actions = ["ses:SendEmail", "ses:SendRawEmail"]
    resources = [
      "arn:${data.aws_partition.current.partition}:ses:${var.region}:${local.account_id}:identity/*",
      "arn:${data.aws_partition.current.partition}:ses:${var.region}:${local.account_id}:configuration-set/${module.messaging.ses_configuration_set}",
    ]
  }
  statement {
    sid       = "PublishQueueMetrics"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = [local.queue_metric.namespace]
    }
  }
  statement {
    sid       = "SendSms"
    actions   = ["sms-voice:SendTextMessage"]
    resources = ["arn:${data.aws_partition.current.partition}:sms-voice:${var.region}:${local.account_id}:*"]
  }
}

# --- Services ------------------------------------------------------------------------------------
module "api" {
  source = "../../modules/ecs-service"

  # With one process type the service keeps the name "api" and runs every role; with the split it only serves HTTP.
  name         = "api"
  cluster_arn  = module.ecs.cluster_arn
  cluster_name = module.ecs.cluster_name
  image        = "${module.ecs.repository_urls["api"]}:${var.image_tag}"
  cpu          = 512
  memory       = 1024

  desired_count    = var.api_desired_count
  container_port   = 3000
  target_group_arn = module.alb.target_group_arns["api"]

  environment = merge(local.app_environment, { PROCESS_ROLE = var.split_roles ? "api" : "all" })
  secrets     = local.app_secrets
  secret_arns = local.app_secret_arns

  attach_task_policy = true
  task_policy_json   = var.split_roles ? data.aws_iam_policy_document.api.json : data.aws_iam_policy_document.worker.json

  application_signals = {
    enabled     = var.application_signals_enabled
    environment = local.environment
  }
  read_only_root_filesystem = var.read_only_root_filesystem

  kms_key_arn        = module.kms.arn
  subnet_ids         = module.network.public_subnet_ids
  security_group_ids = [aws_security_group.app.id]
  assign_public_ip   = true
}

module "worker" {
  source = "../../modules/ecs-service"
  count  = var.split_roles ? 1 : 0

  name         = "worker"
  cluster_arn  = module.ecs.cluster_arn
  cluster_name = module.ecs.cluster_name
  image        = "${module.ecs.repository_urls["api"]}:${var.image_tag}"
  cpu          = 512
  memory       = 1024

  desired_count = var.worker_desired_count
  min_count     = 1
  max_count     = 2
  queue_scaling = merge(local.queue_metric, { backlog_per_task = 100 })

  environment = merge(local.app_environment, { PROCESS_ROLE = "worker" })
  secrets     = local.app_secrets
  secret_arns = local.app_secret_arns

  attach_task_policy = true
  task_policy_json   = data.aws_iam_policy_document.worker.json

  application_signals = {
    enabled     = var.application_signals_enabled
    environment = local.environment
  }
  read_only_root_filesystem = var.read_only_root_filesystem

  kms_key_arn        = module.kms.arn
  subnet_ids         = module.network.public_subnet_ids
  security_group_ids = [aws_security_group.app.id]
  assign_public_ip   = true
}

# One-shot migration task: `aws ecs run-task` before each deploy (advisory-locked, so two runs never race).
module "migrate" {
  source = "../../modules/ecs-service"

  name           = "migrate"
  create_service = false
  cluster_arn    = module.ecs.cluster_arn
  cluster_name   = module.ecs.cluster_name
  image          = "${module.ecs.repository_urls["api"]}:${var.image_tag}"
  cpu            = 512
  memory         = 1024
  command        = ["node", "dist/src/database/migrate-cli.js", "run"]

  environment = local.app_environment
  secrets     = local.app_secrets
  secret_arns = local.app_secret_arns

  kms_key_arn        = module.kms.arn
  subnet_ids         = module.network.public_subnet_ids
  security_group_ids = [aws_security_group.app.id]
  assign_public_ip   = true
}
