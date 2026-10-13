output "state_bucket" {
  value = aws_s3_bucket.state.id
}

output "state_kms_key_arn" {
  value = aws_kms_key.state.arn
}

output "plan_role_arn" {
  description = "Set as the GitHub repository variable AWS_PLAN_ROLE_ARN."
  value       = aws_iam_role.plan.arn
}

output "apply_role_arn" {
  description = "Set as the GitHub environment variable AWS_APPLY_ROLE_ARN (environment infra-<environment>)."
  value       = aws_iam_role.apply.arn
}

output "backend_hcl" {
  description = "Contents for <stack>/backend.hcl (not committed)."
  value       = <<-EOT
    bucket       = "${aws_s3_bucket.state.id}"
    region       = "${var.region}"
    encrypt      = true
    kms_key_id   = "${aws_kms_key.state.arn}"
    use_lockfile = true
  EOT
}
