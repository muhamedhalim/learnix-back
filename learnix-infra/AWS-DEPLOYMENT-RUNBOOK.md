# AWS deployment runbook

The ordered path from "the AWS account exists" to production, then the routine procedures (deploy,
rollback, restore). **The frontend stays on Vercel and is deployed by Vercel, separately: this runbook covers the
AWS backend and lists, in section 6, the Vercel and DNS settings you must change by hand.** Detailed checklists live in `docs/phase2-…phase8-*.md`; this page is the spine.
Every `<…>` is a placeholder. Nothing in this repository creates AWS resources on its own: every apply is
a reviewed GitHub workflow run, and every external or irreversible step is yours to perform.

## 0. Before you start

- Tools: Terraform 1.12.2 (`.terraform-version`), AWS CLI v2, Node 24, Docker with buildx, `jq`.
- Decisions to have made (AWS-OPEN-ITEMS.md §3): budget ceiling, Support plan, CloudFront Business plan,
  video ladder, 1 vs 2 NAT, legal checks (PDPL, minors, Paymob SAQ).
- Fresh start confirmed: nothing is migrated from Railway, R2 or Bunny (plan §0.0).
- Vercel stays the frontend host: keep the Vercel project, Git integration and domain exactly as they are. Do not
  change any Vercel production variable until the launch step in section 3.4.

## 1. First steps after creating the AWS account (day 0)

1. **Root user**: MFA on, no access keys, billing alerts on, contact details. Choose the payment method.
2. **Organization and accounts** (docs/phase2-manual-steps.md): enable Organizations in the management
   account, then apply `org/` locally once with an admin session (or the bootstrap role):
   accounts `log-archive`, `staging`, `production`; SCPs; IAM Identity Center users + MFA; org CloudTrail;
   GuardDuty delegated admin; budgets and anomaly monitor. Confirm the budget test email arrives.
3. **Start the long-lead requests immediately** (they take days to weeks):
   - **SES production access** in `learnix-production` (eu-central-1): use-case description, expected
     volume, bounce/complaint handling (SNS → SQS consumer exists). Staging stays in the sandbox.
   - **Egypt SMS sender ID registration** (AWS End User Messaging SMS, production account): letter of
     authorisation, company registration document. Then create the **protect configuration** allowing only
     Egypt and raise the **monthly SMS spend limit** deliberately (it is the hard cost cap).
   - **Service quotas** check: Fargate vCPU, MediaConvert concurrent jobs, SES sending rate.
4. **Bootstrap each workload account** (`bootstrap/`, once per account with an Identity Center admin
   session): state bucket + KMS, GitHub OIDC provider, `gha-tf-plan` / `gha-tf-apply` roles.
5. **GitHub configuration**
   - `learnix-infra`: repository variables `STAGING_*` / `PRODUCTION_*` (`PLAN_ROLE_ARN`, `APPLY_ROLE_ARN`,
     `TF_STATE_BUCKET`, `TF_STATE_KMS_KEY_ARN`, `TFVARS_JSON`) and `AWS_REGION=eu-central-1`; environments
     `infra-staging`, `infra-production` (two reviewers incl. the database owner), `infra-management`.
   - `learnix-back`: environments `staging` and `production` (reviewers on production) and
     `production-db-approval` (database owners). Variables are filled in step 2.4. `learnix-front` needs no AWS
     environment (Vercel builds and deploys it).
6. **Enable Application Signals** once per workload account (creates its service-linked role):
   `aws application-signals start-discovery --region eu-central-1`
   (or set `application_signals_enabled = false` until you do).

## 2. Staging (docs/phase3-staging.md, phase4, phase5)

1. Fill `STAGING_TFVARS_JSON` from `environments/staging/terraform.tfvars.example` (allowlist your
   office/VPN IPs, `app_repositories`, desired counts 0) and run the **Terraform** workflow (`target=staging`). ~25 minutes.
2. **Secrets** (Secrets Manager, `learnix/staging/*`): read the generated `core` values and **escrow
   `MEETING_TOKEN_ENCRYPTION_KEY` and `PAYOUT_ACCOUNT_ENCRYPTION_KEY` outside AWS**; fill `vapid`,
   `cloudfront-signing`, `paymob` (TEST), `meta-whatsapp`, `meetings` as in phase3-staging.md, then set
   `inject_vapid`, `inject_cloudfront_key`, `video_public_key_pem`, `extra_secrets`, `extra_environment`.
3. Verify the `mail_allowlist` addresses in SES (sandbox).
4. **Backend pipeline**: from `terraform output`, set in the `learnix-back` repository's `staging` environment:

   | Variable              | Value from                                                |
   | --------------------- | --------------------------------------------------------- |
   | `AWS_REGION`          | `eu-central-1`                                            |
   | `AWS_DEPLOY_ROLE_ARN` | `deploy_roles.api`                                        |
   | `ECR_REPOSITORY_URL`  | `ecr_repositories.api`                                    |
   | `ECS_CLUSTER`         | `ecs_cluster`                                             |
   | `ECS_SERVICES`        | `api` (or `api,worker` with `split_roles`)                |
   | `MIGRATE_FAMILY`      | `migrate_task_definition_family`                          |
   | `TASK_NETWORK`        | `task_network` (JSON)                                     |
   | `ALARM_PREFIX`        | `learnix-staging`                                         |
   | `API_URL`             | `api_url` (the API host, used by the optional smoke test) |

   **Vercel staging scope** (manual, section 6): set the values printed by `terraform output vercel_environment`
   for the staging deployment only. There is no frontend image, ECR repository or deploy role on AWS.

