# AWS production implementation plan

Companion to `AWS-PRODUCTION-AUDIT.md` (findings F-01 to F-26). Decisions taken 2026-10-15: infra CI/CD stays in
`muhamedhalim/learnix-back`; a push to `main` deploys production behind the `production` environment reviewers; the
eu-west-1 backup-only copy is the single approved second-region use; DNS stays at Cloudflare.

Everything under "Done" is a source change, **uncommitted**, checked offline only. Nothing was applied to AWS, nothing
was pushed, and no production resource, database or credential was touched.

## Phase 0 and 1: done (source)

| ID         | Change                                                                                                                                                        | Files                                                                                                   | Verified by                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| F-01, F-02 | `ecs-deploy.sh` builds from the latest family revision; `--alarm-names` replaces `--alarm-prefix`; refuses to start on a firing alarm; one copy of the script | `learnix-infra/scripts/ecs-deploy.sh`, `tests/`, `.github/workflows/ci-cd.yml` (`scripts/aws/` removed) | 14 offline tests                                    |
| F-02       | `deploy_health_alarms` output, ELB 5xx alarm, canary alarm treats missing data as healthy while stopped                                                       | `modules/observability`, `modules/synthetics`, `environments/*/outputs.tf`, production tftest           | `terraform test`                                    |
| F-03       | Stop-gap guard on the legacy Bunny upload route; **superseded**: the route, the guard and Bunny itself are removed (see "Bunny retirement")                   | `src/lessons/controllers/teacher-lessons.controller.ts`                                                 | controller spec, `tsc`                              |
| F-05, F-07 | One root `terraform.yml` (static, plans, drift, dispatch apply); nested workflows deleted; plan-role trust narrowed                                           | `.github/workflows/terraform.yml`, `learnix-infra/bootstrap/main.tf`                                    | `actionlint`, `terraform validate`/`fmt`            |
| F-06       | `main` push -> production; `app_changed` skip; tree-match staging gate; migration base = push `before`                                                        | `.github/workflows/ci-cd.yml`                                                                           | `actionlint`; routing script run for 8 event shapes |
| F-08       | `dns_provider` (default `cloudflare`), `certificate_validated`, `cloudflare_dns_records` output; messaging records output                                     | `environments/production/{variables,edge,foundation,outputs}.tf`, `modules/messaging`                   | 3 new `terraform test` runs                         |
| F-09, F-10 | RDS `engine_version = "16"`; `PAYMOB_BASE_URL` in both stacks; payment vars in `.env.aws.example`                                                             | `modules/database`, `environments/*/apps.tf`, `.env.aws.example`                                        | tftest key assertions                               |
| F-11       | `@CronSingleRunner` on `reconcileGatewayAttempts`                                                                                                             | `payment-operations.service.ts`                                                                         | new spec (lock held -> job not run)                 |

## Phase 2: done (source)

| ID   | Change                                                                                                                                                               | Files                                                                        | Verified by                          |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------ |
| F-13 | SIGTERM: readiness `not_ready`, wait `SHUTDOWN_DELAY_MS` (10 s on AWS), `app.close()`, hard stop at `SHUTDOWN_TIMEOUT_MS` (40 s); total under the 60 s `stopTimeout` | `src/common/utils/graceful-shutdown.util.ts`, `main.ts`, `health.service.ts` | 5 unit tests, health specs           |
| F-14 | Worker container health check on the liveness path (not readiness, so a Redis blip cannot make ECS kill every worker)                                                | `modules/ecs-service`, `environments/*/apps.tf`                              | `terraform validate` and tests       |
| F-16 | `validateAwsRuntimeProfile`: provider enums, SQS URL shape, no R2 or Bunny storage keys in production unless `LEGACY_PROVIDERS_ALLOWED=true`                         | `src/config/env.validation.ts`                                               | 7 unit tests, existing config specs  |
| F-21 | Frontend CI no longer falls back to the Railway URL                                                                                                                  | `learnix-front/.github/workflows/ci.yml`                                     | none needed (build-time placeholder) |

Video configuration is deliberately **not** validated as all-or-none: Terraform sets the bucket, role and queue
variables before the CloudFront key is injected, and the feature is gated on all of them. Requiring them together
would stop staging from booting.

## Remaining work, in order

1. **Review, then commit** per repository (`learnix-back`, `learnix-front`). `learnix-front` also has pre-existing
   uncommitted CI hardening (permissions, concurrency, timeouts, pins), `eslint.config.mjs` and `test/setup.ts`.
2. **Run the remaining suites** before merging (the full unit suite passed: 375 suites, 3123 tests): `npm run build`,
   `npm run test:migrations`, `npm run test:e2e:ci -- --shard=i/4` (disposable Postgres 16 and Redis 7), and
   `docker build --platform linux/arm64 .` with a `--read-only` boot.
