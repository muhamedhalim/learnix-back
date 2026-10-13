# AWS production readiness

**Scope (decided 2026-10-13): the frontend stays on Vercel, unchanged; AWS is the backend only.** Nothing here
claims anything about Vercel's own availability or configuration: no Vercel verification was performed.

**Verdict (2026-10-13): NOT production-ready.** The code, infrastructure and pipelines are complete and
pass every local check, but no AWS account exists, so none of the live tests that production readiness
requires has run. Do not launch until every row in §2 and §3 is closed with evidence.

Status legend:
* **Locally verified**: implemented and proven by a local test or tool run (commands and results in §5).
* **Awaiting AWS validation**: implemented; correctness depends on AWS behaviour that only a live test proves.
* **Awaiting approval**: needs a decision, document, payment or external action by you or a provider.
* **Incomplete**: not built yet.

## 1. Application readiness

| Item | Status | Evidence / note |
|---|---|---|
| Node 24 LTS, backend Dockerfile (api/worker/migrate one image), entrypoint composing DB/Redis URLs | Locally verified | Phase 1 clean-boot test; unit suite |
| `PROCESS_ROLE` split, cron single-runner advisory locks (hold window configurable for tests) | Locally verified | `cron-lock.util.spec.ts`, two-worker test (Phase 1), e2e |
| TLS to RDS (CA bundle in image) and Valkey, JSON logs, trust-proxy hops, keep-alive vs ALB | Locally verified (TLS against local CA) / Awaiting AWS validation (RDS CA, ElastiCache) | `tls-backends.spec.ts`, Phase 1 TLS run |
| S3 storage + presigned direct uploads (books, resources, video ≤ 20 GB) | Locally verified (MinIO + unit) / Awaiting AWS validation | `direct-uploads.s3.integration.spec.ts` |
| Video: MediaConvert job, EventBridge→SQS consumer, signed-cookie playback, hls.js player | Locally verified (unit, mocked AWS) / Awaiting AWS validation (job settings, playback) | `video.spec.ts`, `VideoPlayer.test.tsx` |
| Email: SES transport, local templates, bounce/complaint consumer | Locally verified / Awaiting AWS validation | `ses.spec.ts`, `mail.service.spec.ts` |
| SMS: End User Messaging sender, Egypt-only guard, delivery events → `parent_messages` (delivered/failed) | Locally verified / Awaiting approval (sender ID) / Awaiting AWS validation | `sms-sender.aws.spec.ts`, `sms-events.consumer.spec.ts` |
| Web Push (VAPID) end to end, SSRF allowlist | Locally verified / Awaiting AWS validation (real browsers) | `web-push.provider.spec.ts`, `push-client.webpush.test.ts` |
| Queue backlog metrics publisher (worker autoscaling input) | Locally verified (mocked CloudWatch) / Awaiting AWS validation | `queue-metrics.publisher.spec.ts` |
| Queue health / admin queue actions use the namespaced BullMQ prefix (bug fixed: staging read the wrong queues) | Locally verified | `queue-metrics.publisher.spec.ts` (`standaloneQueueOptions`) |
| Sentry steps aside when ADOT is active (no double tracer) | Locally verified | `sentry.spec.ts` |
| Prelaunch reset handles S3 object keys, S3-stored code exports (was a crash) and video assets | Locally verified | `prelaunch-reset.storage.spec.ts` |
| `DirectUpload` entity discoverable by the CLI data source and e2e schema (was breaking 84 e2e suites and the prelaunch reset) | Locally verified | `entity-location.spec.ts`, e2e run |
| Read-only root filesystem (api and worker: `/tmp` writable) | Locally verified (Docker `--read-only`: api migrates, boots, passes clean-boot 17/17) / Awaiting AWS validation (Fargate volumes) | On in staging by default; production after staging proves it. The web container (and its extra volumes) no longer exists |
| Task environment contains every variable production mode requires (bug fixed: `PAYMENT_CAPTURE_GRACE_SECONDS`, `PAYMENT_PROVIDER_CLOCK_SKEW_SECONDS`, `PAYMOB_EXPECTED_MODE=live` were missing, so the API would not have booted) | Locally verified | Contract assertion in both `plan.tftest.hcl`; found by booting the image in production mode |
| Image builds are immune to CRLF checkouts (entrypoint shebang broke a local Windows build) | Locally verified | Dockerfile strips CR; `.gitattributes` in all three repos |
| Migrate task network (bug fixed: production used public subnets without a public IP; output keys did not match `awsvpcConfiguration`) | Locally verified (plan assertion) | `task_network` output |
| CloudWatch RUM client (gated, lazy, no X-Ray header because the API is cross-origin) running in the Vercel-hosted app; Vercel Analytics unchanged | Locally verified / Awaiting AWS validation / Awaiting approval (Vercel variables) | `rum-config.test.ts`, frontend build |
| Frontend on Vercel, API on its own origin: credentialed CORS is an exact allowlist, `*.vercel.app` previews and foreign origins get no CORS headers, auth cookies are `HttpOnly; Secure; SameSite=None; Partitioned`, CSRF header allowed | Locally verified (real HTTP preflight and credentialed-call tests) / Awaiting AWS validation (real browsers against the real hosts) | `cors.util.spec.ts`, `cookie-security.util.spec.ts`, `public-url.util.spec.ts`; `staging-acceptance.mjs` runs the same checks against the deployed API |
| Playback across origins: `hls_url` is absolute on the API/CDN host, `VIDEO_PUBLIC_ORIGIN` defaults to `BACKEND_URL` (never the frontend), `/video/*` answers with an exact-origin credentialed CORS policy, hls.js sends credentials | Locally verified (unit; Terraform plan assertions) / Awaiting AWS validation (signed cookies and CORS on real CloudFront, Safari native HLS) | `video.spec.ts`, `video.config.spec.ts`, `VideoPlayer.test.tsx` |
| Marketplace sitemap used `NEXT_PUBLIC_API_URL` raw (missing `/api/v1` for a bare API origin): fixed with the shared normaliser | Locally verified | `sitemap.test.ts` |
| Firebase ID-token login path removal | Awaiting approval | Inert on AWS (no `FIREBASE_*`), plan decision 5 |

