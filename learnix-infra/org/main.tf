terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # Partial configuration: run `terraform init -backend-config=backend.hcl`
  # (contents come from the bootstrap output `backend_hcl`; the file is not committed).
  backend "s3" {
    key = "org/terraform.tfstate"
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = local.tags
  }
}

# Member-account access for the log-archive account. Configured only after the
# account exists (stage 2, see README): var.log_archive_account_id is empty in stage 1.
provider "aws" {
  alias  = "log_archive"
  region = var.region

  default_tags {
    tags = local.tags
  }

  dynamic "assume_role" {
    for_each = var.log_archive_account_id == "" ? [] : [1]

    content {
      role_arn     = "arn:aws:iam::${var.log_archive_account_id}:role/OrganizationAccountAccessRole"
      session_name = "terraform-org"
    }
  }
}

data "aws_caller_identity" "current" {}

locals {
  management_account_id = data.aws_caller_identity.current.account_id
  stage2                = var.log_archive_account_id != ""

  tags = {
    Project     = var.project
    Environment = "management"
    Component   = "org"
    Owner       = var.owner
    CostCenter  = var.cost_center
    DataClass   = "internal"
    ManagedBy   = "terraform"
  }
}
