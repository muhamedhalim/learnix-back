# AWS production audit

Date: 2026-10-15. Scope: `learnix-back` (NestJS API, `learnix-infra/` Terraform, `.github/workflows`) and
`learnix-front` (Next.js, deployed on Vercel). Companion documents: `AWS-PRODUCTION-IMPLEMENTATION-PLAN.md`
(what was changed and what remains), `CI-CD-ARCHITECTURE.md` (pipelines and GitHub settings) and
`../learnix-infra/AWS-OPEN-ITEMS.md` (external actions).

**Verdict: not production-ready.** Staging is applied and serving. Production has no account, no state and has never
been planned or applied. Nothing in this audit was verified against live AWS or GitHub: there were no AWS credentials,
no `gh` CLI, and the repositories are private. Every statement about live state is marked _unverified_.

## 1. Evidence and its limits

| Check (2026-10-15)                                                           | Result                                                                                                                                            |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `terraform fmt -check -recursive` before changes                             | **Failed**: `bootstrap/main.tf` (BOM, mis-indented block). Fixed                                                                                  |
| `terraform validate` (bootstrap, org, staging, production)                   | Passed                                                                                                                                            |
| `terraform test` (mocked providers)                                          | Passed: staging 6, production 7 (3 new). Mocks cannot find API-side errors                                                                        |
| `ecs-deploy.sh` offline tests                                                | 14 passed (4 new)                                                                                                                                 |
| `actionlint` (pinned image) over all workflows                               | 0 findings                                                                                                                                        |
| Backend `tsc --noEmit` and the full unit suite (`test:cov --ci --runInBand`) | Passed: 375 suites passed, 1 skipped; 3123 tests passed, 7 skipped. E2E, migration-chain and the container build were **not** re-run this session |
| tflint, checkov, conftest, trivy                                             | **Not run** (not installed here); they run in CI                                                                                                  |
| AWS read-only inspection, `terraform plan` against real state                | **Blocked** (no credentials; the AWS MCP server failed to connect)                                                                                |
| GitHub run history, environments, variables, branch protection               | **Blocked**                                                                                                                                       |

## 2. Architecture and deployment inventory

| Component                                                       | Source                              | Runtime                 | Production location                                   | Deployment                     | Health verification                               | Status                          |
| --------------------------------------------------------------- | ----------------------------------- | ----------------------- | ----------------------------------------------------- | ------------------------------ | ------------------------------------------------- | ------------------------------- |
| HTTP API                                                        | `src/main.ts`, `PROCESS_ROLE=api`   | Fargate ARM64, Node 24  | eu-central-1: ECS `api`, internal ALB, CloudFront     | `ci-cd.yml` -> `ecs-deploy.sh` | ALB `/api/v1/health`; readiness checks DB + Redis | Staging live; production absent |
| Worker (14 BullMQ processors, 15 crons, 3 SQS pollers, metrics) | same image, `PROCESS_ROLE=worker`   | Fargate                 | ECS `worker` (production); folded into api on staging | same                           | Container health check (new, liveness)            | Not live                        |
| Migrations (150, advisory lock)                                 | `src/database/migrate-cli.ts`       | one-shot Fargate task   | task definition `*-migrate`                           | `ecs-deploy.sh` step 2, exit 0 | exit code                                         | Works on staging                |
| Frontend                                                        | `learnix-front`                     | **Vercel**              | Vercel (documented exception)                         | Vercel Git integration         | none in this repo                                 | Live on Vercel                  |
| Database                                                        | TypeORM                             | RDS PostgreSQL 16       | eu-central-1                                          | Terraform                      | readiness                                         | Staging live                    |
| Cache and queues                                                | Redis, BullMQ                       | ElastiCache Valkey 8    | eu-central-1                                          | Terraform                      | readiness                                         | Staging live                    |
| Files                                                           | `StorageService`                    | S3 (R2/Bunny fallbacks) | eu-central-1                                          | Terraform                      | admin health                                      | Live; legacy still selectable   |
| Video                                                           | MediaConvert, CloudFront cookies    | AWS                     | eu-central-1 + CloudFront                             | Terraform                      | none                                              | Unproven (no key pair injected) |
| Mail, SMS, push, WhatsApp                                       | SES, AWS SMS, Web Push, Meta        | AWS and Meta            | eu-central-1                                          | Terraform                      | SQS event consumers                               | SES sandbox; sender ID pending  |
| Payments                                                        | Paymob (`/api/v1/payments/webhook`) | external                | Paymob                                                | n/a                            | n/a                                               | Needs `PAYMOB_BASE_URL` (fixed) |
| Edge                                                            | CloudFront, WAF                     | global / us-east-1      | AWS-defined                                           | Terraform                      | canary (production, off)                          | Staging live                    |
| Backups                                                         | RDS PITR, AWS Backup                | AWS                     | eu-central-1 + eu-west-1 copy                         | Terraform                      | `pitr-restore-drill.sh`                           | Production only; never drilled  |

