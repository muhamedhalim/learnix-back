# Initial AWS deployment: staging (status report)

Date: 2026-10-13. **Status: DEPLOYED AND SERVING (API-only staging).** All 183 planned resources exist, the backend
image runs on ECS Fargate, and the health endpoints, database, Redis and admin login were verified through CloudFront.
Remaining items are external-provider configuration and the frontend wiring (section 6). Nothing was changed in
DNS, Vercel or production.

|                             |                                                                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS account                 | `486940690416` (standalone; account plan upgraded from FREE to PAID during this work)                                                                                           |
| Region                      | `eu-central-1` (CloudFront / WAF scope items live in the global / us-east-1 plane)                                                                                              |
| Operator identity           | IAM user `learnix-terraform` through local CLI profile `learnix-staging` (no keys in repo, state or reports)                                                                    |
| Terraform                   | 1.12.2, AWS provider 6.68.0                                                                                                                                                     |
| Backend source              | learnix-back `HEAD` `ae719a9` plus one **uncommitted** fix to `scripts/docker-entrypoint.sh` (section 4)                                                                        |
| Image running               | `486940690416.dkr.ecr.eu-central-1.amazonaws.com/learnix-staging/api:ae719a9-r1`, linux/arm64, digest `sha256:a077f0184b6d0efa22276937fb502d810a6011e536bda6a3bcfc943f898beae2` |
| Previous image (superseded) | `…/api:ae719a9`, digest `sha256:1614f165aa245261f433a09069729d392a85956a9488aa76e920cf2d2f06adb5` (crash-loops with ADOT, see section 4)                                        |
| ECS task definition         | `learnix-staging-api:3` (revision 3), 1 running task                                                                                                                            |
| API URL                     | `https://dz8egx08r1ti9.cloudfront.net` (CloudFront default certificate)                                                                                                         |
| Frontend                    | Unchanged: Vercel.                                                                                                                                                              |

## 1. Resources (183 planned, 183 created; final plan shows only provider-drift no-ops)

| Area           | Resources                                                                                                                                                                     | Status                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| State and CI   | S3 state bucket `learnix-staging-tfstate-486940690416`, KMS key (alias `learnix-staging-tfstate`), GitHub OIDC provider, `learnix-gha-plan`, `learnix-gha-apply`              | created; bootstrap state migrated to S3 and verified (plan: no changes) |
| Network        | VPC `10.10.0.0/16`, 2 AZs, 3 subnet tiers, S3 gateway endpoint, REJECT flow logs; **no NAT**                                                                                  | created                                                                 |
| Edge           | CloudFront `E1BTQT8D6RRQQ3`, VPC origin, WAF web ACL (allowlist of the operator /32; webhook paths open)                                                                      | created, serving                                                        |
| Load balancer  | internal ALB `learnix-staging-alb`, target group `api`                                                                                                                        | created, 1 target **healthy**                                           |
| Compute        | cluster `learnix-staging`, ECR `learnix-staging/api`, service `api` (PROCESS_ROLE=all, 0.5 vCPU / 1 GiB ARM64, ADOT sidecar), migrate task definition                         | created; running                                                        |
| Data           | RDS `learnix-staging-pg` (PostgreSQL 16.9, db.t4g.micro, single-AZ, encrypted, private, 7-day backups, deletion protection off, no final snapshot)                            | available                                                               |
| Cache          | ElastiCache Valkey 8.0 `learnix-staging-valkey` (cache.t4g.micro, TLS + AUTH)                                                                                                 | available                                                               |
| Storage        | `learnix-staging-files-…`, `-logs-…`, `-video-source-…`, `-video-output-…` (all `-486940690416`)                                                                              | created                                                                 |
| Messaging      | SES configuration set, SNS/SQS feedback queues + DLQs, End User Messaging SMS configuration set                                                                               | created                                                                 |
| Secrets        | `learnix/staging/core` and `valkey` (generated), `paymob`, `meta-whatsapp`, `vapid`, `cloudfront-signing`, `meetings` (**empty, operator-filled**), RDS-managed master secret | created                                                                 |
| Observability  | alerts topic `learnix-staging-alerts`, 18 alarms, dashboard `learnix-staging-overview`, RUM monitor `5a4ebc24-d3b7-4fb8-ba6e-54c69b749228`, Application Signals enabled       | created                                                                 |
| CI deploy role | `learnix-staging-gha-deploy-api` (OIDC, GitHub environment `staging` of `muhamedhalim/learnix-back`)                                                                          | created                                                                 |

## 2. Configuration used (git-ignored `environments/staging/terraform.tfvars`, `backend.hcl`)

- `frontend_url = https://staging.learnix.school` (the repository's documented staging origin). **Not yet wired:**
  it does not resolve until you assign it in Vercel and create DNS. First attempt with `https://learnix.school`
  was correctly refused by the application's environment-isolation guard (production host in a staging
  environment); that control was kept, not bypassed. CORS allows exactly this one origin with credentials; an
  unlisted origin (`https://evil.example`) receives no CORS headers (observed).
