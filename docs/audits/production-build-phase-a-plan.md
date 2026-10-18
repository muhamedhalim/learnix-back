# Phase A plan: build the AWS production backend for learnix.school

> **Superseded (2026-10-18) by [production-build-phase-a-plan-v2.md](production-build-phase-a-plan-v2.md)**, which lists this revision's discrepancies in its section 2. Kept unchanged below as evidence.

**Date:** 2026-10-18. **Status: PLAN ONLY.** Nothing in this document has been run. Every step marked **⛔ GATE** waits for your explicit approval in chat. Approving one step does not approve the next one.
**Source audit:** [production-connectivity-audit.md](production-connectivity-audit.md). Root cause C-1: `api.learnix.school` has no working origin, and no AWS production exists.
**Goal of Phase A:** `https://api.learnix.school/api/v1/health/readiness` returns 200 from AWS production (CloudFront → ALB → ECS → RDS/Valkey). The Vercel build already calls this URL, so the site should start working at step A11 with no frontend change. Phase B confirms that.

---

## 0. What was verified offline today

| Check | Result |
|---|---|
| `terraform validate` on `learnix-infra/environments/production` | ✅ valid (Terraform 1.12.2) |
| `terraform test` (mock provider, 7 scenarios incl. the Cloudflare certificate flow and the CORS guards) | ✅ 7 passed, 0 failed |
| Default `dns_provider` | `cloudflare`: no Route 53 zone and **no name-server move**. Terraform only prints the records you add in Cloudflare |
| Payment gateway | EasyKash is optional at boot (`validateEasyKashConfiguration` returns early when no EasyKash key is set), so the API can go live **before** payments are configured |
| Prod CORS | Derived as `https://learnix.school` (+ `cors_extra_origins`); www 307-redirects to the apex, so it needs no entry |

Not verifiable offline: anything that needs an AWS account, quotas, ACM, or the real plan.

---

## 1. Decisions needed before step A1

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | **Account model** | (a) a **standalone** `learnix-prod` AWS account, the same pattern as staging (`4869…0416`, standalone); (b) the full Organization from `learnix-infra/org` (new management account + log-archive + prod; staging invited and **imported**, because `org/organization.tf` would otherwise try to *create* a second staging account) | **(a) now, (b) later.** A standalone account can be invited into an Organization afterwards without being rebuilt. (b) adds about a day of console work plus an import step, and does nothing for the outage |
| D2 | **Region** | `eu-central-1` (staging is here, all IaC defaults) | Keep it |
| D3 | **Mailboxes** | the prod account root email, `alert_emails`, `admin_email`, `mail_from_email` (the example uses `ops@`, `admin@`, `no-reply@learnix.school`; they need to exist via Cloudflare Email Routing) | You supply the real values |
| D4 | **Deploy approval** | GitHub environment "required reviewers" on a **private** repo needs a paid GitHub plan. On the Free plan the `production` env exists, but its reviewer gate does not | Tell me your GitHub plan. If it is Free, I propose a `workflow_dispatch`-only production deploy as the substitute gate |
| D5 | **Launch scope** | (i) API live **without** payments, SES production mail, or SMS, then add them; (ii) wait for all of them | **(i).** It restores the site. Payments, mail and SMS stay off (they have long-lead approvals) |
| D6 | **Budget** | Prod infra at the plan's "Low" estimate is ≈ **$515/month** (Multi-AZ RDS, NAT, 2+ API tasks, Valkey replica, CloudFront, WAF). It starts billing at step A6 | Approve the budget, or ask for a reduced "launch sizing" variant (single NAT, smaller counts) before A5 |

---

## 2. Steps

Legend: **You** = only you can do it (console, billing, dashboards). **Me** = I can run it once you approve, and I report the output.

### A1 — Create the production AWS account ⛔ GATE (You)
- Create the account (D1-a), set the payment method, enable root MFA (two keys), delete any root access keys, set alternate contacts, and enable Cost Explorer.
- Create an admin identity for operating Terraform. Prefer IAM Identity Center or short-lived credentials. If you use an IAM user like staging's `learnix-terraform`, give it keys **only** for the bootstrap, and delete them at A13.
- **Same day, long lead (You):** request SES production access (eu-central-1) and start the Egypt SMS sender-ID registration. Neither blocks the API.
- **Verify (Me):** `aws sts get-caller-identity --profile learnix-production` shows the new account. I will report it masked.
- **Rollback:** close the account (nothing billable exists yet).

