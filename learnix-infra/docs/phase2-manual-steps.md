# Phase 2: AWS foundation, runbook

Steps marked **(you)** need your AWS console, e-mail or GitHub settings; Terraform cannot do them. Nothing here has been applied yet.

## A. Console steps (you), once
1. Create the AWS account that becomes the **management account**. Use a company-controlled mailbox. Set the payment method and the AWS Support tier you approved.
2. Root hardening: enable MFA on the root user (a hardware key or passkey; register two), delete any root access keys, and set the alternate contacts (billing, security, operations).
3. Billing: enable "IAM user and role access to billing", Cost Explorer, and activate cost allocation tags `Project`, `Environment`, `Component`, `CostCenter` once they appear.
4. Create the Organization if it does not exist (AWS Organizations, all features).
5. Enable **IAM Identity Center** (organization instance) in `eu-central-1`. Under Settings, require MFA for sign-in (every sign-in). Create your first user and add them to the groups after step C creates them.
6. Pick the real values for `account_emails` (3 distinct mailboxes, plus-addressing works) and `alert_emails`.

## B. Bootstrap the management account (state bucket + OIDC), run locally by a human via SSO
```
cd bootstrap
terraform init
terraform apply -var environment=management -var github_repository=OWNER/learnix-infra
```
Local state is used for this first run only. Then migrate it: add `terraform { backend "s3" { key = "bootstrap/terraform.tfstate" } }`, run `terraform init -backend-config=<backend_hcl output> -migrate-state`, and delete the local state file.

Store the outputs in GitHub:
- Repository variables: `AWS_REGION`, `AWS_PLAN_ROLE_ARN`, `TF_STATE_BUCKET`, `TF_STATE_KMS_KEY_ARN`, `ORG_TFVARS_JSON` (the non-secret org variables as JSON).
- Environment `infra-management` (with required reviewers): variable `AWS_APPLY_ROLE_ARN`.

## C. Organization stack, stage 1 (accounts, OUs, SCPs, Identity Center, budgets)
1. `terraform import aws_organizations_organization.this <org-id>` if the org was created in the console.
2. `terraform init -backend-config=backend.hcl`, then `terraform plan`. **Read the plan.** It creates 3 accounts, 2 OUs, 2 SCPs plus attachments, 3 groups, 3 permission sets, assignments, 5 budgets and the anomaly monitor.
3. Apply through the `tf-apply-org` workflow (reviewer approval) or locally.
4. Note the `account_ids` output.

## D. Organization stack, stage 2 (trail, GuardDuty)
Set `log_archive_account_id` in `ORG_TFVARS_JSON` to the log-archive account ID, plan, apply. This adds the CloudTrail bucket, the organization trail, GuardDuty with log-archive as delegated admin, and IAM Access Analyzer.

## E. Per-account bootstrap (staging, production, log-archive)
Sign in to each account through Identity Center and run `bootstrap` with `-var environment=<staging|production|log-archive>`. The first run has no OIDC conflict because each account has its own provider. Then add the `infra-staging` and `infra-production` GitHub environments (production requires reviewers).

## F. Long-lead requests (you), start as soon as accounts exist
- **SES production access** in the production account, `eu-central-1`.
- **Egypt SMS sender ID** registration in End User Messaging SMS (production account).
- CloudFront flat-rate plan subscription later (Phase 6).

## Acceptance checks (Phase 2)
| Check | How |
|---|---|
| No IAM access keys exist | `aws iam list-users` is empty in every account; the credential report shows no keys. CI plan blocks `aws_iam_access_key` (policy). |
| CI plan works via OIDC | Open a PR touching `org/`; the `plan-org` job assumes `learnix-gha-plan` with no stored AWS secrets. |
| Budget alert arrives | Temporarily set one budget to 1 USD (`budgets_usd`) with a small spend, or use the Budgets console "send test"; confirm the e-mail. Revert. |
| SCP blocks a disallowed region | From the staging account run `aws ec2 describe-vpcs --region ap-southeast-1`; expect an explicit-deny error. |
| Org trail logging | `aws cloudtrail get-trail-status --name learnix-org-trail` shows `IsLogging: true`; objects appear in the log bucket within ~15 minutes. |
| GuardDuty | `aws guardduty list-members` from the log-archive account lists the other accounts as enabled. |
| Apply role cannot create users | The boundary denies `iam:CreateUser`/`CreateAccessKey`; verify with the IAM policy simulator. |

## Known caveats
- Validated locally with Terraform 1.12.2 and AWS provider 6.x: `fmt`, `validate`, tflint (0 issues) and checkov (0 failed; 25 deliberate skips, each annotated with a reason in code). **Not tested:** `terraform plan`/`apply` (needs AWS), and the conftest rules in `policies/` (conftest not installed).
- The `service_budget_filters` names for End User Messaging and MediaConvert must be confirmed in Cost Explorer.
- Organization trail uses SSE-S3 (not a CMK) to avoid a cross-account key policy; revisit in Stage 2 of the growth plan.
- GuardDuty extras (S3 data events, EKS, malware protection) are off; they are priced per use.
- `tf-apply-org` uploads the saved plan as a short-lived artifact (3 days); it can contain resource attributes. Keep the repository private.
- The root-user deny SCP does not apply to the management account; protect it with MFA and keep it free of workloads.
