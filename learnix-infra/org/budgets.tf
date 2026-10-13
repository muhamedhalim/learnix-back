# Budgets and anomaly detection (plan section 6.6). Budgets live in the management
# account and filter by linked account / service. Values are variables, not guesses
# hard-coded here; revisit them at the 30/60/90-day re-forecast.

locals {
  notifications = [
    { type = "ACTUAL", threshold = 50 },
    { type = "ACTUAL", threshold = 80 },
    { type = "ACTUAL", threshold = 100 },
    { type = "FORECASTED", threshold = 100 },
  ]

  budgets = {
    "prod-monthly" = {
      amount = var.budgets_usd.production
      filter = { name = "LinkedAccount", values = [aws_organizations_account.production.id] }
    }
    "staging-monthly" = {
      amount = var.budgets_usd.staging
      filter = { name = "LinkedAccount", values = [aws_organizations_account.staging.id] }
    }
    "mediaconvert-monthly" = {
      amount = var.budgets_usd.mediaconvert
      filter = { name = "Service", values = [var.service_budget_filters.mediaconvert] }
    }
    "sms-monthly" = {
      amount = var.budgets_usd.sms
      filter = { name = "Service", values = [var.service_budget_filters.sms] }
    }
    "cloudwatch-monthly" = {
      amount = var.budgets_usd.cloudwatch
      filter = { name = "Service", values = [var.service_budget_filters.cloudwatch] }
    }
  }
}

resource "aws_budgets_budget" "this" {
  for_each = local.budgets

  name         = "${var.project}-${each.key}"
  budget_type  = "COST"
  limit_amount = tostring(each.value.amount)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {
    name   = each.value.filter.name
    values = each.value.filter.values
  }

  dynamic "notification" {
    for_each = local.notifications

    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value.threshold
      threshold_type             = "PERCENTAGE"
      notification_type          = notification.value.type
      subscriber_email_addresses = var.alert_emails
    }
  }
}

resource "aws_ce_anomaly_monitor" "services" {
  name              = "${var.project}-services"
  monitor_type      = "DIMENSIONAL"
  monitor_dimension = "SERVICE"
}

resource "aws_ce_anomaly_subscription" "daily" {
  name             = "${var.project}-anomalies"
  frequency        = "DAILY"
  monitor_arn_list = [aws_ce_anomaly_monitor.services.arn]

  dynamic "subscriber" {
    for_each = var.alert_emails

    content {
      type    = "EMAIL"
      address = subscriber.value
    }
  }

  threshold_expression {
    dimension {
      key           = "ANOMALY_TOTAL_IMPACT_ABSOLUTE"
      match_options = ["GREATER_THAN_OR_EQUAL"]
      values        = [tostring(var.budgets_usd.anomaly_impact)]
    }
  }
}