### A2 — Bootstrap state + GitHub OIDC ⛔ GATE (Me)
```bash
cd learnix-infra/bootstrap
terraform init                       # local state for this first run only
terraform plan  -var environment=production -var github_repository=muhamedhalim/learnix-back -out bootstrap.tfplan
terraform apply bootstrap.tfplan     # only after you approve the plan text
# then migrate the state into the bucket it just created:
terraform init -backend-config=<backend_hcl output> -migrate-state
```
- Creates: the S3 state bucket `learnix-production-tfstate-<acct>`, a KMS key, the GitHub OIDC provider, `learnix-gha-plan` and `learnix-gha-apply` (with the permission boundary). The apply role trusts only the GitHub env `infra-production` on `main`.
- **Caution:** the bootstrap state of staging lives at `bootstrap/backend.hcl`. I will use a separate local directory or `-reconfigure` so the staging bootstrap state is never touched. I'll show you the exact `backend.hcl` before `-migrate-state`.
- **Verify:** plan shows only creates (~20 resources), `plan: no changes` after migration.
- **Rollback:** `terraform destroy` (empty bucket; the KMS key is scheduled for deletion).

### A3 — GitHub configuration ⛔ GATE (You, or Me via REST with your OK)
- Create the environments `infra-production` (reviewers, branch `main`), `production` (reviewers, branch `main`) and `production-db-approval` (already exists).
- Repository variables (from the A2 outputs): `PRODUCTION_PLAN_ROLE_ARN`, `PRODUCTION_APPLY_ROLE_ARN`, `PRODUCTION_TF_STATE_BUCKET`, `PRODUCTION_TF_STATE_KMS_KEY_ARN`, `PRODUCTION_TFVARS_JSON` (A4). None of these are secrets.
- **Verify:** `GET /repos/muhamedhalim/learnix-back/environments` lists them; the variable names are present.
- **Rollback:** delete the variables/environments.

### A4 — Production tfvars (Me, reviewed by you)
Draft `PRODUCTION_TFVARS_JSON` from `environments/production/terraform.tfvars.example`:
- `dns_provider = "cloudflare"`, `certificate_enabled = false`, `certificate_validated = false`
- `image_tag = "bootstrap"`, `api_desired_count = 0`, `worker_desired_count = 0`
- `admin_email`, `mail_from_email`, `alert_emails` (D3); `app_repositories = { api = "muhamedhalim/learnix-back" }`
- `extra_secrets = {}` (no EasyKash yet, D5), `inject_vapid = false`, `inject_cloudfront_key = false`
- `waf_block = false`, `canary_enabled = false`
- Nothing secret goes in it. I'll show you the JSON before setting it.

### A5 — First real `terraform plan` (Me, via the Terraform workflow or locally)
- Runs `terraform plan` for `environments/production` with the conftest policies. Read-only: it creates nothing.
- **Deliverable to you:** resource counts by type, anything that is replaced or destroyed (must be zero), and the policy result. First real plans often expose quota or service-linked-role issues that mocks cannot. I'll report them rather than work around them.

### A6 — First `terraform apply` (services at 0 tasks) ⛔ GATE (Me, after you approve the A5 plan) — **billing starts**
- Creates the VPC (10.20.0.0/16, NAT), internal ALB, ECS cluster + ECR, RDS PG16 Multi-AZ (deletion protection), Valkey primary+replica, S3 buckets, Secrets Manager entries (core secrets generated), CloudFront + WAF (no alias yet), alarms, backup plan (eu-west-1 copy), and the deploy role `learnix-production-gha-deploy-api`.
- Expect roughly 25–40 minutes (RDS Multi-AZ, CloudFront).
- **Verify:** apply succeeds; `terraform output` gives `cloudfront_domain_name`, `ecr_repositories`, `ecs_cluster`, `task_network`, `deploy_roles`, `deploy_health_alarms`, `migrate_task_definition_family`.
- **Rollback:** RDS/ALB have deletion protection on purpose. Tearing down is an explicit two-step (disable protection → destroy) and needs a separate approval. There is no data yet, so nothing is lost.