## 2. Infrastructure readiness

| Item | Status | Evidence / note |
|---|---|---|
| Org, SCPs, Identity Center, CloudTrail, GuardDuty, budgets (`org/`) | Locally verified (validate, checkov) / Awaiting AWS validation | Needs the management account |
| State bootstrap + GitHub OIDC (`bootstrap/`) | Locally verified / Awaiting AWS validation | — |
| Staging and production stacks, **backend only** (network, ECS api/worker/migrate, ALB, CloudFront+WAF for the API host, RDS, Valkey, S3, MediaConvert, SES, SMS, secrets). No frontend service, image repository, security group, ALB target, deploy role or `/_next` behaviour remains | Locally verified (validate, mocked plan tests 6/6 + 4/4 with assertions that no web repository/role exists and that origins/CORS are exact, tflint, checkov 0 failed) / Awaiting AWS validation | No real plan has run against AWS |
| API host DNS and certificate (`api.<domain>`: ACM in us-east-1, Route 53 alias; apex and www stay on Vercel records copied into the zone) | Locally verified (plan assertion) / Awaiting AWS validation / Awaiting approval (registrar NS change, DNS-host decision D1) | |
| Application Signals (ADOT init container + CloudWatch agent sidecar) | Locally verified (plan assertion: api task has 3 containers) / Awaiting AWS validation | Image tags pinned and confirmed to exist on ECR Public; needs `start-discovery` per account |
| Worker autoscaling on backlog per task (metric math) + CPU; no autoscaling before the first image | Locally verified (plan assertions) / Awaiting AWS validation | — |
| Alarms, anomaly detection, SMS/SES feedback metrics, saved queries, dashboard | Locally verified / Awaiting AWS validation | — |
| RUM app monitor + Cognito guest role | Locally verified / Awaiting AWS validation | — |
| Synthetics heartbeat canary (stopped until launch) | Locally verified (plan assertion) / Awaiting AWS validation | Runtime resolved at plan time (latest `syn-nodejs-puppeteer`) |
| AWS Backup (daily/monthly, deny-delete vault, eu-west-1 copy) + RDS cross-region automated backups | Locally verified / Awaiting AWS validation | — |
| App deploy roles (OIDC, repo + environment pinned, least privilege) | Locally verified / Awaiting AWS validation | checkov 0 failed (annotated skips) |
| Deploy/rollback automation (`ecs-deploy.sh`, `deploy-aws.yml`, `rollback-aws.yml` in both app repos) | Locally verified (11 scenarios against a fake AWS CLI) / Awaiting AWS validation | — |
| conftest policies on plans | Incomplete locally | Run only in `tf-apply-*` workflows; conftest/OPA not installed here |
| CloudFront flat-rate plan subscription | Awaiting approval | Console step; Terraform support unverified |

