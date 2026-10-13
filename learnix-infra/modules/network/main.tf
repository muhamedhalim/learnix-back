terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

data "aws_region" "current" {}

locals {
  region   = data.aws_region.current.region
  az_count = length(var.azs)
}

resource "aws_vpc" "this" {
  cidr_block           = var.cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = var.name }
}

# The default security group allows nothing: every workload gets its own explicit groups.
resource "aws_default_security_group" "this" {
  vpc_id = aws_vpc.this.id
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = var.name }
}

# 3 tiers x N AZs. /20 blocks from the VPC range: public 0..N-1, app N..2N-1, data 2N..3N-1.
resource "aws_subnet" "public" {
  count = local.az_count

  vpc_id                  = aws_vpc.this.id
  availability_zone       = var.azs[count.index]
  cidr_block              = cidrsubnet(var.cidr, 4, count.index)
  map_public_ip_on_launch = false
  tags                    = { Name = "${var.name}-public-${var.azs[count.index]}", Tier = "public" }
}

resource "aws_subnet" "app" {
  count = local.az_count

  vpc_id            = aws_vpc.this.id
  availability_zone = var.azs[count.index]
  cidr_block        = cidrsubnet(var.cidr, 4, local.az_count + count.index)
  tags              = { Name = "${var.name}-app-${var.azs[count.index]}", Tier = "app" }
}

resource "aws_subnet" "data" {
  count = local.az_count

  vpc_id            = aws_vpc.this.id
  availability_zone = var.azs[count.index]
  cidr_block        = cidrsubnet(var.cidr, 4, 2 * local.az_count + count.index)
  tags              = { Name = "${var.name}-data-${var.azs[count.index]}", Tier = "data" }
}

# --- Routing -----------------------------------------------------------------------------------
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name}-public" }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count          = local.az_count
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# App subnets: egress through the NAT gateway when enabled (production). Staging runs tasks in the
# public tier with public IPs instead of paying for a NAT, so this table then has no default route.
resource "aws_eip" "nat" {
  count  = var.nat_gateway_count
  domain = "vpc"
  tags   = { Name = "${var.name}-nat-${count.index}" }
}

resource "aws_nat_gateway" "this" {
  count = var.nat_gateway_count

  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
  tags          = { Name = "${var.name}-${count.index}" }

  depends_on = [aws_internet_gateway.this]
}

resource "aws_route_table" "app" {
  count  = local.az_count
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name}-app-${var.azs[count.index]}" }
}

resource "aws_route" "app_nat" {
  count = var.nat_gateway_count == 0 ? 0 : local.az_count

  route_table_id         = aws_route_table.app[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this[count.index % var.nat_gateway_count].id
}

resource "aws_route_table_association" "app" {
  count          = local.az_count
  subnet_id      = aws_subnet.app[count.index].id
  route_table_id = aws_route_table.app[count.index].id
}

# Data subnets have no internet route at all.
resource "aws_route_table" "data" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name}-data" }
}

resource "aws_route_table_association" "data" {
  count          = local.az_count
  subnet_id      = aws_subnet.data[count.index].id
  route_table_id = aws_route_table.data.id
}

# S3 over the gateway endpoint keeps bucket traffic off the NAT (and off the internet).
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${local.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids = concat(
    [aws_route_table.public.id, aws_route_table.data.id],
    aws_route_table.app[*].id,
  )
  tags = { Name = "${var.name}-s3" }
}

# --- Flow logs (REJECT only: enough for incident work at a fraction of the volume) --------------
resource "aws_cloudwatch_log_group" "flow" {
  #checkov:skip=CKV_AWS_338:REJECT-only flow logs are kept var.flow_log_retention_days (30 d per the plan)
  name              = "/learnix/${var.name}/vpc-flow"
  retention_in_days = var.flow_log_retention_days
  kms_key_id        = var.logs_kms_key_arn
}

data "aws_iam_policy_document" "flow_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["vpc-flow-logs.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "flow" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
    resources = ["${aws_cloudwatch_log_group.flow.arn}:*"]
  }
}

resource "aws_iam_role" "flow" {
  name               = "${var.name}-vpc-flow"
  assume_role_policy = data.aws_iam_policy_document.flow_assume.json
}

resource "aws_iam_role_policy" "flow" {
  name   = "write-flow-logs"
  role   = aws_iam_role.flow.id
  policy = data.aws_iam_policy_document.flow.json
}

resource "aws_flow_log" "this" {
  vpc_id               = aws_vpc.this.id
  traffic_type         = "REJECT"
  log_destination_type = "cloud-watch-logs"
  log_destination      = aws_cloudwatch_log_group.flow.arn
  iam_role_arn         = aws_iam_role.flow.arn
}
