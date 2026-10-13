# AWS service decisions and external-provider audit

Decision record for every external provider found in `learnix-back` and `learnix-front` (audit of
2026-10-13: dependencies, SDK imports, hard-coded hosts, environment variables, webhooks, deploy
configuration). Architecture overview: [AWS-ARCHITECTURE.md](AWS-ARCHITECTURE.md).

**Frontend hosting (decision of 2026-10-13): Vercel stays.** The Next.js frontend is not migrated; AWS hosts the
backend only. This supersedes the earlier ECS `web` plan; the Terraform for it was removed.

Status legend: **Replaced** (AWS implementation in code, selected by the AWS configuration, unit/e2e
tested locally; live behaviour awaits AWS) · **Retained (external)** (no safe AWS equivalent) ·
**Rollback only** (legacy code kept behind a switch until Phase 8, never selected on AWS).

## 1. Replaced providers

| Provider (how it was used) | AWS replacement | Code switch on AWS | Legacy code status |
|---|---|---|---|
| **Railway** (API, Postgres, Redis; Nixpacks build, auto-deploy, `RAILWAY_*` release IDs) | ECS Fargate (`api`, `worker`, `migrate`), RDS PG16, ElastiCache Valkey, ECR; `deploy-aws.yml` | `PROCESS_ROLE`, `DB_*`/`REDIS_*` composed by the entrypoint, `GIT_SHA` | Railway workflows are manual-only; the GitHub-artifact `pg_dump` (PII) is removed. `railway.json`, `nixpacks.toml`, `RAILWAY_*` release fallbacks remain until Phase 8 |
| **Cloudflare DNS / proxy** | Route 53 zone (copy of every record, apex/www still pointing at Vercel) + CloudFront + WAF + ACM for `api.<domain>` only | Terraform `dns_records`, `certificate_enabled` | Zone kept 30 days after the NS change. See the DNS decision in section 3 |
| **Cloudflare R2** (single private bucket, hard-coded R2 endpoint) | S3 `app-files` with presigned direct uploads | `S3_BUCKET` (task role credentials) | R2 provider branch, `R2_*` validation, two R2 migration scripts remain until Phase 8 |
| **Bunny Stream** (create/upload/TUS, status polling, signed iframe embed, thumbnails) | S3 multipart → MediaConvert (HLS) → CloudFront signed cookies, hls.js player | `VIDEO_SOURCE_BUCKET` etc.; frontend chooses S3 upload by server capability | Bunny service, `tus-js-client`, legacy embed branch in `VideoPlayer` remain until Phase 8 |
| **MailerSend** (remote templates, raw sends) | SES + local bilingual templates, bounce/complaint SQS consumer | `MAIL_PROVIDER=ses` | MailerSend transport is the `MAIL_PROVIDER=mailersend` rollback |
| **Twilio** (Egypt SMS: guardian OTP, fallback after WhatsApp) | AWS End User Messaging SMS with Egypt sender ID, protect configuration, delivery events | `SMS_PROVIDER=aws`, `SMS_AWS_ORIGINATION_IDENTITY` | Twilio is the `SMS_PROVIDER=twilio` rollback until the sender ID is live |
| **Firebase** (FCM web push; unused ID-token login path) | Standard Web Push (VAPID) from the worker | `PUSH_PROVIDER=webpush` (frontend follows the server) | FCM provider + SDKs remain as rollback; the ID-token login branch is inert without `FIREBASE_*` and awaits approval for deletion |
| **Sentry** (errors, traces, source maps, both repos) | CloudWatch Logs/metric filters/alarms/anomaly detection, Application Signals + X-Ray (ADOT), RUM, Synthetics, saved Logs Insights queries | Sentry runs only with `SENTRY_DSN` (not set on AWS); with ADOT active it never registers a second tracer | Removed after the 30-day parity window (Phase 8) |

Vercel is **not** a legacy provider any more (see section 2) and is no longer part of this audit. The AWS configuration selects none of the legacy providers. `scripts/provider-audit.mjs` enforces it:
it fails if Terraform or an AWS deploy workflow sets any `R2_*`, `BUNNY_*`, `MAILERSEND_*`, `TWILIO_*`,
`FIREBASE_*`, `SENTRY_*` or `RAILWAY_*` variable or a legacy provider value. It also fails on any legacy
SDK import or host outside the reviewed baseline of reviewed rollback references (`scripts/provider-baseline.json`).

## 2. Retained external dependencies

### Paymob (payments): explicitly audited, retained

What Learnix does with Paymob (code: `src/payments/providers/paymob/*`, `src/payments/controllers/payments-webhook.controller.ts`,
`src/marketplace/commerce/controllers/marketplace-webhook.controller.ts`):

* Checkout: server creates the Paymob order/intent and redirects the browser to the **Paymob-hosted**
  payment page. Card data never touches Learnix (SAQ-A-shaped scope; to be confirmed with Paymob).
* Webhooks (HMAC-verified, amount/currency checked, idempotent): `POST /api/v1/payments/webhook`,
  `POST /api/v1/payments/webhook/callback`, `POST /api/v1/marketplace/webhooks/payment`.
* Reconciliation crons (order and transaction inquiry) and refunds via the Paymob API, from the worker,
  under the cron single-runner lock.
* Manual InstaPay/wallet proofs: stored privately in S3 (AWS).
* Configuration: `PAYMOB_API_KEY`, `PAYMOB_SECRET_KEY`, `PAYMOB_WEBHOOK_SECRET` (secrets),
  `PAYMOB_BASE_URL`, `PAYMOB_CARD_INTEGRATION_ID`, `PAYMOB_IFRAME_ID`, `PAYMOB_ALLOWED_HOSTS`,
  `PAYMOB_EXPECTED_MODE` (`live` is enforced in production, `test` on staging).

