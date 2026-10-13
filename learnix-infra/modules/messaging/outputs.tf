output "ses_configuration_set" {
  value = aws_sesv2_configuration_set.this.configuration_set_name
}

output "mail_events_queue_url" {
  value = aws_sqs_queue.feed["ses"].url
}

output "mail_events_queue_arn" {
  value = aws_sqs_queue.feed["ses"].arn
}

output "sms_configuration_set" {
  value = aws_pinpointsmsvoicev2_configuration_set.sms.name
}

output "sms_configuration_set_arn" {
  value = aws_pinpointsmsvoicev2_configuration_set.sms.arn
}

output "sms_events_queue_url" {
  value = aws_sqs_queue.feed["sms"].url
}

output "sms_events_queue_arn" {
  value = aws_sqs_queue.feed["sms"].arn
}

output "dead_letter_queue_names" {
  value = [for k, q in aws_sqs_queue.dlq : q.name]
}

output "ses_identity_arn" {
  description = "Null until a domain identity exists."
  value       = local.identity ? aws_sesv2_email_identity.domain[0].arn : null
}
