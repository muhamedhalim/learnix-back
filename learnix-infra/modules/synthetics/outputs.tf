output "canary_name" {
  value = aws_synthetics_canary.heartbeat.name
}

output "runtime_version" {
  value = data.aws_synthetics_runtime_version.node.version_name
}

output "started" {
  value = var.start
}