Referenced by code but absent from deployment: none found. Present but unused: the `image-processing` and
`file-cleanup` queues (registered, no producer or consumer). Legacy providers still selectable in code: R2, Bunny
Storage and Stream, MailerSend, Twilio, Firebase, Railway labels (`environment-isolation.guard.ts`). They are rollback
paths until the 30-day parity window ends; the production boot profile now refuses to start with R2 or Bunny storage
keys set (`validateAwsRuntimeProfile`).

## 3. Findings

Classes: CD confirmed defect, MC missing capability, SEC security, REL reliability, CFG configuration, DOC documentation,
UNV unverified. Status is as of this change set, uncommitted.

| ID   | P   | Class    | Finding and evidence                                                                                                                                                                | Status                                                                  |
| ---- | --- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| F-01 | P0  | CD       | Terraform task-definition changes never reach running services: `ecs-service/main.tf` ignores `task_definition` and `ecs-deploy.sh` re-registered the service's _current_ revision  | Fixed (builds from latest revision)                                     |
| F-02 | P0  | CD       | Post-deploy check rolled back on any alarm with the prefix, including the canary alarm (missing data = breaching, canary off by default)                                            | Fixed (named alarms, pre-check, canary)                                 |
| F-03 | P0  | SEC, REL | Legacy Bunny upload buffers up to 20 GB in task memory with no request timeout (`teacher-lessons.controller.ts`, `FILE_LIMITS.VIDEO_MAX_SIZE`) while Bunny is not configured on AWS | Fixed first by a guard, then by removing the route (section 8)          |
| F-04 | P0  | UNV, REL | RDS-managed master password rotates (default 7 days) while ECS injects `DB_PASSWORD` only at task start; the app connects as master                                                 | Open: operator check; F-12 removes the cause                            |
| F-05 | P0  | CD       | No Terraform workflow could run: they lived in `learnix-infra/.github/`, which GitHub ignores; paths and the conftest mount were wrong                                              | Fixed (`terraform.yml`)                                                 |
| F-06 | P1  | MC       | A push to `main` did not deploy production; the production gate matched the staging run by commit SHA, which a merge commit never shares                                            | Fixed (tree match, approval gate)                                       |
| F-07 | P1  | SEC      | The plan role trusted pull requests in every account                                                                                                                                | Fixed in code; needs a staging apply                                    |
| F-08 | P1  | CFG      | Terraform created a Route 53 zone although DNS stays at Cloudflare (apex and www are proxied to Vercel there)                                                                       | Fixed (`dns_provider`, default cloudflare)                              |
| F-09 | P1  | CD       | `engine_version = "16.9"` with `auto_minor_version_upgrade = true` plans a downgrade after AWS upgrades the minor                                                                   | Fixed (major only); verify with a plan                                  |
| F-10 | P1  | CFG      | `PAYMOB_BASE_URL` has no backend default and Terraform did not set it, so checkout could not start; `.env.aws.example` lacked two required payment variables                        | Fixed                                                                   |
| F-11 | P1  | REL      | `reconcileGatewayAttempts` (every 30 min, transitions payments) had no cluster lock                                                                                                 | Fixed                                                                   |
| F-12 | P2  | SEC, REL | Application connects as the RDS master user                                                                                                                                         | Fixed in code; needs a staging apply, then a deploy                     |
| F-13 | P2  | REL      | No shutdown drain: closed on SIGTERM immediately, readiness unaffected                                                                                                              | Fixed (`graceful-shutdown.util.ts`)                                     |
| F-14 | P2  | REL      | Worker has no health check of any kind                                                                                                                                              | Fixed (liveness container check)                                        |
| F-15 | P2  | SEC      | Apply role is `AdministratorAccess` under a permission boundary                                                                                                                     | Accepted risk, documented                                               |
| F-16 | P2  | CFG      | AWS runtime variables are read ad hoc; typos silently disable features or fall back to legacy providers                                                                             | Fixed (`validateAwsRuntimeProfile`)                                     |
| F-17 | P2  | CD       | Staging `api_desired_count` is ignored after creation (`ignore_changes`, no autoscaling)                                                                                            | Fixed (scalable target pinned to the desired count)                     |
| F-18 | P2  | REL      | Production: one NAT gateway, no interface endpoints (ECR, Logs, Secrets, STS)                                                                                                       | Accepted for launch; trigger documented                                 |
| F-19 | P2  | SEC      | CloudFront to ALB is plain HTTP inside the VPC (no `certificate_arn`)                                                                                                               | Accepted; Stage 2                                                       |
| F-20 | P2  | REL      | No alarm on ALB-generated 5xx; alerts reach nobody until `alert_emails` is set and subscriptions are confirmed                                                                      | ELB 5xx alarm added; email is external                                  |
| F-21 | P2  | CFG      | Frontend CI fell back to the retired Railway URL; no CSP; dependency audit never fails                                                                                              | Fallback fixed; CSP and audit open                                      |
| F-22 | P2  | DOC      | Backend ESLint enforces nothing (135 errors under a recommended baseline)                                                                                                           | Fixed (recommended baseline enforced; strict config remains the target) |
| F-23 | P3  | REL      | Production `read_only_root_filesystem` defaults to false while staging runs with true                                                                                               | Fixed (production default true)                                         |
| F-24 | P3  | DOC      | Legacy provider code, Railway files, dead queues, two staging API host names in `next.config.ts`                                                                                    | Open: Phase 8 approval                                                  |
| F-25 | P3  | DOC      | Overlapping, stale documentation                                                                                                                                                    | Partly fixed                                                            |
| F-26 | P3  | SEC      | Base image not pinned by digest; Dependabot has no docker ecosystem                                                                                                                 | Fixed (digest pin; Dependabot docker)                                   |

