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

# SES records an operator must publish when DNS is not managed here (dns_provider = cloudflare). No DMARC
# record: a policy (and its report address) already in the zone must not be replaced from here.
output "dns_records_required" {
  description = "DKIM and MAIL FROM records for the SES domain identity. Empty until a domain identity exists."
  value = local.identity ? concat(
    [for t in aws_sesv2_email_identity.domain[0].dkim_signing_attributes[0].tokens : { name = "${t}._domainkey.${local.domain}", type = "CNAME", value = "${t}.dkim.amazonses.com", note = "SES DKIM" }],
    [
      { name = "bounce.${local.domain}", type = "MX", value = "10 feedback-smtp.${local.region}.amazonses.com", note = "SES MAIL FROM" },
      { name = "bounce.${local.domain}", type = "TXT", value = "v=spf1 include:amazonses.com ~all", note = "SES MAIL FROM SPF" },
    ],
  ) : []
}
