# All four are public by design: they are inlined into the browser bundle as NEXT_PUBLIC_RUM_*.
output "app_monitor_id" {
  value = aws_rum_app_monitor.this.app_monitor_id
}

output "identity_pool_id" {
  value = aws_cognito_identity_pool.rum.id
}

output "guest_role_arn" {
  value = aws_iam_role.guest.arn
}

output "region" {
  value = data.aws_region.current.region
}
