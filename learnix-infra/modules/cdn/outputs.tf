output "distribution_id" {
  value = aws_cloudfront_distribution.this.id
}

output "distribution_arn" {
  value = aws_cloudfront_distribution.this.arn
}

output "domain_name" {
  value = aws_cloudfront_distribution.this.domain_name
}

output "hosted_zone_id" {
  description = "Route 53 alias target zone for CloudFront."
  value       = aws_cloudfront_distribution.this.hosted_zone_id
}

output "vpc_origin_security_group_id" {
  description = "Service-managed group the internal ALB must admit."
  value       = data.aws_security_group.vpc_origin_service.id
}

output "video_bucket_policy_json" {
  description = "Bucket policy statement letting this distribution (only) read the video output bucket."
  value       = local.video_enabled ? data.aws_iam_policy_document.video_bucket[0].json : null
}

output "video_key_pair_id" {
  description = "Public key id to set as CLOUDFRONT_KEY_PAIR_ID."
  value       = local.video_enabled ? aws_cloudfront_public_key.video[0].id : null
}