Defects found after the first read of the evidence and fixed because they would have broken the new pipeline:
the conftest mount in the apply workflows pointed at the wrong directory; `bootstrap/main.tf` failed `terraform fmt`;
`ci-cd.yml` and the Terraform workflows used mutable action tags.

### Open item notes

- **F-04.** Verify read-only: `aws secretsmanager describe-secret --secret-id <rds master secret ARN>` and read
  `RotationEnabled` and `NextRotationDate`. If a rotation has happened, force a new deployment of each service. The
  permanent fix is F-12: a non-master application role whose password is a Terraform-created, non-rotating secret.
- **F-12.** The migrate task (master credentials) creates the `learnix_app` role after the migrations, sets its password
  from the Terraform-created secret `<prefix>/db-app` and grants DML on every table and sequence, now and by default
  for later ones. api and worker read `DB_USER` / `DB_PASSWORD` from that secret and cannot run DDL. Order on a live
  environment: apply Terraform (creates the secret and new task definition revisions), then deploy; the pipeline runs
  migrate before it updates the services, so the role exists before any task uses it. Rotate with `db_app_version`:
  apply, then deploy. Verified against a real PostgreSQL 16 with a non-superuser owner: DML allowed, later tables
  covered, a changed password synced, `CREATE`/`DROP`/`ALTER TABLE` denied.
- **F-17.** A scalable target now exists whenever a service runs. Without a min..max range it is pinned to
  `desired_count`, so editing `api_desired_count` in tfvars and applying takes effect. CPU tracking still attaches only
  when `max_count > min_count`.