- `allowed_ipv4_cidrs`: the operator's public /32 at deploy time. If the IP changes, update and re-apply.
- `admin_email`, `alert_emails`, `mail_allowlist`: `mohalim612002@gmail.com`.
- `mail_from_email = no-reply@staging.learnix.school`: **no SES identity is verified** (sandbox). Sending will fail
  until one is verified (section 6).
- `image_tag = ae719a9-r1`, `api_desired_count = 1` (note: Terraform ignores `desired_count` and the service
  task definition after creation, so scaling and image rollouts were done with `aws ecs update-service`; the
  pipeline owns that from now on).
- `domain_name = null`: no Route 53 zone, certificate or DNS exists for staging.

## 3. Verification results (observed 2026-10-13, from the allowlisted IP)

| Check                                         | Result                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account / region                              | `486940690416` / `eu-central-1` confirmed by `sts get-caller-identity` and the Terraform plan                                                                                                                                                                                                                                                      |
| Migrations                                    | One-off task `learnix-staging-migrate` on `ae719a9`: exit code 0, migrations table populated (latest `AddWebPushProvider2205900000000`)                                                                                                                                                                                                            |
| ECS service                                   | 1 running, 0 pending, rollout `COMPLETED` on revision 3; no failed tasks after the fix                                                                                                                                                                                                                                                             |
| ALB target health                             | `healthy`                                                                                                                                                                                                                                                                                                                                          |
| `GET /api/v1/health` via CloudFront           | 200 `{"status":"healthy"}`                                                                                                                                                                                                                                                                                                                         |
| `GET /api/v1/health/readiness` via CloudFront | 200 `{"status":"ready"}`                                                                                                                                                                                                                                                                                                                           |
| TLS                                           | Served over HTTPS on the CloudFront default certificate; **no custom-domain certificate exists yet**                                                                                                                                                                                                                                               |
| Database                                      | `PostgreSQL: healthy` in the admin health dashboard; initial administrator created on boot                                                                                                                                                                                                                                                         |
| Redis                                         | `Redis: healthy`; BullMQ queues and crons (email, exam, parent notifications, marketplace, etc.) healthy                                                                                                                                                                                                                                           |
| S3                                            | `Amazon S3: healthy`                                                                                                                                                                                                                                                                                                                               |
| Admin login                                   | `POST /auth/csrf-token` then `/auth/login` with the generated admin password: 200, `access_token` and CSRF cookies set, role `admin` (password read from Secrets Manager, never printed)                                                                                                                                                           |
| CORS                                          | Preflight from `https://staging.learnix.school`: 204 with `Allow-Origin` and credentials; from `https://evil.example`: no allow header                                                                                                                                                                                                             |
| Admin dashboard `/health/all`                 | overall `degraded`, score 96: 24 healthy, 1 warning, 1 degraded, 2 misconfigured, 4 disabled                                                                                                                                                                                                                                                       |
| WAF block for non-allowlisted addresses       | **Not tested** (no second egress IP available)                                                                                                                                                                                                                                                                                                     |
| Non-checks                                    | `/auth/me` returned 404 to a guessed path (the profile route is `/users/me`). **Correction (API audit, 2026-10-19):** `/marketplace/courses` is a real public route; its 404 was the deployed task environment missing `MARKETPLACE_ENABLED=true`, which removes the whole marketplace module (see `learnix-back/docs/audits/API-AUDIT-REPORT.md`) |

Dashboard items needing attention (none block the API):

| Item                                               | Meaning                                                                                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend API `degraded`                             | Dashboard cites latency or memory; the process was a few minutes old with ADOT cold start. Re-check after a few hours of use                            |
| Payment gateway `misconfigured`                    | Paymob test credentials not loaded (secret `paymob` empty)                                                                                              |
| Bunny Stream (no longer listed)                    | Removed from the code 2026-10-15; the dashboard now reports "Lesson video (AWS)", which is `misconfigured` until the CloudFront signing key is injected |
| Learnix frontend `warning`                         | `staging.learnix.school` does not resolve yet                                                                                                           |
| Firebase, Meta WhatsApp, Twilio, Sentry `disabled` | Not configured on purpose (see `AWS-SERVICE-DECISIONS.md`)                                                                                              |

## 4. Issues found and fixed during deployment

1. **AWS Free plan** rejected RDS (7-day backup retention) and the SMS configuration set. Resolved by you upgrading the plan.
2. **API crash loop (revision 1) caused by a real bug in `learnix-back/scripts/docker-entrypoint.sh`.** With Application
   Signals, the ADOT sidecar sets `NODE_OPTIONS=--require …autoinstrumentation.js`. The entrypoint runs `node -e` to
   compose `DATABASE_URL` / `REDIS_URL`, so the preload's log lines were captured into the URLs and the app refused to
   boot (`Redis URL must use rediss://`). Migrate worked only because it has no ADOT. **Fix:** the two helper
   invocations now run with `NODE_OPTIONS=` cleared. Verified locally with a noisy preload (old image: URL
   corrupted; new image: `rediss://` and `postgresql://`). **This change is uncommitted in `learnix-back`: commit it**,
   otherwise the next pipeline build reintroduces the crash.
