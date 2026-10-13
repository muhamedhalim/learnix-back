package main

import rego.v1

# Evaluated against `terraform show -json <plan>` with conftest.
# Override a deliberate destroy by passing `--data allow_destroy.json` ({"allow_destroy": true}).

protected_types := {
	"aws_backup_vault",
	"aws_cloudtrail",
	"aws_db_instance",
	"aws_elasticache_replication_group",
	"aws_kms_key",
	"aws_organizations_account",
	"aws_organizations_organization",
	"aws_s3_bucket",
}

deny contains msg if {
	not data.allow_destroy
	some rc in input.resource_changes
	rc.type in protected_types
	"delete" in rc.change.actions
	msg := sprintf("%s would be destroyed or replaced; protected resource types need an explicit override", [rc.address])
}

forbidden_types := {"aws_iam_access_key", "aws_iam_user", "aws_iam_user_login_profile"}

deny contains msg if {
	some rc in input.resource_changes
	rc.type in forbidden_types
	"create" in rc.change.actions
	msg := sprintf("%s: IAM users and access keys are not allowed (use Identity Center and OIDC)", [rc.address])
}

deny contains msg if {
	some rc in input.resource_changes
	rc.type == "aws_s3_bucket_public_access_block"
	some key in ["block_public_acls", "block_public_policy", "ignore_public_acls", "restrict_public_buckets"]
	rc.change.after[key] == false
	msg := sprintf("%s: %s must be true", [rc.address, key])
}