- **F-18.** Add a second NAT (about USD 35/month plus data) when losing one AZ's egress is unacceptable, and the
  ECR, Logs, Secrets Manager and STS interface endpoints (about USD 7/month each per AZ) when NAT data charges exceed
  that. Both need a measured baseline from the first production month.

## 4. Regional consistency

Everything is eu-central-1 by default (`variables.tf` of every root). Exceptions, all justified:

| Region    | Use                                                                                             | Basis                                       |
| --------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------- |
| us-east-1 | CloudFront ACM certificate, CLOUDFRONT-scope WAF, WAF log group and key                         | AWS requires it for these global services   |
| eu-west-1 | Copy of RDS automated backups and of AWS Backup recovery points (DR KMS key, vault); no compute | Approved 2026-10-15 as the one DR exception |

The organization SCP region allow-list matches these three regions. No other region appears in Terraform, workflows
or scripts.

## 5. Security notes

- GitHub OIDC only; no long-lived AWS keys anywhere. Deploy role subject is pinned to
  `repo:muhamedhalim/learnix-back:environment:<env>`, the apply role to `environment:infra-<env>`, the plan role to
  `main` (plus pull requests in the staging account only).
- All third-party actions are pinned to commit SHAs. `actions/*` pins resolve the `v4` tag on 2026-10-15.
- No ingress from 0.0.0.0/0 exists: the ALB is internal and accepts only the CloudFront VPC-origin group; RDS and
  Valkey accept only the task group. Secrets never enter state (ephemeral values and write-only arguments).
- Unverified: whether the plan role's `ReadOnlyAccess` can refresh the write-only secret versions; whether the WAF
  blocks a non-allowlisted address on staging (never tested).

## 6. Cost

| Change                              | Class      | Note                                           |
| ----------------------------------- | ---------- | ---------------------------------------------- |
| F-01 to F-17 except as listed below | none       | Code and configuration only                    |
| ELB 5xx alarm                       | negligible | About USD 0.10 per alarm per month             |
| DR backup copy (kept)               | low        | Snapshot storage in eu-west-1 plus one KMS key |
| Route 53 zone no longer created     | negligible | About USD 0.50 per month saved                 |
| F-18 second NAT / endpoints         | low-medium | Not enabled; trigger documented                |

No saving is claimed beyond these: there is no measured baseline yet (see `learnix-infra/AWS-COST-ESTIMATE.md`).

## 7. Unverified assumptions

Everything that needs a credential: live resource state and drift; that staging's bootstrap trust still names the
repository it was applied with (plan before applying the trust change); GitHub environments, variables, reviewers and
branch protection; `ubuntu-24.04-arm` runner availability for a private repository; Dependabot enablement; Railway's
GitHub integration still building `main`; the RDS rotation state; SNS email confirmation; WAF blocking; MediaConvert and
signed-cookie playback; the first real production `terraform plan`.

## 8. Bunny retirement (requirement added 2026-10-15)

Bunny is not an approved production dependency. This section records every reference found, what it did, its AWS
replacement, and what is still open. The change set is **uncommitted source**: nothing was applied to AWS, nothing was
deleted at Bunny, and the Bunny account was not touched.

### 8.1 What `bunny-configured.guard` was

It did not exist in the repository before this audit. It was added earlier in this audit (finding F-03) as a stop-gap:
a Nest guard on `POST teacher/lessons/:id/video` that answered 503 before multer could buffer a 20 GB body when Bunny
was not configured. It protected that single legacy route and nothing else, and no AWS code path ever used it. Because the
route itself is now removed, the guard, its spec and the `src/lessons/guards/` directory are deleted. Nothing replaces it
at the route; the behaviour that mattered (do not accept an unusable upload) is now structural, because the only upload
routes left are the presigned direct-to-S3 ones, which never pass the file through the API.

What actually blocked behaviour when Bunny was missing, before this change: `BunnyStreamService.assertConfigured()` threw
503 on every create/upload/delete, `CourseReadinessService` treated Bunny-hosted videos as ready when Bunny was
unconfigured, and the player and preview paths fell back to a Bunny signed embed URL.

### 8.2 Inventory and replacement