3. **Environment-isolation guard** refused `FRONTEND_URL=https://learnix.school` in staging (section 2).

## 5. Outputs for connecting the backend and frontend

| Output                                           | Value                                                                                                                              |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `api_url`                                        | `https://dz8egx08r1ti9.cloudfront.net`                                                                                             |
| ECR repository                                   | `486940690416.dkr.ecr.eu-central-1.amazonaws.com/learnix-staging/api`                                                              |
| `ecs_cluster` / `migrate_task_definition_family` | `learnix-staging` / `learnix-staging-migrate`                                                                                      |
| `task_network`                                   | subnets `subnet-07e60f66c8304e41b`, `subnet-07bf4f600f42205dc`; security group `sg-03a518f2db12401d9`; public IP enabled           |
| `alerts_topic_arn`                               | `arn:aws:sns:eu-central-1:486940690416:learnix-staging-alerts` (confirm the e-mail subscription sent to `mohalim612002@gmail.com`) |
| `cloudfront_distribution_id`                     | `E1BTQT8D6RRQQ3`                                                                                                                   |
| RUM                                              | monitor `5a4ebc24-d3b7-4fb8-ba6e-54c69b749228`, identity pool `eu-central-1:7a3e007a-2f2d-479c-9ead-12c73c1f787c`                  |
| Deploy role                                      | `terraform output deploy_roles` (api)                                                                                              |

**Vercel variables for a staging scope (documented only; nothing was set):** `NEXT_PUBLIC_API_URL=https://dz8egx08r1ti9.cloudfront.net`,
`NEXT_PUBLIC_SITE_URL=https://staging.learnix.school`, `NEXT_PUBLIC_APP_ENV=staging`, and the `NEXT_PUBLIC_RUM_*` values from
`terraform output vercel_environment`. Redeploy the frontend after changing them (build-time values).

**DNS / domain records (not changed):**

- `staging.learnix.school` is the staging frontend origin: assign it to the Vercel project and add the record Vercel shows.
- API custom host for staging later: set `domain_name = "staging.learnix.school"`, apply, add the printed
  `name_servers` as NS records for `staging` in the parent zone, then `custom_domain_enabled = true` (ACM certificate in
  us-east-1, DNS validated). CAA records must permit `amazon.com` (the live zone blocked ACM per the earlier audit).
- Production `api.learnix.school` is a separate stage: see `VERCEL-AWS-DNS-CUTOVER.md`.

## 6. Remaining steps (you / next session)

1. **Commit** the `docker-entrypoint.sh` fix in `learnix-back` (and push so CI builds with it).
2. Assign `staging.learnix.school` in Vercel and DNS, or tell me the real staging origin and I will update `frontend_url`.
3. SES: verify a sender (`aws sesv2 create-email-identity --email-identity mohalim612002@gmail.com`, click the link, set
   `mail_from_email` to it) or verify the staging domain after delegation. Until then no mail is delivered.
4. Fill operator secrets: `paymob` (TEST), `meta-whatsapp`, `vapid`, `cloudfront-signing`; set the matching
   `extra_secrets`/`inject_*` variables and apply. **Escrow `MEETING_TOKEN_ENCRYPTION_KEY` and
   `PAYOUT_ACCOUNT_ENCRYPTION_KEY` outside AWS now** (never bump `core_version`).
5. Create the GitHub environment `staging` in `muhamedhalim/learnix-back` with the variables from
   `AWS-DEPLOYMENT-RUNBOOK.md` section 2.4, so the OIDC pipeline can deploy.
6. Optional: AWS Budget at USD 120 (50 / 80 / 100 %), not created here.
7. Retire the static `learnix-terraform` access key once the OIDC path is proven.
8. Two cosmetic perpetual diffs remain in `terraform plan` (`rds.force_ssl` apply method and an SMS config set default
   message type); applying them is harmless and was not required.

## 7. Rollback

- **Image:** `aws ecs update-service --cluster learnix-staging --service api --task-definition learnix-staging-api:1`
  re-points to revision 1 (the crash-looping image: only useful to demonstrate; there is no previous good image), or
  deploy a different immutable tag by setting `image_tag` and applying, then updating the service.
- **Stop traffic and compute cost:** `aws ecs update-service --cluster learnix-staging --service api --desired-count 0`
  (about USD 20 per month saved; data, ALB, WAF and caches keep running, about USD 70 per month).
- **Remove staging:** `terraform destroy` in `environments/staging` was deliberately not run; it needs your explicit approval.
  `force_destroy` is set, so buckets and the repository would be emptied.

## 8. Security notes

- No IAM users or access keys were created; CI uses OIDC roles. The existing admin key is still active (step 7).
- Secrets are generated in Secrets Manager through write-only arguments and are not in state, outputs or this report.
  The generated admin password was used once for the smoke test and not recorded anywhere.
- RDS and Valkey are in private subnets with no internet route; only the task security group can reach them.
- The WAF default is "allow only the operator /32 and webhook paths". The managed rule groups are in COUNT mode (tune, then block).
