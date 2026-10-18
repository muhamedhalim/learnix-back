# bootstrap-state (production only)

Production shares AWS account 486940690416 with staging. `bootstrap/` belongs to staging there (its state is in
the staging bucket and it owns the `learnix-gha-plan` / `learnix-gha-apply` roles), so production must never run it.
This stack creates only the production state bucket `learnix-production-tfstate-486940690416` and its KMS key.

```bash
export AWS_PROFILE=learnix-staging AWS_REGION=eu-central-1
cd learnix-infra/bootstrap-state
export TF_DATA_DIR=.tfdata-production           # never reuse another stack's .terraform
terraform init -input=false                      # local state on the first run
terraform plan -out=tfplan -var environment=production -var expected_account_id=486940690416 \
  -var 'deny_read_role_names=["learnix-gha-plan","learnix-gha-apply"]'
terraform apply tfplan
terraform output -raw backend_hcl > ../environments/production/backend.hcl

# Move this stack's own state into the bucket it created, then delete the local copy.
cat > backend_override.tf <<'EOF'
terraform {
  backend "s3" {
    key = "production/bootstrap-state.tfstate"
  }
}
EOF
terraform init -migrate-state -backend-config=../environments/production/backend.hcl
```

## Budgets (account-level, created with the AWS CLI before any billable production apply)

`budgets/` holds the two budgets: `learnix-account-total` ($350, whole account) and `learnix-production`
($250, tag `Environment=production`). Both **exclude credits** (`IncludeCredit=false`): the account's usage is
currently offset by credits, so a credit-inclusive budget would never alert. Budgets only send email; they do
not stop or cap spending. The tag filter only sees usage after the `Environment` tag is activated as a
cost-allocation tag, and billing data can lag up to 24 h.
