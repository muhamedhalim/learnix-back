module "observability" {
  source = "../../modules/observability"

  name         = local.name
  kms_key_arn  = module.kms.arn
  alert_emails = var.alert_emails

  alb_arn_suffix            = module.alb.arn_suffix
  target_group_arn_suffixes = module.alb.target_group_arn_suffixes

  ecs_cluster_name  = module.ecs.cluster_name
  ecs_service_names = concat(["api"], var.split_roles ? ["worker"] : [])

  rds_instance_identifier = module.database.instance_identifier
  # db.t4g.micro (1 GiB) tolerates only a handful of connections; the alarm fires well before exhaustion.
  rds_connections_threshold = 60

  valkey_replication_group_id = module.cache.replication_group_id

  dead_letter_queue_names = concat([module.media.events_dlq_name], module.messaging.dead_letter_queue_names)

  app_log_group_names = concat(
    [module.api.log_group_name],
    var.split_roles ? [module.worker[0].log_group_name] : [],
  )
  # Queue consumers run in the worker when roles are split, otherwise in the single api service.
  worker_log_group_name = var.split_roles ? module.worker[0].log_group_name : module.api.log_group_name
  queue_backlog_metric  = merge(local.queue_metric, { threshold = 500 })
}

# Browser monitoring of the Vercel-hosted staging frontend (no Synthetics canary here: the WAF allowlist blocks it).
module "rum" {
  source = "../../modules/rum"

  name                = local.name
  domain              = replace(local.frontend_url, "https://", "")
  session_sample_rate = 1
  alarm_topic_arn     = module.observability.alerts_topic_arn
}
