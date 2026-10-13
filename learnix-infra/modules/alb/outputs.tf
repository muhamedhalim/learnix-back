output "arn" {
  value = aws_lb.this.arn
}

output "arn_suffix" {
  value = aws_lb.this.arn_suffix
}

output "dns_name" {
  value = aws_lb.this.dns_name
}

output "security_group_id" {
  value = aws_security_group.alb.id
}

output "listener_port" {
  value = local.port
}

output "https" {
  value = local.https
}

output "target_group_arns" {
  value = { for k, tg in aws_lb_target_group.this : k => tg.arn }
}

output "target_group_arn_suffixes" {
  value = { for k, tg in aws_lb_target_group.this : k => tg.arn_suffix }
}