### A7 — Secrets and key escrow ⛔ GATE (You read/escrow; Me only wires the flags)
- **Escrow now, outside AWS:** `MEETING_TOKEN_ENCRYPTION_KEY` and `PAYOUT_ACCOUNT_ENCRYPTION_KEY` from `learnix/production/core`. Never bump the secrets module `core_version` afterwards. I will not print these values.
- Optional now (or later): `vapid`, `cloudfront-signing` (video playback), `meta-whatsapp`, `meetings`. Leave `easykash` empty (D5).
- **Verify:** `describe-secret` shows a value version for each filled secret (names only).

### A8 — GitHub `production` env variables (Me with your OK)
From the A6 outputs: `AWS_REGION`, `AWS_DEPLOY_ROLE_ARN`, `ECR_REPOSITORY_URL`, `ECS_CLUSTER` (`learnix-production`), `ECS_SERVICES=api,worker`, `MIGRATE_FAMILY`, `TASK_NETWORK`, `DEPLOY_ALARMS`, `API_URL=https://<cloudfront_domain_name>` (switched to `https://api.learnix.school` at A11), and `SMOKE_FROM_RUNNER=true` (production has no IP allowlist).

### A9 — Prove the code on staging first ⛔ GATE (Me)
The production deploy gate requires a green `develop` push run with the **same tree** as `main`. Two problems:
1. `develop` is 1 commit behind `main` (`a8b8e06`).
2. **New finding (C-9):** the gate only checks that the develop run *succeeded*, not that it *deployed*. An infra-only push is green without deploying, so the gate can pass while staging still runs `ae719a9-r1` (5 days and the whole EasyKash migration behind). That would make the "proven on staging" guarantee false.

Plan:
- Fast-forward `develop` to `main` (a no-op content change; it creates the green develop run the gate needs).
- Then `workflow_dispatch` **deploy staging** from `develop`. This builds the image, runs the new migrations (the EasyKash ones) on the **staging** DB, and rolls out. Watch the run; the deploy job fails if alarms trip.
- Verify from an allowlisted IP (yours), or I add my current IP to the staging WAF allowlist only with your approval: `scripts/staging-acceptance.mjs https://dz8egx08r1ti9.cloudfront.net --frontend https://staging.learnix.school`.
- **Rollback:** the `rollback` workflow action with the previous task-def ARN (`learnix-staging-api:3`).
- The C-9 gate fix is tracked as a Phase D item, not done here.

### A10 — First production deploy, then scale up ⛔ GATE ×2 (Me)
1. `workflow_dispatch` **deploy production** on `main`. It builds the arm64 image (`<sha>`), pushes it to the prod ECR, runs the `migrate` task (all migrations on the empty RDS, plus the system seed), and points `api`/`worker` at the new revision (still 0 tasks). The migration classifier may ask for `production-db-approval`, since an empty DB counts as "all new" migrations.
2. Then set `api_desired_count = 2`, `worker_desired_count = 1` in tfvars → plan → **approve** → apply. Autoscaling attaches.
- **Verify (against the CloudFront default name, before any DNS change):**
  - ECS `runningCount == desiredCount`, ALB targets `healthy`, migrate task exit 0, no restarts in 15 min.
  - `curl https://<cloudfront_domain_name>/api/v1/health` → 200; `/api/v1/health/readiness` → 200 (DB + Valkey).
  - Preflight with `Origin: https://learnix.school` → exact ACAO + `Allow-Credentials: true`; a foreign origin and `*.vercel.app` get no ACAO.
  - CloudWatch: the boot log shows `Allowed CORS Origins: https://learnix.school`, and no env-validation errors.
- **Rollback:** scale back to 0 (tfvars), or `rollback` to the previous task def. Users are not affected yet (DNS unchanged).