| Area                                  | Bunny dependency (files)                                                                                                                                                                                                                                                                                                                                                   | AWS replacement already in the code                                                                                                                                            | Result                                                                                             |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Academic lesson upload                | `bunny-stream.service.ts`; `lessons.service.ts` (TUS session create/complete, backend-proxied upload, status polling, expired-session cleanup cron); `teacher-lessons.controller.ts` routes `video/upload-session`, `video/upload-session/:id/complete`, `POST :id/video`, `DELETE :id/video/bunny`; `lesson-video-upload-session.entity.ts`; `create-bunny-upload.dto.ts` | `LessonAwsVideoService` and `AwsVideoService`: presigned multipart to S3, MediaConvert HLS ladder and poster, EventBridge/SQS completion, reconcile cron; routes `video/aws/*` | Removed. New `GET :id/video/status` and `DELETE :id/video` use the AWS service                     |
| Academic playback                     | `lessons.service.ts#getSignedPlaybackUrl` signed Bunny embed fallback                                                                                                                                                                                                                                                                                                      | CloudFront signed cookies + HLS URL (`LessonAwsVideoService.playback`)                                                                                                         | Fallback removed; no ready AWS video answers 400                                                   |
| Free preview (academic)               | `course-preview.service.ts` signed embed (`signable_video_id`)                                                                                                                                                                                                                                                                                                             | `{ platform: 'aws', lesson_id }` + `GET /packages/:id/preview/lessons/:id/playback`                                                                                            | Removed; the cached shape no longer holds a provider id                                            |
| Marketplace upload, status, readiness | `lesson-video.service.ts` (TUS authorization, `getVideo`), `instructor-curriculum.controller.ts` `POST lessons/:id/video-upload`, `course-readiness.service.ts`                                                                                                                                                                                                            | `startAwsUpload`, `completeAwsUpload`, `getStatus`; readiness requires a ready AWS asset                                                                                       | Removed; a non-AWS `video_id` is "no video" (not ready)                                            |
| Marketplace playback and review       | `player.service.ts`, `preview-access.service.ts`, `admin-courses.controller.ts`                                                                                                                                                                                                                                                                                            | `AwsVideoService.grantPlayback`                                                                                                                                                | Removed; a non-AWS reference answers 404                                                           |
| Bunny Storage (files)                 | `storage.service.ts` provider, `BUNNY_STORAGE_*`, `BUNNY_CDN_URL`, `media.service.ts` host list, `public-url.util.ts`, `storage.indicator.ts`                                                                                                                                                                                                                              | S3 (`S3_BUCKET`, task role); R2 remains a separate, still-selectable legacy provider                                                                                           | Removed                                                                                            |
| Configuration                         | `env.validation.ts` (`BUNNY_STREAM_*`, `BUNNY_API_KEY`), `environment-isolation.guard.ts` (3 secret keys, 2 identifier rules), `feature-flags.ts` text, `fingerprint-secrets.ts`, `prelaunch-reset.ts` (`BUNNY_CLEANUP_STATUS`), `seed-staging.ts` comment, `.env.example`, `.env.aws.example`, `ci-cd.yml` (`BUNNY_STREAM_TOKEN_KEY` in the e2e job)                      | `VIDEO_*`, `MEDIACONVERT_ROLE_ARN`, `CLOUDFRONT_*`, `MEDIA_EVENTS_QUEUE_URL` (already in Terraform)                                                                            | Removed; `.env.example` now documents the AWS variables                                            |
| Health                                | `external-providers.indicator.ts` live probe of the Bunny API; ids in `health-orchestrator`, `health-risk`, admin panel                                                                                                                                                                                                                                                    | Component `aws-video`: reports which video settings are missing, by name, without an AWS call                                                                                  | Replaced                                                                                           |
| Frontend                              | `lib/bunny.ts`, `utils/video.ts` (intro embed), `useBunnyVideo.ts` (+test), `useMarketplaceVideoUpload.ts` (TUS), `tus-js-client`, `VideoPlayer` iframe fallback, endpoints, types, `bunny_video_status`, 8 message strings, `NEXT_PUBLIC_BUNNY_LIBRARY_ID`                                                                                                                | `useAwsVideoUpload.ts`, `lib/signed-url.ts`, HLS-only `VideoPlayer`                                                                                                            | Removed; the AWS tests were ported from the Bunny ones (status polling lifecycle)                  |
| Terraform, GitHub Actions             | none ever provisioned or set Bunny; `provider-audit.mjs` forbade `BUNNY_*` in AWS config                                                                                                                                                                                                                                                                                   | n/a                                                                                                                                                                            | `provider-baseline.json` now has **no** `bunny-stream` entry, so any new reference fails the audit |

