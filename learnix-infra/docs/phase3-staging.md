# Phase 3: staging platform runbook

`environments/staging` builds the whole staging stack in the `learnix-staging` account from the modules in
`modules/`. **Nothing has been applied.** This code was checked offline only: `terraform validate`,
`terraform test` (a full mocked-provider plan of six scenarios), tflint and checkov. The first real
`terraform plan` runs after the Phase 2 manual steps are done and the staging account exists.

## What it creates

| Layer         | Resources                                                                                                                                                                                                                                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Edge          | CloudFront for the **API host only** (pay-as-you-go), WAF web ACL (default: only allowlisted addresses, provider-webhook paths and the public reads Vercel makes itself get in; managed rule groups in COUNT mode), VPC origin to an **internal** ALB. The staging frontend is a Vercel deployment, not part of this stack |
| Compute       | ECS cluster (Fargate, ARM64), ECR repo `learnix-staging/api` (immutable tags), service `api` (`PROCESS_ROLE=all`), optional `worker`, a `migrate` task definition                                                                                                                                                          |
| Data          | RDS PostgreSQL 16 single-AZ (`learnix_staging`, KMS, forced TLS, managed master secret), ElastiCache Valkey 8 single node (TLS + AUTH, `noeviction`)                                                                                                                                                                       |
| Storage       | `files` (KMS, versioned), `video-source` (Glacier after 30 d, expires after 90 d), `video-output`, `logs`                                                                                                                                                                                                                  |
| Video         | MediaConvert role, EventBridge rule, SQS queue + DLQ, CloudFront `/video/*` behaviour (only when a signing public key is supplied)                                                                                                                                                                                         |
| Messaging     | SES configuration set, optional domain identity with DKIM / MAIL FROM / DMARC, SNS to SQS feedback queues for mail and SMS, End User Messaging configuration set                                                                                                                                                           |
| Secrets       | `core` (generated), `valkey` (generated), operator-filled containers: `paymob`, `meta-whatsapp`, `vapid`, `cloudfront-signing`, `meetings`                                                                                                                                                                                 |
| Observability | alerts SNS topic, alarms for ALB, ECS, RDS, Valkey, DLQs and error-level log lines                                                                                                                                                                                                                                         |

No NAT gateway in staging: tasks run in public subnets with public IPs, but their security groups admit only the
internal ALB. The data stores sit in subnets with no internet route.

## Secrets never enter Terraform state

- `core` (JWT, cookie, the two AES keys, admin bootstrap password, metrics token) and the Valkey AUTH token are
  generated as **ephemeral** values and handed over through **write-only** arguments (`secret_string_wo`,
  `auth_token_wo`). They are not in state or in plan output.
- The RDS master password is created and held by RDS (`manage_master_user_password`).
- The backend image composes `DATABASE_URL` / `REDIS_URL` at start-up from `DB_*` / `REDIS_*`
  (`learnix-back/scripts/docker-entrypoint.sh`), so no URL with a password exists anywhere.
- Read a generated value with `aws secretsmanager get-secret-value` (needs the operator role). **Escrow
  `MEETING_TOKEN_ENCRYPTION_KEY` and `PAYOUT_ACCOUNT_ENCRYPTION_KEY`** somewhere independent right after the first
  apply; losing them makes the encrypted columns unreadable.
- Never bump `core_version` on an environment that holds data: it regenerates those two keys.

## Order of operations

Steps 4 and 5 are automated by the backend pipeline (`ci-cd.yml` in learnix-back, job `deploy`: build, scan, push,
migrate, roll out, roll back on failure). The frontend is not part of it: Vercel builds and deploys it. The manual commands below
remain the fallback; the full sequence is in `AWS-DEPLOYMENT-RUNBOOK.md` §2.

1. **Bootstrap** the staging account (`bootstrap/`, see `phase2-manual-steps.md`) and set the repository variables
   used by the workflows: `STAGING_PLAN_ROLE_ARN`, `STAGING_APPLY_ROLE_ARN`, `STAGING_TF_STATE_BUCKET`,
   `STAGING_TF_STATE_KMS_KEY_ARN`, `STAGING_TFVARS_JSON`, plus `AWS_REGION`. Create the GitHub environment
   `infra-staging` with required reviewers.
2. **Fill `STAGING_TFVARS_JSON`** from `environments/staging/terraform.tfvars.example` (set `frontend_url` to
   the Vercel staging origin). Leave `api_desired_count` at 0.
3. **Run the `Terraform` workflow with `target=staging`** (manual dispatch). It plans, runs the conftest policies, waits for the reviewer and
   applies exactly that plan. Expect the first apply to take about 25 minutes (CloudFront, RDS, Valkey).
4. **Build and push the API image** to the ECR repository (output: `ecr_repositories`). Build for **arm64**:
   `docker buildx build --platform linux/arm64 --build-arg RDS_CA_BUNDLE_URL=https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -t <repo>/api:<sha> .`
   There is no web image: set the staging `NEXT_PUBLIC_*` variables in Vercel instead (`terraform output
vercel_environment`; they are compiled into the browser bundle, so redeploy the Vercel staging build after
   changing them).
