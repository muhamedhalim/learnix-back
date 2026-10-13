output "source_bucket" {
  value = { id = module.source.id, arn = module.source.arn }
}

output "output_bucket" {
  value = {
    id                   = module.output.id
    arn                  = module.output.arn
    regional_domain_name = module.output.bucket_regional_domain_name
  }
}

output "mediaconvert_role_arn" {
  value = aws_iam_role.mediaconvert.arn
}

output "events_queue_url" {
  value = aws_sqs_queue.events.url
}

output "events_queue_arn" {
  value = aws_sqs_queue.events.arn
}

output "events_dlq_name" {
  value = aws_sqs_queue.dlq.name
}
