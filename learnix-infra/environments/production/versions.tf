terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.7.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.7"
    }
  }

  # Partial configuration: bucket, region, kms_key_id and use_lockfile come from backend.hcl
  # (values are the outputs of bootstrap/ in the learnix-production account).
  backend "s3" {
    key = "production/platform.tfstate"
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = local.tags
  }
}

# CloudFront certificates and CLOUDFRONT-scope WAF must live in us-east-1.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = local.tags
  }
}

# Recovery region: replicated database backups.
provider "aws" {
  alias  = "dr"
  region = var.dr_region

  default_tags {
    tags = local.tags
  }
}