5. **Set `image_tag`** to the pushed tag, apply again, then **run the migration task** once:
   `aws ecs run-task --cluster learnix-staging --task-definition <migrate_task_definition_family> --launch-type FARGATE --network-configuration "awsvpcConfiguration={subnets=[...],securityGroups=[...],assignPublicIp=ENABLED}"`
   (the subnet and security-group values are the `task_network` output). Watch its log stream; it exits 0.
6. **Raise `api_desired_count`** (1) and apply. The API boot creates the admin from
   `admin_email` and the generated password, plus rank tiers and default alert rules.
7. **Smoke test** (API host through CloudFront from an allowlisted address): `/api/v1/health/readiness`, then on the
   Vercel staging site: admin login, create a course, upload a book (direct S3 upload), register a student.

## Custom domain (two stages)

1. Set `domain_name = "staging.learnix.school"` and apply. The Route 53 zone is created; copy the
   `name_servers` output into **NS records for `staging` in the parent zone** (Cloudflare today). Add the record
   that points the zone apex at the Vercel staging deployment to `dns_records` (value from Vercel's domain
   settings) so the staging frontend keeps resolving after the delegation.
2. Set `custom_domain_enabled = true` and apply. The us-east-1 certificate for `api.staging.learnix.school`
   validates over DNS, the alias records are created and the distribution serves that name. `api_url` (and
   `BACKEND_URL`, `VIDEO_PUBLIC_ORIGIN`) then use it, while `FRONTEND_URL`, CORS and S3 CORS stay the frontend
   origin. Update the Vercel staging `NEXT_PUBLIC_API_URL` and redeploy the staging frontend.

## Operator-filled secrets

| Secret                      | Keys                                    | How                                                                                                                                                                                                              |
| --------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vapid`                     | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | `npx web-push generate-vapid-keys`, then set `inject_vapid = true`                                                                                                                                               |
| `cloudfront-signing`        | `CLOUDFRONT_PRIVATE_KEY_B64`            | `openssl genrsa -out k.pem 2048`; `openssl rsa -in k.pem -pubout -out pub.pem`; put `base64 -w0 k.pem` in the secret, pass `pub.pem` as `video_public_key_pem`, set `inject_cloudfront_key = true`               |
| `paymob`                    | the app's `PAYMOB_*` variables          | map each with `extra_secrets` (`ENV_NAME = {secret = "paymob", key = "..."}`); non-secret ids go in `extra_environment`. `PAYMOB_EXPECTED_MODE=test` is fixed by Terraform and the app refuses to boot otherwise |
| `meta-whatsapp`, `meetings` | provider credentials                    | same mechanism; staging keeps `SMS_MODE=sandbox`                                                                                                                                                                 |

## Things that are manual by design

- **SES**: staging stays in the sandbox. Verify each address in `mail_allowlist` (and the sender if no domain
  identity exists) in the SES console. The domain identity completes once its DNS records resolve.
- **SMS**: the Egypt sender ID registration and the Egypt-only protect configuration have no Terraform resource;
  create them in the console. Staging uses `SMS_MODE=sandbox` and the simulator numbers.
- **CloudFront flat-rate plan**: production only; staging is pay-as-you-go.
- **Provider callbacks** (Paymob, Meta): point their staging apps at `<api_url>/api/v1/...` (`terraform output provider_callback_urls`). The webhook paths are
  open through the WAF gate (`open_path_prefixes`) because those callers authenticate by HMAC.

## Known limits and follow-ups

- `read_only_root_filesystem` is off. Fargate scratch volumes mount root-owned, so a non-root `node` process may
  not be able to write to them; prove the hardened setting in staging (Phase 5), then enable it per service.
- The ALB listener is plain HTTP inside the VPC (CloudFront VPC origin to internal ALB). Production adds an origin
  certificate (`certificate_arn`).
- The SES and SMS feedback queues are provisioned; the SMS delivery-event consumer is not written yet (the DLQ
  alarm will fire if messages are poisoned, but SMS feedback is simply not read).
- Worker autoscaling on queue depth, and the load-test sizing, are Phase 5.
- The Phase 2 conftest rules have not been run against a real plan; the first CI plan run is their first test.

## Acceptance (Phase 3 exit)

- [ ] `terraform plan` clean on a fresh account; the `Terraform` workflow (target staging) applies it
- [ ] 150 migrations run on the empty RDS (migrate task exit 0)
- [ ] `seed:staging` passes (run as a one-off task with the command overridden)
- [ ] Readiness green through CloudFront; a request from a non-allowlisted address gets 403; the Vercel staging site logs in and calls the API (credentialed CORS, cookies, CSRF)
- [ ] Kill a task: ECS replaces it; reboot RDS with failover (set `multi_az` temporarily) and recover
- [ ] A test alarm reaches `alerts_topic_arn` subscribers
- [ ] Upload, transcode (once `video_public_key_pem` is set) and play a video; the segment URL without cookies is 403
- [ ] `terraform plan` shows no changes right after apply (no perpetual diff)