3. **GitHub settings** (owner, see `CI-CD-ARCHITECTURE.md` section 5): environments and reviewers, variables, branch
   protection. Set `DEPLOY_ALARMS` from `terraform output deploy_health_alarms`; `ALARM_PREFIX` is no longer read.
4. **Staging plan (read-only), review, then apply with approval.** Expected diff: bootstrap IAM trust of
   `learnix-gha-plan` and `learnix-gha-apply` (in place, no replacement), new ELB 5xx alarm, canary alarm
   `treat_missing_data` (production only), worker health check (when roles are split), `SHUTDOWN_DELAY_MS`,
   `PAYMOB_BASE_URL`, no change to the RDS instance. Reject the plan if anything is replaced or destroyed (conftest
   enforces this for protected types).
   `terraform -chdir=learnix-infra/environments/staging plan -var-file=terraform.tfvars` with the operator profile.
5. **Mandatory before the first production deploy:** F-04 operator check, and F-12 (non-master application database
   role; medium risk, grants only; staging first, needs approval).
6. **First deploy to staging through the pipeline**, then `scripts/smoke-test.sh <staging api>` from the allowlisted
   address, then watch `deploy_health_alarms` for an hour. This is the first real run of `control`, the arm64
   runner, `ecs-deploy.sh` against real ECS, and the tree-match gate.
7. **Production account and stack** (decision outside this plan): `terraform.yml` with `target=production`, all counts
   at 0 first. Cloudflare records from `terraform output cloudflare_dns_records`; CAA `0 issue "amazon.com"` if the
   zone has CAA records.
8. **Later, separate changes:** F-17 (documented), F-18/F-19 on measured triggers, F-22 ESLint baseline, F-23 read-only
   filesystem default, F-24 legacy removal after the parity window and `provider-audit.mjs --write-baseline`, F-26
   digest pin and Dependabot docker ecosystem, a report-only CSP on the Vercel responses, digest promotion between ECR
   repositories.

## Bunny retirement

Requirement (2026-10-15): no Bunny dependency, no Bunny-specific guard, no Bunny fallback or compatibility layer. Findings and
the full inventory: `AWS-PRODUCTION-AUDIT.md` section 8.

### Changes made (source, uncommitted)

| Area                             | Change                                                                                                                                                                                                                                        | Main files                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Backend, academic lessons        | Removed the Bunny service, TUS and proxied upload routes, upload-session saga and cron, the guard added in F-03; added `GET :id/video/status`, `DELETE :id/video` on the AWS service; `video_status` replaces `bunny_video_status` in the API | `src/lessons/**`, `src/video/aws-video.service.ts`                 |
| Backend, marketplace and preview | AWS-only upload, status, readiness, playback, review and preview; non-AWS references are "no video"                                                                                                                                           | `src/marketplace/**`, `src/packages/course-preview.service.ts`     |
| Backend, storage and config      | Bunny Storage provider and every `BUNNY_*` setting removed; `aws-video` health component                                                                                                                                                      | `src/storage/**`, `src/config/**`, `src/health/**`, `src/media/**` |
| Database                         | Migration `2206000000000-RetireBunnyVideo` (archive, rename, relax) with 4 unit tests                                                                                                                                                         | `src/migrations/2206000000000-RetireBunnyVideo.ts`                 |
| Frontend                         | AWS-only uploaders with an "unavailable" state, HLS-only player, `tus-js-client` removed, messages reworded, ported polling tests                                                                                                             | `app/[locale]/**`, `messages/**`, `package.json`                   |
| CI and audit                     | `BUNNY_STREAM_TOKEN_KEY` removed from the e2e job; provider baseline has no Bunny entry; the infra tree is excluded from the audit scan                                                                                                       | `.github/workflows/ci-cd.yml`, `learnix-infra/scripts/provider-*`  |
| Terraform                        | none needed: the media, CDN and secrets modules already provision the AWS path                                                                                                                                                                | `modules/media`, `modules/cdn`, `modules/secrets`                  |

Interface changes the two repositories must deploy together: lesson responses carry `video_status` (was
`bunny_video_status`); the academic preview `video` is only `{ platform: 'aws', lesson_id }`; the marketplace preview has no
`embed_url`; `POST lessons/:id/video-upload` and the three academic Bunny routes are gone. The frontend in this change set
already matches; an older frontend build against the new API would lose upload and show no video status.

### Gates before merging to `main`