Why it cannot be replaced with AWS: AWS has no payment gateway, acquiring or settlement service. Taking
card payments without a processor would require Learnix to become PCI DSS Level-1 scoped and contract an
acquirer directly; local wallets and InstaPay also require a licensed Egyptian processor. **Learnix is
therefore not an AWS-only system.** The AWS side keeps Paymob safe: secrets in Secrets Manager, static NAT
egress IP, webhooks not blocked by the WAF bot rules, and a provider-outage runbook entry.

### Others

| Provider | Used for | Why retained | AWS-side controls |
|---|---|---|---|
| Meta WhatsApp Cloud API | Guardian template messages, HMAC status webhook (`/api/v1/webhooks/whatsapp`) | Meta owns the channel; End User Messaging Social would still route through Meta | `META_WHATSAPP_*` in Secrets Manager; delivery statuses update `parent_messages` |
| Zoom / Google Meet / Microsoft Teams | Per-teacher OAuth meeting accounts | Meetings live on those platforms | `ZOOM_*`, `GOOGLE_MEET_*`, `MS_TEAMS_*` secrets; tokens encrypted with an escrowed key |
| **Vercel** | Hosts the Next.js frontend (SSR, `proxy.ts`, image optimiser, sitemap) and Vercel Analytics; its Git integration builds and deploys `learnix-front` | Deliberately kept (decision 2026-10-13): working in production, no benefit from moving. AWS has no hosting for Next.js 16 that matches it without extra moving parts | The browser calls the AWS API cross-origin with credentials and exact-origin CORS; Vercel holds only public `NEXT_PUBLIC_*` values (no AWS keys, no database access); Terraform prints the values to set but never writes to Vercel |
| GitHub | Source, CI, deploy orchestration | Not a runtime dependency | OIDC roles pinned to repo + environment (backend repo only); no AWS keys stored |
| Browser push services | Web Push delivery | Inherent to the standard; no account | Endpoints allowlisted (SSRF guard) |
| Name.com | Domain registration | Registrar only; DNS on Route 53 | Transfer lock stays on |
| Google Fonts (`next/font`) | Font files | Downloaded at **build** time and self-hosted; no runtime request | none needed |

## 3. Choices between AWS options

| Decision | Chosen | Main alternative | Reason |
|---|---|---|---|
| Database engine | RDS PostgreSQL 16 Multi-AZ | Aurora PostgreSQL / Serverless v2 | Lower floor cost at Stage 1, I/O unmeasured; Serverless v2 never scales to zero (crons every minute). Migration path: Aurora read replica, then promote |
| Redis-compatible | ElastiCache Valkey, node-based | ElastiCache Serverless, MemoryDB | `maxmemory-policy=noeviction` must be settable (BullMQ) |
| Frontend hosting | **Vercel, unchanged** | ECS Fargate `web`, Amplify Hosting, OpenNext/Lambda | Directive 2026-10-13. Removes a Fargate service, an image/CI pipeline, a task role and a deploy role; saves about $33/month in production |
| How the browser reaches the API | Separate host `api.<domain>`, cross-origin but same-site, credentialed CORS | Vercel rewrites proxying `/api/*` to AWS; one shared domain | Rewrites would put Vercel in front of every API call: WAF and rate rules would see Vercel's egress addresses instead of browsers, latency and Vercel usage would grow, and the trusted-proxy chain would change. Direct calls keep `TRUST_PROXY_HOPS=2`, the existing cookie model (`SameSite=None; Secure; Partitioned`, host-only) and the CSRF design untouched. A shared domain is impossible while Vercel serves the apex |
| Cookie scope | Host-only on the API host (`COOKIE_DOMAIN` unset) | Parent-domain cookie `.learnix.school` | A parent-domain cookie would also reach `staging.learnix.school`; the isolation guard forbids it. The role cookie that `proxy.ts` reads is written by the frontend itself on its own host, so it needs nothing from the API |
| DNS host | Route 53 holds the whole zone (default in Terraform) | Keep Cloudflare DNS, add only `api`, the ACM validation record and the SES records there | Keeping Cloudflare avoids any change to the apex, but forgoes the Route 53 zone/queries included in the CloudFront plan and splits DNS across two providers. **Open decision** (AWS-OPEN-ITEMS.md): either way nothing changes for visitors until the registrar step is done by you. Moving DNS drops Cloudflare's proxy in front of the Vercel site; confirm the intended behaviour first |
| CDN pricing | Flat-rate Business plan | Pay-as-you-go | ~$200 vs ~$1,600 per month at the Expected scenario |
| Tracing | ADOT init container + CloudWatch agent sidecar (no code change) | OTel SDK in code, X-Ray SDK | AWS-documented path for ECS; works with the CommonJS build; Sentry steps aside automatically |
| Browser analytics | CloudWatch RUM + Cognito guest role | Pinpoint/End User Messaging analytics, self-built beacons | Purpose-built, joins X-Ray traces |
| Worker scaling | Target tracking on backlog per running task (metric math) | CPU only, step scaling | Queue depth is the real demand signal; CPU tracking stays for CPU-bound jobs |
| Queue metric transport | `PutMetricData` from the worker (1 call/min) | Embedded Metric Format logs | EMF extraction is not guaranteed through the `awslogs` driver without the agent; one API call per minute is negligible |
| Backups | RDS automated + cross-region replication **and** AWS Backup with a deny-delete vault | Snapshots by script | Policy-protected retention and a DR copy for the files bucket too |
| Deploy mechanism | GitHub Actions + OIDC + `scripts/ecs-deploy.sh` (circuit breaker, alarm check, rollback) | CodePipeline/CodeDeploy | Reuses the existing CI and its gates (migration classifier, DB-owner approval) |
