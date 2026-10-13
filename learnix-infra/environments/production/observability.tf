module "observability" {
  source = "../../modules/observability"

  name              = local.name
  kms_key_arn       = module.kms.arn
  alert_emails      = var.alert_emails
  alb_5xx_threshold = 25

  alb_arn_suffix            = module.alb.arn_suffix
  target_group_arn_suffixes = module.alb.target_group_arn_suffixes

  ecs_cluster_name  = module.ecs.cluster_name
  ecs_service_names = ["api", "worker"]

  rds_instance_identifier          = module.database.instance_identifier
  rds_connections_threshold        = 150
  rds_free_storage_bytes_threshold = 10737418240

  valkey_replication_group_id = module.cache.replication_group_id

  dead_letter_queue_names = concat([module.media.events_dlq_name], module.messaging.dead_letter_queue_names)

  app_log_group_names   = [module.api.log_group_name, module.worker.log_group_name]
  worker_log_group_name = module.worker.log_group_name
  queue_backlog_metric  = merge(local.queue_metric, { threshold = 1000 })
}

# --- Browser monitoring (replaces Vercel Analytics and Sentry's browser capture) ------------------
module "rum" {
  source = "../../modules/rum"

  name                = local.name
  domain              = var.domain_name # the browser app runs on Vercel at this domain
  session_sample_rate = var.rum_session_sample_rate
  alarm_topic_arn     = module.observability.alerts_topic_arn
}

# --- Synthetic checks from outside the VPC ---------------------------------------------------------
module "synthetics" {
  source = "../../modules/synthetics"

  name            = local.name
  api_url         = local.api_url
  frontend_url    = local.frontend_url
  start           = var.canary_enabled
  kms_key_arn     = module.kms.arn
  alarm_topic_arn = module.observability.alerts_topic_arn
}

# --- AWS Backup: daily + monthly recovery points of the database and the files bucket -------------
# Complements RDS automated backups/PITR (14 days) with longer retention, a deny-delete vault policy and
# a copy of every daily point in the recovery region.
module "backup_dr_vault" {
  source    = "../../modules/backup"
  providers = { aws = aws.dr }

  name        = "${local.name}-dr"
  kms_key_arn = module.kms_dr.arn
  create_plan = false
}

module "backup" {
  source = "../../modules/backup"

  name                       = local.name
  kms_key_arn                = module.kms.arn
  resource_arns              = [module.database.arn, module.files_bucket.arn]
  monthly_retention_days     = var.backup_monthly_retention_days
  copy_destination_vault_arn = module.backup_dr_vault.vault_arn
}
