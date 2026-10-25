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
  }
}

locals {
  # Secrets that cannot be generated here (they come from a provider, or need an asymmetric key pair
  # created out-of-band). Terraform creates the empty container only; the value is entered by an operator.
  external = {
    easykash           = "EasyKash payment gateway: {EASYKASH_API_KEY, EASYKASH_HMAC_SECRET}; production only, EasyKash has no test mode"
    paymob             = "RETIRED (Paymob removed from the application). Kept only until an operator confirms it is empty or unused, then delete in a separate approved change."
    meta-whatsapp      = "Meta WhatsApp Cloud API access token, phone number id, app secret, verify token"
    vapid              = "Web Push VAPID keys: {VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY}; generate with npx web-push generate-vapid-keys"
    cloudfront-signing = "CloudFront playback signing key: {CLOUDFRONT_PRIVATE_KEY_B64}; PEM private half of the key whose public half is in the CloudFront key group"
    meetings           = "Meeting provider OAuth: {GOOGLE_MEET_CLIENT_ID, GOOGLE_MEET_CLIENT_SECRET, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET, ZOOM_WEBHOOK_SECRET_TOKEN, MS_TEAMS_CLIENT_ID, MS_TEAMS_CLIENT_SECRET}; fill before mapping via extra_secrets (see docs/MEETING-PROVIDERS-SETUP.md)"
  }
}

resource "aws_secretsmanager_secret" "external" {
  #checkov:skip=CKV2_AWS_57:Provider-issued keys; rotated at the provider and re-entered by an operator
  for_each = local.external

  name                    = "${var.prefix}/${each.key}"
  description             = each.value
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = var.recovery_window_in_days
}

# --- Generated application secrets ---------------------------------------------------------------
# Created as ephemeral values and written through write-only arguments: they are never stored in
# Terraform state or printed in a plan. Read them from Secrets Manager (and escrow the two encryption
# keys: losing them makes the encrypted columns unreadable).
ephemeral "random_password" "jwt" {
  length  = 64
  special = false
}

ephemeral "random_password" "jwt_refresh" {
  length  = 64
  special = false
}

ephemeral "random_password" "cookie" {
  length  = 64
  special = false
}

ephemeral "random_password" "meeting_key" {
  length  = 32
  special = false
}

ephemeral "random_password" "payout_key" {
  length  = 32
  special = false
}

ephemeral "random_password" "admin" {
  length           = 24
  min_upper        = 2
  min_lower        = 2
  min_numeric      = 2
  min_special      = 2
  override_special = "!@#%^*-_"
}

ephemeral "random_password" "metrics" {
  length  = 48
  special = false
}

ephemeral "random_password" "db_app" {
  length  = 40
  special = false
}

resource "aws_secretsmanager_secret" "core" {
  #checkov:skip=CKV2_AWS_57:JWT and encryption keys are rotated as a planned event (var.core_version), never automatically: the two encryption keys protect stored data
  name                    = "${var.prefix}/core"
  description             = "Generated application secrets (JWT, cookie, encryption keys, bootstrap admin password, metrics token)"
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = var.recovery_window_in_days
}

resource "aws_secretsmanager_secret_version" "core" {
  secret_id = aws_secretsmanager_secret.core.id
  secret_string_wo = jsonencode({
    JWT_SECRET         = ephemeral.random_password.jwt.result
    JWT_REFRESH_SECRET = ephemeral.random_password.jwt_refresh.result
    COOKIE_SECRET      = ephemeral.random_password.cookie.result
    # AES-256 keys: 32 random characters, base64-encoded, decode to exactly 32 bytes.
    MEETING_TOKEN_ENCRYPTION_KEY  = base64encode(ephemeral.random_password.meeting_key.result)
    PAYOUT_ACCOUNT_ENCRYPTION_KEY = base64encode(ephemeral.random_password.payout_key.result)
    ADMIN_INIT_PASSWORD           = ephemeral.random_password.admin.result
    METRICS_BEARER_TOKEN          = ephemeral.random_password.metrics.result
  })
  secret_string_wo_version = var.core_version
}

# Credentials of the least-privilege database role (DML only). The migrate task, which holds the RDS
# master credentials, creates the role and sets this password on every run; api and worker connect with it.
# No automatic rotation: to rotate, bump db_app_version, apply, then deploy (migrate re-syncs the role
# before the services restart with the new value).
resource "aws_secretsmanager_secret" "db_app" {
  #checkov:skip=CKV2_AWS_57:Rotated as a planned event (var.db_app_version); the migrate task re-syncs the database role on the next deploy
  name                    = "${var.prefix}/db-app"
  description             = "Application database role {username, password}; created by the migrate task, used by api and worker"
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = var.recovery_window_in_days
}

resource "aws_secretsmanager_secret_version" "db_app" {
  secret_id = aws_secretsmanager_secret.db_app.id
  secret_string_wo = jsonencode({
    username = var.db_app_username
    password = ephemeral.random_password.db_app.result
  })
  secret_string_wo_version = var.db_app_version
}