1. **Staging video proof (blocking).** Generate the signing key pair (`openssl genrsa`, see `learnix-infra/docs/phase3-staging.md`),
   set `video_public_key_pem` and `inject_cloudfront_key` for staging, apply with approval, then: upload a small MP4 as a
   teacher, wait for `ready`, play it, and run
   `node learnix-infra/scripts/staging-acceptance.mjs https://<api> --frontend https://<vercel origin> --video-asset <asset id>`
   (the segment URL without cookies must answer 403). The `aws-video` health component must be `healthy`.
2. **Owner decision on Bunny content (blocking).** Confirm in writing that no Bunny-hosted video is needed, or export it. The
   migration refuses to run against a database that still has Bunny links until `ARCHIVE_LEGACY_BUNNY_VIDEOS=true` is set for
   that run; only set it after this decision.
3. Full suites green: unit, e2e shards, migration chain and rollback, frontend (below).
4. Deploy the backend and the frontend in the same window.

### Contract release (later, needs database-owner approval)

Drop `lessons.bunny_video_id`, `bunny_library_id`, `video_platform` (and `IDX_lessons_video_platform`), `video_url`, the
`lesson_video_upload_sessions` table; drop `legacy_bunny_video_references` after the Bunny account is closed. The migration
safety check will classify these as `NEEDS_DB_APPROVAL` / `BLOCKED`, which is intended. Close the Bunny library and storage
zone only after gate 2 and a 30-day quiet period; that is an owner action outside the repository.

### Acceptance criteria

| Criterion                                             | Evidence                                                                                                                                                                                                          |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No production feature depends on Bunny                | `grep -ri bunny` over source, tests, scripts, workflows, Terraform and env examples finds only history (migrations, banners, this retirement text); `provider-audit.mjs` OK with an empty `bunny-stream` baseline |
| No startup or deployment requires Bunny configuration | Unit and e2e suites run with no `BUNNY_*` variable; `validate:env` and the e2e job no longer set one                                                                                                              |
| No Bunny-specific guard or fallback remains           | The guard, service, routes, iframe fallback and storage provider are deleted                                                                                                                                      |
| All video features use AWS                            | Parity table in the audit; the ported polling tests; staging proof (gate 1)                                                                                                                                       |
| Existing assets stay reachable                        | Nothing deleted at Bunny; links archived, never discarded (gate 2)                                                                                                                                                |
| Terraform and CI/CD deploy the AWS path               | Unchanged and already in place; `deploy_health_alarms` and the pipeline are unaffected                                                                                                                            |

### Risks

| Risk                                                  | Mitigation                                                                                                           |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| A database with Bunny lessons is migrated by accident | Migration refuses without `ARCHIVE_LEGACY_BUNNY_VIDEOS=true`; links archived before clearing; `down()` restores them |
| New code against an old frontend (or the reverse)     | Deploy together; the interface changes are listed above                                                              |
| The AWS video path has never run live                 | Gate 1; until then video upload shows "unavailable" rather than failing mid-upload                                   |
| Published lessons that had a Bunny video lose it      | Only possible with the confirmation flag; documented in the migration and gate 2                                     |

## Verification matrix

| Area               | Command                                                                                                      | Gate                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| Terraform          | `terraform fmt -check -recursive learnix-infra`; `terraform validate`; `terraform test` in both environments | all pass (run: passed 2026-10-15)    |
| Terraform security | tflint and checkov (CI), conftest on every plan (CI)                                                         | 0 failed (not run locally)           |
| Deploy script      | `docker run ... alpine:3.20 ... bash /fake/ecs-deploy.test.sh` (see the header of the test)                  | 14 pass (run: passed)                |
| Workflows          | `docker run rhysd/actionlint@sha256:887a259a... ` over `.github/workflows`                                   | 0 findings (run: passed)             |
| Backend            | `npm run build`, `npm run test:cov -- --ci --runInBand`, `npm run test:migrations`, e2e shards               | unit passed; e2e, migrations not run |
| Image              | `docker build --platform linux/arm64 .`, boot with `--read-only`                                             | reaches readiness (not run)          |
| Live               | staging plan, pipeline deploy, `scripts/smoke-test.sh`, alarm states                                         | blocked: needs credentials           |

## Rollback

| Change              | Rollback                                                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Source changes      | Revert the commit; nothing else changed state                                                                                    |
| Application deploy  | `ci-cd.yml` `action=rollback` with the `previous-task-definitions` artifact (database changes are not reverted; expand/contract) |
| Terraform apply     | Revert the commit and apply again; state is versioned in S3; destroys of protected types are blocked by conftest                 |
| Trust policy change | Re-apply the previous `bootstrap/` revision with the operator profile (the apply role cannot edit `learnix-gha-*` roles)         |
| Shutdown delay      | Set `SHUTDOWN_DELAY_MS=0` (the old behaviour: close on signal)                                                                   |