### A11 — TLS + DNS for `api.learnix.school` ⛔ GATE ×3 (You in Cloudflare; Me for Terraform)
1. **Cloudflare (You):** add CAA `0 issue "amazon.com"` at the apex, next to the existing six issuers. Without it, ACM issuance fails (verified: the current CAA set has no amazon.com). Removing nothing keeps Universal SSL working.
2. **Me:** set `certificate_enabled = true` → plan → approve → apply. This requests the ACM certificate in us-east-1, and `terraform output cloudflare_dns_records` gives the validation CNAME.
   **You:** add that CNAME in Cloudflare, **DNS only (grey cloud)**. Wait for ACM `ISSUED`.
3. **Me:** set `certificate_validated = true` → plan → approve → apply. The distribution gains the `api.learnix.school` alias, and the output gives the API CNAME target (`dxxxx.cloudfront.net`).
   **You:** write down the current `api` record (type, target, proxy status) for rollback, then **replace** it with `CNAME api → <cloudfront_domain_name>`, **DNS only**. This is the moment the site starts working.
   Also add the SES DKIM / MAIL FROM records from the same output (they are harmless before SES production access). Keep the existing `_dmarc` (Brevo `rua`).
- **Verify:**
  - `dig api.learnix.school` returns CloudFront addresses, not Cloudflare's.
  - `curl -I https://api.learnix.school/api/v1/health` → 200, cert issuer Amazon.
  - `node learnix-infra/scripts/cutover-verify.mjs api.learnix.school <cloudfront_domain_name>`.
- **Rollback:** restore the noted `api` record. The site returns to today's state (525), which is no worse than now.

### A12 — Hand-off to Phase B (Me)
Update `API_URL` in the GitHub `production` env to `https://api.learnix.school`, then rerun the audit's live test table (DNS, HTTPS, health, readiness, preflight, `/marketplace/categories`, in-app browser on `/marketplace` with no "Network error" and no console CORS errors). Phase B (Vercel env confirmation, login journey) starts after that.

### A13 — Hygiene (Me with your OK)
Delete any bootstrap IAM access keys; confirm `aws iam list-users` shows no keys; confirm the SNS alert subscription; set a budget alarm at the D6 figure.

---

## 3. Deliberately NOT in Phase A
EasyKash live keys and callbacks; SES production mail; SMS sender ID; Meta WhatsApp webhook; Zoom/Google/Microsoft OAuth redirects; the CloudFront flat-rate Business plan; `waf_block = true` (after tuning); the Organization/log-archive (D1-b); `read_only_root_filesystem`; the Phase D pipeline fixes (C-2, C-3, C-4, C-9). Each of these comes later as its own approved change.

## 4. Risks to watch
| Risk | Where | Mitigation |
|---|---|---|
| First real plan differs from the mocks (quotas, service-linked roles, us-east-1 WAF/ACM) | A5/A6 | Plan reviewed before apply; report and stop, no workarounds |
| Production gate passes on a non-deploying develop run (C-9) | A9 | Deploy staging explicitly and verify it before the prod dispatch |
| Empty-DB migrations classified "destructive" | A10 | Expected; approve via `production-db-approval` after reading the classifier output |
| Cloudflare proxy accidentally left on (orange) for `api` | A11 | Must be DNS-only: the ACM cert is on CloudFront, and a proxied record keeps the Cloudflare edge in front |
| Encryption keys lost | A7 | Escrow before the first deploy |
| GitHub Actions billing rejection returns | A9/A10 | Check repo billing before A9; the runs of 2026-10-18 succeeded |

## 5. Approval checklist (reply per step)
- [ ] D1–D6 answered
- [ ] A1 account created (You) → I verify identity
- [ ] A2 bootstrap plan approved → apply
- [ ] A3 GitHub envs/vars
- [ ] A4 tfvars JSON approved
- [ ] A5 plan reviewed → **A6 apply approved** (billing starts)
- [ ] A7 keys escrowed
- [ ] A8 prod env vars
- [ ] A9 develop sync + staging deploy approved
- [ ] A10 prod deploy approved → scale-up apply approved
- [ ] A11 CAA → cert apply → validation CNAME → validated apply → `api` CNAME switch
- [ ] A12 verification → Phase B
