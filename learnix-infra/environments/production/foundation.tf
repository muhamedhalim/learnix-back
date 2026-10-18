data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  environment = "production"
  name        = "${var.project}-${local.environment}"
  account_id  = data.aws_caller_identity.current.account_id
  azs         = ["${var.region}a", "${var.region}b"]

  # The environment-isolation guard rejects a production database whose name identifies itself as staging.
  database_name = var.project

  tags = {
    Project     = var.project
    Environment = local.environment
    Component   = "platform"
    Owner       = var.owner
    CostCenter  = var.cost_center
    DataClass   = "confidential"
    ManagedBy   = "terraform"
  }

  secret_prefix = "${var.project}/${local.environment}"
}

# --- Keys ----------------------------------------------------------------------------------------
module "kms" {
  source = "../../modules/kms-key"

  name                  = "${local.name}-data"
  description           = "Learnix production: RDS, S3 files, secrets, logs, ECR, queues"
  allow_cloudwatch_logs = true
  # Publishers that write to KMS-encrypted SNS topics (alarms, SES and SMS feedback).
  service_principals = [
    "cloudwatch.amazonaws.com",
    "ses.amazonaws.com",
    "sms-voice.amazonaws.com",
    "events.amazonaws.com",
  ]
}

module "kms_waf_logs" {
  source    = "../../modules/kms-key"
  providers = { aws = aws.us_east_1 }

  name                  = "${local.name}-waf-logs"
  description           = "Learnix production: WAF log group (us-east-1)"
  allow_cloudwatch_logs = true
}

# Key in the recovery region for the cross-region copy of the automated database backups.
module "kms_dr" {
  source    = "../../modules/kms-key"
  providers = { aws = aws.dr }

  name        = "${local.name}-dr-backups"
  description = "Learnix production: encrypts replicated RDS automated backups in the recovery region"
}

# --- Network -------------------------------------------------------------------------------------
# Tasks run in the private app tier and reach providers (EasyKash, Meta, AWS APIs) through NAT, which also
# gives a static egress address to allowlist. The data tier has no internet route at all.
module "network" {
  source = "../../modules/network"

  name              = local.name
  cidr              = "10.20.0.0/16"
  azs               = local.azs
  nat_gateway_count = var.nat_gateway_count
  logs_kms_key_arn  = module.kms.arn
}

# --- Logs bucket (ALB access logs: SSE-S3 is the only encryption the ELB log writer supports) -----
data "aws_elb_service_account" "this" {}

data "aws_iam_policy_document" "alb_logs" {
  statement {
    sid       = "AllowElbLogDelivery"
    actions   = ["s3:PutObject"]
    resources = ["arn:${data.aws_partition.current.partition}:s3:::${local.name}-logs-${local.account_id}/alb/AWSLogs/${local.account_id}/*"]

    principals {
      type        = "AWS"
      identifiers = [data.aws_elb_service_account.this.arn]
    }
  }

  # S3 server access logs from the files and video buckets.
  statement {
    sid       = "AllowS3ServerAccessLogDelivery"
    actions   = ["s3:PutObject"]
    resources = ["arn:${data.aws_partition.current.partition}:s3:::${local.name}-logs-${local.account_id}/s3/*"]

    principals {
      type        = "Service"
      identifiers = ["logging.s3.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

module "logs_bucket" {
  source = "../../modules/s3-bucket"

  name                   = "${local.name}-logs-${local.account_id}"
  versioning             = false
  expire_after_days      = 365
  extra_policy_documents = [data.aws_iam_policy_document.alb_logs.json]
}

# --- Application files (private; objects are served through the API or signed URLs only) ----------
module "files_bucket" {
  source = "../../modules/s3-bucket"

  name                   = "${local.name}-files-${local.account_id}"
  kms_key_arn            = module.kms.arn
  versioning             = true
  cors_allowed_origins   = local.frontend_origins
  access_logging_enabled = true
  access_log_bucket      = module.logs_bucket.id
}

# --- Secrets, data stores ------------------------------------------------------------------------
module "secrets" {
  source = "../../modules/secrets"

  prefix                  = local.secret_prefix
  kms_key_arn             = module.kms.arn
  recovery_window_in_days = 30
}

module "database" {
  source = "../../modules/database"

  name                      = "${local.name}-pg"
  vpc_id                    = module.network.vpc_id
  subnet_ids                = module.network.data_subnet_ids
  client_security_group_ids = [aws_security_group.app.id]
  kms_key_arn               = module.kms.arn
  instance_class            = var.db_instance_class
  database_name             = local.database_name
  multi_az                  = var.db_multi_az
  backup_retention_days     = 14
  deletion_protection       = true
  skip_final_snapshot       = false
  apply_immediately         = false
}

# Region-loss protection: automated backups (and transaction logs) are copied to the recovery region.
resource "aws_db_instance_automated_backups_replication" "dr" {
  provider = aws.dr

  source_db_instance_arn = module.database.arn
  kms_key_id             = module.kms_dr.arn
  retention_period       = 14
}

module "cache" {
  source = "../../modules/cache"

  name                      = "${local.name}-valkey"
  vpc_id                    = module.network.vpc_id
  subnet_ids                = module.network.data_subnet_ids
  client_security_group_ids = [aws_security_group.app.id]
  kms_key_arn               = module.kms.arn
  secret_prefix             = local.secret_prefix
  node_type                 = var.valkey_node_type
  node_count                = var.valkey_node_count
  snapshot_retention_days   = 7
  secret_recovery_days      = 30
  apply_immediately         = false
}

# --- Video, mail, SMS ----------------------------------------------------------------------------
module "media" {
  source = "../../modules/media"

  name                           = local.name
  upload_origins                 = local.frontend_origins
  output_bucket_policy_documents = compact([module.cdn.video_bucket_policy_json])
  access_logging_enabled         = true
  access_log_bucket              = module.logs_bucket.id
}

module "messaging" {
  source = "../../modules/messaging"

  name               = local.name
  kms_key_arn        = module.kms.arn
  domain             = var.domain_name
  zone_id            = one(aws_route53_zone.this[*].zone_id)
  manage_dns_records = local.route53
  dmarc_policy       = var.dmarc_policy
}