5. **First deploy**: run _Deploy API to AWS_ (staging). It builds the arm64 image with the RDS CA bundle, scans
   it, pushes `<sha>`, runs the migrate task (150 migrations on the empty database) and points the services at
   the new revision (still 0 tasks).
6. Raise `api_desired_count` to 1 (and `worker_desired_count` with `split_roles`), apply. Autoscaling attaches
   now. The API boot seeds the admin, rank tiers and alert rules.
7. **Acceptance**: `node scripts/staging-acceptance.mjs https://<staging api host> --frontend https://<staging
frontend origin>` from an allowlisted address (it checks the API, the credentialed-CORS contract with the
   frontend origin, preview-URL rejection, and that the Vercel site answers), then log in through the real
   Vercel staging site (cookies set, CSRF header accepted), then the per-service tests in
   docs/phase4-service-migrations.md (S3 upload limits, video
   upload → transcode → signed playback + 403 without cookies, SES simulator bounce/complaint, SMS
   simulator delivery events → `parent_messages` status, Web Push on Chrome/Firefox/Android,
   RUM events in the console, X-Ray traces for api and worker, queue backlog metric present). Playback needs
   the player on the Vercel origin: confirm the signed cookies reach `api.<domain>/video/*` cross-origin.
8. **Hardening proof**: staging runs `read_only_root_filesystem = true` by default. Exercise uploads,
   code exports, PDF/certificate generation and image optimisation; any EROFS/EACCES error in the logs
   means a missing writable path.
9. **Phase 5**: `k6 run loadtest/catalog.k6.js` with production sizing (FR-331 thresholds),
   `scripts/pitr-restore-drill.sh` (record the RTO), region-restore tabletop, re-run the Pricing Calculator.

## 3. Production (docs/phase6-production.md, phase7-launch.md)

1. Fill `PRODUCTION_TFVARS_JSON` from `environments/production/terraform.tfvars.example`, including **every**
   record of the current Cloudflare zone (except `_dmarc`) in `dns_records`. That includes the apex and `www`
   records that point at Vercel: copy their targets from Vercel's domain settings, do not guess them. Lower
   record TTLs to 300 s a day ahead. Apply with the **Terraform** workflow (`target=production`) (two reviewers).
2. Subscribe the **CloudFront flat-rate Business plan** to the distribution (console). Secrets as in 2.2
   (Paymob **LIVE**), escrow the encryption keys, set `sms_sender_id` / `sms_protect_configuration_id`
   once approved, `learnix-back` `production` environment variables (2.4, plus `DB_INSTANCE_ID`), deploy the
   API (production dispatch requires a green staging deploy of the same commit), raise counts to 2/1.
3. `node scripts/dns-diff.mjs records.json --old <cloudflare ns> --new <route53 ns>` must show zero
   differences for the existing records (apex and www still resolve to Vercel); send test mail to and from the
   domain. **You** change the name servers at Name.com. After propagation set `certificate_enabled = true` and
   apply: this issues the certificate for `api.<domain>`, attaches the alias and creates the `api` A/AAAA records.
   Nothing else in the zone changes and the apex never moves to AWS.
4. Launch (phase7-launch.md): `node scripts/staging-acceptance.mjs https://api.<domain> --frontend
https://<domain> --pin <cloudfront domain>` before announcing; set the **Vercel Production** variables
   (section 6: `NEXT_PUBLIC_API_URL=https://api.<domain>` etc.) and redeploy the frontend from Vercel; update the
   provider callbacks (Paymob, Meta, OAuth) to `https://api.<domain>/api/v1/...` (`terraform output
provider_callback_urls`); set `canary_enabled = true`; live checks (log in on the real site, a low-value live
   Paymob payment you perform and refund), 48 h hypercare, WAF tuning then `waf_block = true`, enable
   `read_only_root_filesystem` after staging proved it, announcement.

## 4. Routine operations

### Deploy

_Deploy API to AWS_ (`learnix-infra/scripts/ecs-deploy.sh`): new task-definition revision with the commit image →
migrate task must exit 0 → services rolled → wait for `COMPLETED` → no alarm named `learnix-<env>-*` in ALARM
after 60 s. The frontend is deployed by Vercel's Git integration, independently: a frontend release never touches
AWS, and an API release never touches Vercel. When a release changes the API contract, deploy the API first
(additive changes) and the frontend second. Any failure after the roll started → automatic rollback to the
recorded previous revisions (artifact `previous-task-definitions-*`). Production API deploys take a manual
RDS snapshot `pre-deploy-<time>-<sha>` first.

### Roll back