## 3. Live validations required before launch (all **Awaiting AWS validation**)

1. Staging acceptance (`scripts/staging-acceptance.mjs`) and every Phase 4 per-service test.
2. 150-migration chain on empty RDS; boot seeds; two workers run each cron once per tick.
3. 20 GB upload resumes after a browser restart; transcode; playback on Chrome/Safari/Firefox/Android/iOS;
   segment without cookies → 403.
4. SES: mailbox-simulator bounce/complaint processed; DKIM/SPF/DMARC pass. SMS: delivery on the four
   Egyptian carriers, a non-Egypt number blocked, receipts update `parent_messages`.
5. Read-only root filesystem: uploads, code exports, PDF/certificate generation work in staging.
6. Traces in X-Ray / Application Signals; RUM events; canary green; each alarm fires once in a test.
7. k6 FR-331 thresholds on production sizing; PITR drill RTO recorded; AWS Backup restore of one recovery point.
8. Production: `dns-diff` zero differences (apex and www still on Vercel), pinned pre-launch acceptance of the
   API host, Vercel production variables switched and redeployed, login/CSRF/refresh on the live site, live
   low-value Paymob payment and refund, 48 h hypercare.
9. Cross-origin behaviour in real browsers (Chrome, Safari, Firefox, Android, iOS): auth cookies, CSRF, uploads
   to S3 from the Vercel origin, HLS with signed cookies, and the Vercel server-side calls through the WAF.

## 4. Approvals and external actions (all **Awaiting approval**)

SES production access; Egypt sender ID + protect configuration + SMS spend limit; CloudFront Business plan;
budget ceiling and Support plan; Name.com NS change; Paymob/Meta/OAuth callback URLs; legal checks (PDPL
cross-border hosting, minors' data, Paymob SAQ type); Firebase login-path removal; video ladder and source
retention; GuardDuty Malware Protection for S3; 1 vs 2 NAT; vendor decommissions (Phase 8).

## 5. Local verification run (2026-10-13)

| Command | Result |
|---|---|
| `npx jest --ci` (learnix-back, baseline at HEAD `a737a67`) | 367 suites / 3,072 tests passed, 1 suite skipped |
| `npx jest --ci` (learnix-back, after the Vercel change) | 371 suites / 3,109 tests passed, 1 suite and 7 tests skipped |
| `npm run test:e2e` (learnix-back, baseline at HEAD) | 84 of 91 suites failed: `relation "direct_uploads" does not exist` (entity outside `entities/`), then the in-band process ran out of heap |
| `npm run test:e2e -- --ci` (after the earlier fixes) | 91/91 suites, 728/728 tests passed |
| `npm run test:e2e -- --ci` (after the Vercel change, 2026-10-13) | 90/91 suites, 727/728 tests: `quiz-analytics-parity` statement count 15 vs 7; re-run alone 3/3 passed (suspected minute-boundary background statements, not proven) |
| `npx tsc --noEmit -p tsconfig.build.json` (learnix-back) | passed |
| `npx eslint .` (learnix-back) | passed, but the config enables no rules (open item) |
| `npx tsc --noEmit`, `npx vitest run`, `npm run build` (learnix-front, after removing the web container and Dockerfile) | clean; 163 files / 779 tests passed; build succeeded (with `NEXT_PUBLIC_API_URL=https://api.example.test`) |
| `docker build` + `docker run --read-only` (api; web image no longer exists) | earlier run: api 150 migrations, readiness 200, clean-boot 17/17. Not repeated after this change (the backend Dockerfile is untouched) |
| `terraform fmt -check`, `validate`, `test` (staging, production) | valid; 6/6 and 4/4 runs passed (new assertions: exact CORS origins, no web repository or deploy role, API host names, rejected wildcard/preview origins) |
| `tflint` (staging, production and every module) | no findings |
| `checkov` (staging, production) | 608 / 718 passed, 0 failed (bootstrap and org unchanged, not re-run) |
| `scripts/tests/ecs-deploy.test.sh` (fake AWS CLI in Alpine) | 11/11 scenarios passed |
| `node scripts/provider-audit.mjs` | OK: 67 reviewed legacy references (Vercel removed from the audit: it stays); AWS configuration selects no legacy provider |
| New backend tests | `cors.util.spec.ts` (real HTTP preflight and credentialed call, six refused origins), `video.config.spec.ts`; `video.spec.ts` updated for the absolute playback URL |
| New frontend test | `sitemap.test.ts` (bare API origin resolves to `/api/v1`) |
