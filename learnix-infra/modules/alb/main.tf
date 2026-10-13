terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

locals {
  https = var.certificate_arn != null
  port  = local.https ? 443 : 80
}

# Internal load balancer: reachable only through the CloudFront VPC origin (the caller adds that
# single ingress rule), never from the internet.
resource "aws_security_group" "alb" {
  name_prefix = "${var.name}-alb-"
  description = "Internal ALB: ingress only from the CloudFront VPC origin"
  vpc_id      = var.vpc_id

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_egress_rule" "to_targets" {
  for_each = toset([for t in values(var.targets) : tostring(t.port)])

  security_group_id = aws_security_group.alb.id
  description       = "Forward to ECS tasks on ${each.value}"
  ip_protocol       = "tcp"
  from_port         = tonumber(each.value)
  to_port           = tonumber(each.value)
  cidr_ipv4         = var.vpc_cidr
}

resource "aws_lb" "this" {
  #checkov:skip=CKV_AWS_150:Deletion protection is set per environment through var.deletion_protection
  #checkov:skip=CKV2_AWS_28:The ALB is internal; WAF sits on the CloudFront distribution in front of it
  name                       = var.name
  internal                   = true
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = var.subnet_ids
  idle_timeout               = 120
  drop_invalid_header_fields = true
  enable_deletion_protection = var.deletion_protection

  dynamic "access_logs" {
    for_each = var.access_logging_enabled ? [1] : []
    content {
      bucket  = var.access_log_bucket
      prefix  = var.access_log_prefix
      enabled = true
    }
  }
}

resource "aws_lb_target_group" "this" {
  for_each = var.targets

  name_prefix = substr(each.key, 0, 6)
  port        = each.value.port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  # Finish in-flight requests, but do not hold a deploy for minutes.
  deregistration_delay = 30

  health_check {
    path                = each.value.health_path
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_lb_listener" "this" {
  #checkov:skip=CKV_AWS_2:Plain HTTP only inside the VPC between the CloudFront VPC origin and this internal ALB; an origin certificate is added in production (var.certificate_arn)
  #checkov:skip=CKV_AWS_103:TLS policy applies only when var.certificate_arn is set
  load_balancer_arn = aws_lb.this.arn
  port              = local.port
  protocol          = local.https ? "HTTPS" : "HTTP"
  ssl_policy        = local.https ? "ELBSecurityPolicy-TLS13-1-2-Res-2021-06" : null
  certificate_arn   = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this[var.default_target].arn
  }
}

resource "aws_lb_listener_rule" "path" {
  for_each = { for k, t in var.targets : k => t if length(t.paths) > 0 }

  listener_arn = aws_lb_listener.this.arn
  priority     = each.value.priority

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this[each.key].arn
  }

  condition {
    path_pattern {
      values = each.value.paths
    }
  }
}