### 8.3 Data

- Production assets. Railway production has been down since 2026-08-13 and, by the owner's decision, nothing is migrated
  from it (fresh start). There is no AWS production database yet; the live staging stack has no Bunny configuration and
  `seed-staging.ts` attaches no video. So no feature served from AWS depends on a Bunny asset, and no AWS environment loses
  a playable video through this change. Whether the Bunny library holds videos worth keeping is **not verifiable from the
  repository**: it is an owner decision recorded as a gate (plan, "Bunny retirement").
- Database. Migration `2206000000000-RetireBunnyVideo` is the "migrate" step. It refuses to run while any lesson still points
  at a Bunny video unless `ARCHIVE_LEGACY_BUNNY_VIDEOS=true`; it then copies the links to `legacy_bunny_video_references`
  and clears them (those lessons have no video until the teacher uploads again), renames `lessons.bunny_video_status` to
  `video_status`, and makes `lessons.video_platform` optional with no default. Verified on a scratch PostgreSQL 16 with
  seeded legacy rows: refusal without the flag, archive and clear with it, AWS-hosted rows untouched, new lessons insert,
  `down()` restores the links. Nothing is dropped in this release: the repository's migration policy (expand, migrate,
  contract) classifies a same-release `DROP TABLE` as blocked.
- Assets at Bunny. Never touched. Nothing here deletes or disables a Bunny library or storage zone.

### 8.4 Is the AWS replacement proven?

| Evidence                                                                                                                                                                                                                    | Result                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Code parity for every surface above (upload, status, delete, playback, free preview, review, readiness, poster)                                                                                                             | Confirmed by reading the AWS services and their routes                                                                                                                                                                               |
| Unit tests (`video.spec.ts`, `lesson-video.service.spec.ts`, `player.service.spec.ts`, `course-readiness.service.spec.ts`, `course-preview.service.spec.ts`, `lessons.service.spec.ts`) and the preview/security e2e suites | Passed, now without any Bunny variable                                                                                                                                                                                               |
| Migration chain on an empty database (151 migrations) and rollback test                                                                                                                                                     | Passed                                                                                                                                                                                                                               |
| Live: S3 upload, MediaConvert job, CloudFront signed-cookie playback on staging                                                                                                                                             | **Not proven.** Staging has no CloudFront signing key injected (`inject_cloudfront_key` false), so the `aws-video` health component reports `misconfigured` there. This is the gate for merging to `main` (plan, "Bunny retirement") |

### 8.5 Remaining references, classified

| Reference                                                                                                                 | Class                     | Justification                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------- |
| Migrations before `2206000000000` (`AddBunnyStreamVideoMetadata`, `MigrateToBunnyNet`, ...)                               | History                   | Applied migrations are immutable                                                                   |
| Columns `lessons.bunny_video_id`, `bunny_library_id`, `video_platform`, `video_url`; table `lesson_video_upload_sessions` | Temporary, unused by code | Contract step in a later release with database-owner approval                                      |
| Table `legacy_bunny_video_references`                                                                                     | Evidence                  | Needed to re-find an asset if the owner wants one migrated; drop after the Bunny account is closed |
| `marketplace_courses.promo_video_id`                                                                                      | Not a Bunny dependency    | A free-text id nothing plays; its hint text no longer names Bunny                                  |
| Docs in `docs/` that predate AWS                                                                                          | History                   | Carry a "superseded" banner                                                                        |
| The word "Bunny" in this audit, the plan, the migration and `provider-audit.mjs`                                          | Describes the retirement  | Intended                                                                                           |