- API: _Roll back API on AWS_ with the previous revisions from the deploy artifact (or any ARN from the ECS
  console). The circuit breaker already rolls back failed deployments.
- Frontend: Vercel dashboard, promote the previous deployment (instant rollback). Independent of AWS.
- Database: never down-migrate in production. Restore to a new instance with PITR
  (`scripts/pitr-restore-drill.sh --keep`), verify with `scripts/restore-verification.sql`, then point
  `DB_HOST` at it (apply) and redeploy.
- Traffic: the apex never moved, so there is no traffic switch to undo. To take the AWS API out of service, point
  the Vercel Production `NEXT_PUBLIC_API_URL` back at the previous backend (only while one exists) and redeploy
  the frontend; Vercel/Cloudflare stay untouched until Phase 8.

### Restore from AWS Backup

Console → AWS Backup → vault `learnix-production-vault` (or the eu-west-1 copy) → recovery point → restore
to a new RDS instance / new S3 bucket; never restore over the live resource.

### Secrets rotation

- JWT / cookie / metrics secrets: write a new value for only those keys into `learnix/<env>/core`
  (`aws secretsmanager put-secret-value` with the full JSON, other keys unchanged), then force a new
  deployment of api and worker. Sessions end.
- **Never bump the secrets module's `core_version` on an environment that holds data**: it regenerates every
  core secret, including `MEETING_TOKEN_ENCRYPTION_KEY` and `PAYOUT_ACCOUNT_ENCRYPTION_KEY`, which makes stored
  meeting tokens and payout accounts unreadable. Rotating those two keys needs a re-encryption migration.
- Provider credentials (Paymob, Meta, meetings, VAPID, CloudFront signing): update the secret, force a new
  deployment. A new VAPID key pair invalidates existing browser subscriptions.

### Scaling

web/api: CPU target tracking 2–6 tasks. worker: backlog-per-task target (`worker_backlog_per_task`, default 100) and CPU, 1–`worker_max_count`. Database/Valkey class changes are a short failover.

## 5. Local checks before any change is merged

```bash
terraform -chdir=environments/staging test && terraform -chdir=environments/production test
```

```bash
node scripts/provider-audit.mjs
```

```bash
docker run --rm -v "$PWD/scripts/tests:/fake" -v "$PWD/scripts:/src:ro" alpine:3.20 sh -c "apk add --no-cache bash jq >/dev/null && mkdir -p /work && install -m 755 /fake/fake-aws /usr/local/bin/aws && bash /fake/ecs-deploy.test.sh"
```

Plus tflint and checkov (`terraform.yml`), and in the app repositories their CI (unit, e2e, migration chain).

## 6. Manual configuration outside Terraform (Vercel, DNS, providers)

Terraform never writes to Vercel or to the registrar. After the AWS account exists:

| Where                                                                                                   | What                                                                                                                                                                                                                                                                                                                                                                                        | When                            |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Vercel, project settings, Environment Variables (Production)                                            | `NEXT_PUBLIC_API_URL=https://api.<domain>`, `NEXT_PUBLIC_SITE_URL=https://<domain>`, `NEXT_PUBLIC_APP_ENV=production`, and the five `NEXT_PUBLIC_RUM_*` values; all printed by `terraform output vercel_environment`. **Read the current values first and keep a note of them; do not overwrite them before launch.** They are build-time values: redeploy the frontend after changing them | Launch (3.4)                    |
| Vercel, Environment Variables (staging scope: a branch-scoped Preview variable or a custom environment) | The staging values from the staging stack's `vercel_environment` output. Previews of other branches keep whatever they have today; they are not trusted by either API                                                                                                                                                                                                                       | Staging (2.4)                   |
| Vercel, Deployment Protection                                                                           | Protect the staging deployment (Vercel Authentication or password): it replaces the never-built Cloudflare Access gate for the pages; the AWS WAF allowlist gates the staging API. Plan availability of this feature is not verified here                                                                                                                                                   | Staging                         |
| Vercel, Node.js version                                                                                 | `learnix-front/package.json` now declares `engines.node >= 24`; Vercel follows `engines` over the project setting, so the Vercel build runtime changes. Confirm Node 24 is the intended runtime in the project settings before the next production build                                                                                                                                    | Before the next frontend deploy |
| Vercel, Domains                                                                                         | No change: the apex and `www` stay assigned to the project. Copy the DNS target values Vercel shows into `dns_records`                                                                                                                                                                                                                                                                      | Phase 6                         |
| Name.com                                                                                                | Name servers to the Route 53 zone (after the `dns-diff` check). **Moving DNS removes Cloudflare's proxy in front of the Vercel site** if it is proxied today; decide that deliberately (AWS-OPEN-ITEMS.md D1)                                                                                                                                                                               | Phase 6                         |
| Paymob, Meta, Zoom/Google/Microsoft dashboards                                                          | Callback and webhook URLs on `https://api.<domain>` (`terraform output provider_callback_urls`)                                                                                                                                                                                                                                                                                             | Launch                          |
| Sentry (frontend)                                                                                       | Unchanged; DSN stays in Vercel until Phase 8                                                                                                                                                                                                                                                                                                                                                | Phase 8                         |
