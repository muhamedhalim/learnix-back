# Environment Inventory — Learnix

> **Phase 0 deliverable.** Produced by the audit step of `STAGING_ENVIRONMENT_IMPLEMENTATION_PLAN.md`.
>
> **This document contains NO secret values.** Only variable names, hostnames, resource identifiers, file paths, and code references. Never add a value to this file.

**Audit date:** 2026-08-05
**Audit scope:** static analysis of both repositories at the working-tree revision. Dashboard state (Railway / Vercel / Cloudflare / R2 / Bunny / Paymob / MailerSend / Sentry) could **not** be read and is marked `[DASHBOARD]` — those rows are the manual actions listed in §12.

---

## 1. Repositories

| Repo | Local path | Remote | Default branch | Framework |
|---|---|---|---|---|
| Frontend | `dodline/` | `github.com/muhamedhalim/leanix-front.git` | `master` | Next.js 16.2, React 19.2 |
| Backend | `learning-center-backend/` | `github.com/muhamedhalim/learnix-back.git` | `main` | NestJS 11, Node ≥20 |
| Umbrella | `learnix-speckit/` | submodules of both | — | — |

`learnix-speckit/.gitmodules` pins `backend`→`main`, `frontend`→`master`. The workspace root is **not** a git repository.

**Finding A-01 — branch-name asymmetry.** Frontend default is `master`, backend is `main`. Any cross-repo automation must account for this. Rename proposed for Phase 5, not Phase 0.

---

## 2. Frontend audit

### 2.1 Build and deploy

| Item | Value | Source |
|---|---|---|
| Platform | Vercel | `dodline/.vercel/project.json`, project name `dodline` |
| Build | `next build` | `dodline/package.json:7` |
| Dev | `next dev` (port 3000) | `.claude/launch.json` |
| Tests | `vitest run` / `vitest run --coverage` | `package.json:11-12` |
| Type-check | `tsc --noEmit` | `package.json:14` |
| Middleware | `dodline/proxy.ts` — next-intl locale + RBAC route guard | matcher `/((?!api\|_next\|_vercel\|.*\..*).*)`|
| Analytics | `@vercel/analytics` mounted **unconditionally** | `app/[locale]/layout.tsx:90` |
| Monitoring | Sentry (`instrumentation.ts`, `instrumentation-client.ts`) | no-op without DSN |
| `robots.txt` | **DOES NOT EXIST** | no `app/robots.ts` |
| `sitemap.xml` | **DOES NOT EXIST** | no `app/sitemap.ts` |
| Replicas / regions / domains | `[DASHBOARD]` | Vercel |

### 2.2 Environment variables referenced in frontend code

| Variable | Where | Required? |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `app/[locale]/hooks/axios.config.ts:8`, `test/setup.ts:10`, `scripts/seed-admin.mjs:13` | **Yes** — `axios.config.ts:30` throws if unset |
| `NEXT_PUBLIC_BUNNY_LIBRARY_ID` | `app/[locale]/utils/video.ts:20` | No — teaser embeds break if unset |
| `NEXT_PUBLIC_SENTRY_DSN` | `instrumentation-client.ts:12`, `Components/monitoring/WebVitals.tsx:26` | No |
| `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` | `instrumentation-client.ts:19` | No (default `0.1`) |
| `SENTRY_DSN` | `instrumentation.ts:8` | No |
| `SENTRY_TRACES_SAMPLE_RATE` | `instrumentation.ts:14` | No |
| `NODE_ENV` | `instrumentation*.ts`, `axios.config.ts:36`, `WebVitals.tsx:20` | Framework-provided |
| `NEXT_RUNTIME` | `instrumentation.ts:17,20` | Framework-provided |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` / `SEED_ADMIN_NAME` | `scripts/seed-admin.mjs:25-27` | No |

**Finding A-02 — env-name mismatch in the frontend seed script.** `scripts/seed-admin.mjs` reads `SEED_ADMIN_*`, but `dodline/.env.local` defines `ADMIN_INIT_*`. The script therefore silently uses its own defaults. Recorded; fix is out of Phase 0 scope (frontend seeding is superseded by the backend synthetic seed).

**Finding A-03 — no `.env.example` on the frontend.** Nothing documents the required variables. Fixed in Phase 0 (see `dodline/.env.example`).

### 2.3 Hardcoded values blocking environment separation

| ID | Value | Location | Impact |
|---|---|---|---|
| H1 | `https://learnix.school` as `metadataBase` | `app/[locale]/layout.tsx:17` | Staging emits Production canonical/OG URLs |
| H2 | `siteConfig.url = "https://learnix.school"` | `app/[locale]/lib/site.ts:3` | `absoluteUrl()` builds Production links |
| H3 | `next/image` `remotePatterns` — three fixed hosts | `next.config.ts:9-24` | Staging API/R2 host ⇒ images 400 |
| H4 | Production Railway URL as CI build env | `.github/workflows/ci.yml:52` | CI artefact pinned to Production |
| H7 | No `robots.ts` / `sitemap.ts` | absent | Nothing to `noindex` staging with |

All five are **Phase 1** work. Phase 0 does not modify frontend runtime code (only adds `.env.example`).

---

## 3. Backend audit

### 3.1 Deployment configuration (repo-side, confirmed)

| Setting | Value | Source |
|---|---|---|
| Builder | `NIXPACKS` | `railway.json:4` |
| Node toolchain | `nodejs_20`, `npm-10_x` | `nixpacks.toml:2` |
| Install | `npm ci` | `nixpacks.toml:5` |
| Build | `npm run build` = `tsc --noEmit -p tsconfig.build.json && nest build --builder swc` | `nixpacks.toml:8`, `package.json:9` |
| Start | `npm run migration:run:prod && node dist/src/main.js` | `nixpacks.toml:11`, `Procfile:1` |
| Health-check path | `/api/v1/health` | `railway.json:9` |
| Health-check timeout | `100` | `railway.json:10` |
| Restart policy | `ON_FAILURE`, max 10 retries | `railway.json:7-8` |
| Global route prefix | `api/v1`, excluding `GET /metrics` | `src/main.ts:201-203` |
| Listen address | `0.0.0.0:${PORT}` (default 3000) | `src/main.ts:266-268` |
| Trust proxy | `1` | `src/main.ts:104` |
| Replicas / region / CPU / RAM / volumes | `[DASHBOARD]` | Railway |

**Finding A-04 — single process, no worker or cron service.** All BullMQ processors and all 11 `@Cron` jobs execute inside the API process. There is no separate entrypoint. `PROCESS_ROLE` / `HEALTH_COLLECTOR_PROCESS_ROLE` exist (`src/health/health-collector-coordinator.service.ts:66-67`) to allow a future split, but nothing sets them.

**Finding A-05 — migrations run twice per deploy.** Once from the start command, once from inside `bootstrap()` when `NODE_ENV=production` (`src/main.ts:79`). The second is idempotent by design. Neither is concurrency-safe across replicas — see A-06.

**Finding A-06 — no migration locking.** `migrationsTransactionMode: 'each'` (`src/data-source.ts:37`) with no advisory lock. Two replicas booting together both run the chain. Fix scheduled for Phase 2.

### 3.2 Environment variables referenced in backend code (113 total)

Extracted from `src/**/*.ts` excluding `*.spec.ts`. `.env.example` documents 54.

**Documented in `.env.example` before Phase 0 (54):**
`ADMIN_INIT_EMAIL`, `ADMIN_INIT_PASSWORD`, `ALLOWED_FILE_TYPES`, `BACKEND_URL`, `BCRYPT_ROUNDS`, `BULL_BOARD_PASSWORD`, `BULL_BOARD_USER`, `BUNNY_API_KEY`, `BUNNY_CDN_URL`, `BUNNY_PULL_ZONE`, `BUNNY_STORAGE_PASSWORD`, `BUNNY_STORAGE_REGION`, `BUNNY_STORAGE_ZONE`, `BUNNY_STREAM_API_KEY`, `BUNNY_STREAM_CDN_HOSTNAME`, `BUNNY_STREAM_LIBRARY_ID`, `BUNNY_STREAM_TOKEN_KEY`, `CACHE_LOCK_*` (3), `CACHE_TTL`, `COOKIE_SECRET`, `CORS_ORIGINS`, `DATABASE_URL`, `DB_POOL_*` (4), `DEFAULT_LESSON_ACCESS_DAYS`, `DEFAULT_PLATFORM_COMMISSION_BPS`, `FIREBASE_*` (3), `FRONTEND_URL`, `HEALTH_COLLECTOR_*` (3), `INIT_SECRET`, `JWT_*` (4), `LOG_LEVELS`, `MAIL_*`/`MAILERSEND_*` (14), `MAX_EXTENSION_DAYS`, `MAX_FILE_SIZE`, `META_WHATSAPP_ACCESS_TOKEN`, `META_WHATSAPP_PHONE_NUMBER_ID`, `METRICS_BEARER_TOKEN`, `MINIMUM_SETTLEMENT_MINOR`, `NODE_ENV`, `PASSWORD_RESET_EXPIRATION`, `PAYMOB_*` (6), `PERFORMANCE_*` (3), `PORT`, `PRIVATE_UPLOAD_DIR`, `PROCESS_ROLE`, `PUBLIC_MEDIA_BASE_URL`, `R2_*` (6), `REDIS_*` (5), `SENTRY_*` (4), `TEACHER_CODE_RECEIVABLE_LIMIT_MINOR`, `TEACHER_EARNING_HOLD_DAYS`, `THROTTLE_LIMIT`, `THROTTLE_TTL`, `TWILIO_*` (3), `TYPEORM_LOGGING`, `TYPEORM_SYNCHRONIZE`, `UPLOAD_DIR`

**Used in code but MISSING from `.env.example` before Phase 0 (Finding A-07):**

| Variable | Used at | Class |
|---|---|---|
| `APP_VERSION` | `src/health/` | Optional |
| `CERTIFICATE_LOGO_PATH` | `src/certificates/certificate-pdf.service.ts` | Optional |
| `CODE_EXPORT_DIR` | `src/attendance-codes/` | Optional |
| `CODE_EXPORT_TTL_HOURS` | `src/attendance-codes/` | Optional |
| `CODE_REDEEM_BASE_URL` | `src/attendance-codes/` | **Environment-specific** |
| `DEFAULT_GATEWAY_FEE_BPS` | `src/payments/services/commission.service.ts` | Financial |
| `E2E_DISABLE_BACKGROUND_WORKERS` | `src/queues/queues.constants.ts:143` | Test-only |
| `ENABLE_SWAGGER` | `src/main.ts:205` | **Environment-specific** |
| `FRONTEND_VERSION` | `src/health/` | Optional |
| `GIT_COMMIT`, `RAILWAY_GIT_COMMIT_SHA`, `RENDER_GIT_COMMIT` | `src/health/` | Platform-injected |
| `HEALTH_CACHE_TTL_MS`, `HEALTH_CHECK_TIMEOUT_MS`, `HEALTH_PROVIDER_CHECK_INTERVAL_MS` | `src/health/` | Optional |
| `HOSTNAME`, `INSTANCE_ID`, `RAILWAY_REPLICA_ID` | `health-collector-coordinator.service.ts:62-65` | Platform-injected |
| `META_WHATSAPP_APP_SECRET` | `env.validation.ts:101` | **Secret** |
| `META_WHATSAPP_VERIFY_TOKEN` | `env.validation.ts:106` | **Secret** |
| `PAYMENT_CAPTURE_GRACE_SECONDS` | `env.validation.ts:325` | **Required in production** |
| `PAYMENT_PROVIDER_CLOCK_SKEW_SECONDS` | `env.validation.ts:333` | **Required in production** |
| `PAYMOB_EXPECTED_MODE` | `env.validation.ts:317`, `paymob.gateway.ts:60` | **Critical safety** |
| `QUEUE_BACKOFF_MS`, `QUEUE_DEFAULT_ATTEMPTS`, `WORKER_CONCURRENCY` | `queues.constants.ts:163-198` | Tuning |
| `QUEUE_BACKOFF_DELAY`, `QUEUE_CONCURRENCY`, `QUEUE_MAX_ATTEMPTS` | same | **Legacy aliases** |
| `SIGNED_URL_EXPIRES_SECONDS` | `storage.service.ts:404` | Security-relevant |
| `SSL_REJECT_UNAUTHORIZED` | `database-ssl.util.ts:29` | Security-relevant |
| `TZ` | runtime | Platform |
| `UPLOAD_MAX_BYTES` | `src/uploads/` | Limit |

**Declared in `env.validation.ts` but never read (Finding A-08):** `CORS_ORIGIN` (singular, `:419`) — dead. `LESSON_ACCESS_DAYS` / `LESSON_EXTENSION_DAYS` (`:438,443`) do not match the `.env.example` names `DEFAULT_LESSON_ACCESS_DAYS` / `MAX_EXTENSION_DAYS`.

### 3.3 Local `.env` — CRITICAL

`learning-center-backend/.env` is gitignored (`.gitignore:41`) and **was never committed** (verified). It contains **54 keys**, including values that are structurally production-shaped:

| Key | Observed shape | Why this indicates production |
|---|---|---|
| `REDIS_URL` | `redis://…@redis.railway.internal:6379` | `*.railway.internal` resolves **only inside a Railway private network**. A local machine cannot reach it. This value can only have come from a Railway deployment's variables |
| `R2_BUCKET` | `learnix` | Same bucket name the production storage would use |
| `R2_PUBLIC_BASE_URL` | `…r2.cloudflarestorage.com/learnix` | Matches the host hardcoded in `dodline/next.config.ts:13` |
| `MAIL_FROM_EMAIL` | `info@learnix.school` | The public-facing production sender, also in `dodline/app/[locale]/lib/site.ts:4` |
| `PAYMOB_API_KEY`, `PAYMOB_SECRET_KEY`, `PAYMOB_WEBHOOK_SECRET`, `PAYMOB_CARD_INTEGRATION_ID`, `PAYMOB_IFRAME_ID` | present, non-empty | Merchant mode unverifiable from here |
| `MAILERSEND_API_KEY` + 10 template IDs | present, non-empty | — |
| `JWT_SECRET`, `JWT_REFRESH_SECRET`, `COOKIE_SECRET`, `INIT_SECRET`, `METRICS_BEARER_TOKEN` | present, non-empty | — |
| `BUNNY_STREAM_API_KEY`, `BUNNY_STREAM_TOKEN_KEY`, `BUNNY_API_KEY`, `BUNNY_STREAM_LIBRARY_ID` | present, non-empty | — |
| `ADMIN_INIT_EMAIL`, `ADMIN_INIT_PASSWORD` | present, non-empty | — |

**Finding A-09 (CRITICAL).** `DATABASE_URL` in this file points at `localhost:5432/LMS`, so the local DB is *not* production. But `REDIS_URL` is a Railway-internal address, which is only obtainable by copying a deployed environment's variables. The most probable reading is that this `.env` was seeded from the production Railway variable set. **Every secret in it must be treated as exposed and rotated.** Full checklist: `docs/SECRET_ROTATION_CHECKLIST.md`.

**Finding A-10.** `R2_PUBLIC_BASE_URL` is set in the local `.env`, but `src/storage/storage.service.ts:392` **throws** when it is set and `NODE_ENV=production`. Production therefore cannot have this value — confirming local `.env` and the Railway variable set have already diverged, and that the local file is a partial/stale copy rather than a live mirror.

### 3.4 Database

| Item | Value | Source |
|---|---|---|
| Engine | PostgreSQL (`type: 'postgres'`) | `src/data-source.ts:29`, `app.module.ts:286` |
| Connection | `DATABASE_URL` only | `data-source.ts:30` |
| SSL | Host-derived, **not** `NODE_ENV`-derived; loopback ⇒ off | `common/utils/database-ssl.util.ts` |
| `rejectUnauthorized` | `true` unless `SSL_REJECT_UNAUTHORIZED=false` | `database-ssl.util.ts:29` |
| Synchronize | `false` in data-source; app throws if `true` in production | `data-source.ts:36`, `app.module.ts:261` |
| Pool | max 10 / min 2 / idle 30s / connect 10s (env-overridable) | `app.module.ts:278-283` |
| Entities glob | `{dist\|src}/**/entities/*.entity.{js\|ts}` | `data-source.ts:17` |
| Migrations glob | `{dist/src\|src}/migrations/[0-9]*-!(*.spec).{js\|ts}` | `data-source.ts:21` |
| Transaction mode | `each` | `data-source.ts:37` |
| **Migration count** | **104** files | `ls src/migrations/*.ts \| grep -v spec` |
| Extensions | `uuid-ossp` created by the first migration | `1734986400000-InitialSchema.ts:8` |
| Production version / backups | `[DASHBOARD]` | Railway |

**Finding A-11 (CRITICAL) — the migration chain is unverified against an empty database.** The E2E suite sets `TYPEORM_SYNCHRONIZE=true` (`test/.env.test`, `.github/workflows/ci.yml:74`) and builds the schema from entities instead of running migrations. No automated test executes the 104-file chain. Addressed in Phase 0 by the new migration-chain harness.

### 3.5 Redis

| Item | Value | Source |
|---|---|---|
| Resolution | `REDIS_URL`, else `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD`, else undefined | `common/utils/redis-connection.util.ts:22` |
| Consumers | cache store, throttler storage, BullMQ, idempotency, health-collector lock, distributed single-flight | `app.module.ts:109,193`, `queues.module.ts:54` |
| Production requirement | **Fatal** if unset — cache (`app.module.ts:124`) and BullMQ (`queues.module.ts:64`) both throw | — |
| **Key namespace / prefix** | **NONE** — no BullMQ `prefix` and no cache key prefix is configured | `queues.module.ts:80` passes only `connection` |

**Finding A-12 (HIGH) — Redis has no environment namespace.** Two environments sharing one Redis instance would collide on every queue key, cache key, throttle counter, and idempotency record. The isolation guard added in Phase 0 blocks the shared-instance case; an explicit `REDIS_NAMESPACE`/BullMQ `prefix` is recommended for Phase 2 as defence in depth.

### 3.6 Queues

**13 queue names** — `src/queues/queues.constants.ts:13`:
`email`, `bulk-notifications`, `image-processing`, `file-cleanup`, `code-generation`, `code-export`, `exam-auto-submit`, `exam-ai-grading`, `exam-omr`, `exam-analytics`, `gamification`, `parent-notifications`, `parent-notifications-dlq`.

**10 processors:**

| Processor | Queue |
|---|---|
| `src/mail/mail.processor.ts` | `email` |
| `src/attendance-codes/processors/code-generation.processor.ts` | `code-generation` |
| `src/attendance-codes/processors/code-export.processor.ts` | `code-export` |
| `src/bulk-operations/processors/bulk-notification.processor.ts` | `bulk-notifications` |
| `src/exams/processors/exam-auto-submit.processor.ts` | `exam-auto-submit` |
| `src/exams/processors/exam-ai-grading.processor.ts` | `exam-ai-grading` |
| `src/exams/processors/exam-analytics.processor.ts` | `exam-analytics` |
| `src/exams/processors/omr.processor.ts` | `exam-omr` |
| `src/gamification/processors/game-sweep.processor.ts` | `gamification` |
| `src/notifications/processors/parent-notification.processor.ts` | `parent-notifications` |

Registered from 6 modules plus `queues.module.ts`. When Redis is unconfigured (non-production only), `registerQueues` substitutes `NoopQueue`.

**Bull Board:** `/admin/queues`, HTTP Basic Auth, **fails closed** without `BULL_BOARD_USER`/`BULL_BOARD_PASSWORD` — `src/queues/bull-board-auth.middleware.ts`.

### 3.7 Cron jobs — full audit

11 `@Cron` declarations, all in-process. Detailed impact analysis: `docs/CRON_AUDIT.md`.

| Cadence | Service | File:line | Financial impact |
|---|---|---|---|
| Every minute | Payment reconciliation | `payments/services/payment-operations.service.ts:59` | **YES — direct** |
| Every minute | Gateway webhook replay | `payments/services/gateway-webhook.service.ts:147` | **YES — direct** |
| Every 30 min | Settlement / payout maintenance | `payment-operations.service.ts:192` | **YES — direct** |
| Every 5 min | Certificate issuance retry | `certificates/certificates.service.ts:254` | No |
| Every 5 min | Scheduled course publishing | `packages/packages.service.ts:919` | Indirect (visibility) |
| Every 15 min | Support SLA sweep | `complaints/support-sla.service.ts:55` | No |
| Every 30 min | Expired lesson-upload cleanup | `lessons/lessons.service.ts:812` | **Deletes storage objects** |
| Weekly Sun 02:00 | Orphan file cleanup | `uploads/cleanup.service.ts:46` | **Deletes storage objects** |
| Daily 03:00 | Expired session cleanup | `users/sessions.service.ts:23` | No |
| Every minute + `@Timeout(2s)` | Health collection | `health/health-collection.service.ts:27` | No |
| Hourly | Health retention prune | `health/health-collection.service.ts:106` | No |

**Finding A-13 (CRITICAL).** Three jobs mutate financial state and two delete storage objects, all beginning within 60 seconds of boot and none gated by any flag. A misconfigured staging instance is a financial incident, not a config error. Feature flags added in Phase 0.

### 3.8 Storage

| Item | Value | Source |
|---|---|---|
| Facade | `StorageService`, single provider chosen at construction | `src/storage/storage.service.ts:374` |
| Selection order | R2 → Bunny Storage → local disk | `storage.service.ts:384-438` |
| Production guards | throws if `R2_PUBLIC_BASE_URL` set (`:392`); throws on Bunny-only (`:415`); throws if no object storage (`:429`) | — |
| Signed-URL TTL | `SIGNED_URL_EXPIRES_SECONDS`, default 300s | `storage.service.ts:404` |
| Public proxy | `GET /api/v1/media/public/:folder/:filename` | `src/media/media.controller.ts` |
| Public folders | `images`, `thumbnails`, `profiles` only | `src/common/constants.ts:73` |
| Private content | books, OMR sheets, homework — never proxied publicly | `constants.ts:66-72` |
| **Storage prefix** | **NONE** — no key prefix configured | — |
| Bucket name (local `.env`) | `learnix` | — |
| Production bucket / token scopes / versioning | `[DASHBOARD]` | Cloudflare R2 |

**Video** is separate: Bunny **Stream** (`src/lessons/bunny-stream.service.ts`), TUS direct upload signed by the backend, token-signed HLS playback. Deletes videos on lesson replacement and cleanup.

### 3.9 Email — MailerSend

| Item | Value | Source |
|---|---|---|
| Provider gate | `MAIL_PROVIDER` must equal `mailersend` | `src/mail/mailersend.config.ts` |
| Client | `mailersend` SDK, initialised in constructor | `src/mail/mail.service.ts:85` |
| Delivery path | queued via BullMQ `email` queue → `MailProcessor` | `mail.service.ts:57`, `mail.processor.ts` |
| Templates | 10 `MAILERSEND_TEMPLATE_*` IDs; inline HTML when unset | `env.validation.ts:360-396` |
| **Recipient filtering** | **NONE** — any address in the DB is mailable | audited `mail.service.ts` |
| Health probe | config-only, no network call | `mail.service.ts:95,119` |
| Admin test endpoint | `POST /api/v1/health/actions/test-email` (`@Roles('admin')`) | `health.controller.ts:167` |

**Finding A-14 (HIGH).** No allowlist exists. A staging instance with a working MailerSend key and any real address in its database sends real mail. Mitigated in Phase 0 by the guard requiring `MAIL_ALLOWLIST` in staging; the runtime filter itself is Phase 6.

### 3.10 Payments

| Item | Value | Source |
|---|---|---|
| Card gateway | Paymob, EGP only | `src/payments/providers/paymob/paymob.gateway.ts:34` |
| Base URL allowlist | `accept.paymob.com`, `accept.paymobsolutions.com`, HTTPS only | `env.validation.ts:22,24` |
| Mode | `PAYMOB_EXPECTED_MODE` (`test`\|`live`); defaults to live when `NODE_ENV=production` | `paymob.gateway.ts:60-63` |
| Production enforcement | if `PAYMOB_API_KEY` set, mode **must** be `live` | `env.validation.ts:481-485` |
| Webhook | `POST /api/v1/payments/webhook` + `/webhook/callback`, `?hmac=`, `@SkipCsrf`, `@SkipThrottle` | `payments-webhook.controller.ts:25,42` |
| Webhook URL source | **Paymob dashboard**, not derived from env | — |
| Manual methods | `bank_transfer`, `instapay`, `mobile_wallet`, `cash`, `custom` — **database rows**, not env | `entities/manual-payment-method-type.enum.ts`, `manual-payment-method-configuration.ts` |
| Idempotency | Redis-backed | `src/idempotency/idempotency.service.ts` |
| Refunds / voids | `src/payments/services/refunds.service.ts` | — |
| Which merchant is live | `[DASHBOARD]` | Paymob |

**Finding A-15.** InstaPay handles, wallet numbers, and bank details live in the database. A staging database seeded from production would publish real payment destinations to testers. The synthetic seed avoids this by construction.

### 3.11 Authentication, cookies, CORS, CSRF

| Concern | Value | Source |
|---|---|---|
| Access cookie | `access_token`, path `/api/v1` | `src/auth/auth-cookie.constants.ts:1,4` |
| Refresh cookie | `refresh_token`, path `/api/v1/auth` | `auth-cookie.constants.ts:2,5` |
| CSRF cookie | `XSRF-TOKEN`, path `/`, signed, `httpOnly:false` | `common/guards/csrf.guard.ts:33,165` |
| CSRF header | `X-CSRF-Token`, constant-time compare | `csrf.guard.ts:34,57` |
| **Cookie `domain`** | **NEVER SET** — host-only cookies | `grep -rn "domain:" src/` returns no cookie usage |
| Cookie flags | `secure` + `SameSite=None` + `Partitioned` when `NODE_ENV=production` **or** `req.secure` | `common/utils/cookie-security.util.ts:21-26` |
| Cookie signing | `COOKIE_SECRET`, falls back to `JWT_SECRET`; process exits if both unset | `main.ts:106-111` |
| Access token TTL | `JWT_EXPIRATION`, default `15m` | `.env.example:32` |
| Refresh token TTL | `JWT_REFRESH_EXPIRATION`, default `7d` | `.env.example:39` |
| Refresh rotation | on `POST /auth/refresh` | `dodline/app/[locale]/hooks/axios.config.ts:181` |
| Revocation | `user_sessions` table + daily 03:00 cleanup | `users/sessions.service.ts:23` |
| CORS | exact allowlist, no wildcard, `credentials: true` | `main.ts:162-183`, `common/utils/cors.util.ts:25` |
| CORS production requirement | `CORS_ORIGINS` required, no `*`, must include `FRONTEND_URL` | `config/public-url.util.ts:129-146` |
| Helmet | HSTS 1y preload, `frameguard: deny`, CSP **production-only** | `main.ts:118-155` |

**Finding A-16 (positive).** Host-only cookies mean `learnix.school` and `staging.learnix.school` cannot share credentials even by mistake. Preserve this — do **not** introduce `COOKIE_DOMAIN`.

**Finding A-17.** `src/common/utils/cors.util.ts:22` returns `['https://learnix.school', 'http://localhost:3000']` as the **non-production** fallback. A dev or staging instance without `CORS_ORIGINS` silently trusts the production origin. Fix scheduled for Phase 1.

### 3.12 Rate limiting

| Tier | Limit | Applied to |
|---|---|---|
| `GLOBAL` | 300 / 60s | every route (global `ThrottlerGuard`) |
| `DEFAULT` | 5 / 60s | per-route opt-in |
| `STRICT` | 3 / 60s | expensive operations |
| `AUTH` | 5 / 300s | intended for auth routes |
| `LOGIN_TESTSPRITE_TEMPORARY` | **150 / 60s** | **`POST /auth/login`** |
| `PAYMENTS` | 3 / 60s | payment init |
| `FILE_UPLOAD` | 3 / 60s | uploads |

Source: `src/common/constants.ts:47-61`; login binding at `src/auth/auth.controller.ts:153`.

**Finding A-18 (HIGH).** The in-code comment at `constants.ts:56-57` states: *"TEMPORARY: TestSprite exercises many login scenarios from one IP. Restore `THROTTLE.AUTH` on AuthController.login before the next production deploy."* That deploy has occurred; the 150/min tier is live. Fixed in Phase 0.

Storage backend: Redis when configured (`app.module.ts:210`), in-memory otherwise. Guard is **disabled entirely** when `NODE_ENV=test` (`app.module.ts:360`).

### 3.13 CI/CD

| | Backend `.github/workflows/ci.yml` | Frontend `.github/workflows/ci.yml` |
|---|---|---|
| Triggers | `push: ['**']`, `pull_request` | same |
| Jobs | `build-test`, `e2e`, `secret-scan` | `build`, `secret-scan` |
| Steps | `tsc --noEmit` → `eslint .` → `npm run build` → `test:cov` | `npm run lint` → `tsc --noEmit` → `test:coverage` → `next build` |
| E2E services | postgres:16, redis:7 | — |
| E2E schema | **`TYPEORM_SYNCHRONIZE: 'true'`** (`:74`) | — |
| Prettier check | **absent** (the `lint` npm script includes it; CI runs bare `eslint`) | n/a |
| Dependency audit | **absent** | **absent** |
| Migration validation | **absent** | n/a |
| Env validation | **absent** | **absent** |
| Deploy job | **absent** | **absent** |
| Branch protection | `[DASHBOARD]` — none observed | `[DASHBOARD]` |

Secret scanning is `gitleaks/gitleaks-action@v2` with `fetch-depth: 0` on both repos; backend has a `.gitleaks.toml`.

### 3.14 Seed scripts

| Script | Command | Status |
|---|---|---|
| `seed:admin` | `ts-node src/database/seed-admin.ts` | **Works** — delegates to `AdminInitializationService` |
| `seed` | `npm run build && node dist/database/seed.js` | **BROKEN** — `src/database/seed.ts` does not exist (Finding A-19) |
| `dodline` `seed:admin` | `node scripts/seed-admin.mjs` | Works, but reads the wrong env names (A-02) |

`AdminInitializationService` also runs on **every** boot from `main.ts:100`, creating an admin only when **no** admin exists anywhere (`admin-initialization.service.ts:72`). Hardcodes `username: 'admin'`, `phone: '01099999999'` (`:85-86`).

### 3.15 Monitoring and health

| Signal | Endpoint / mechanism | Auth |
|---|---|---|
| Liveness | `GET /api/v1/health` | public |
| Readiness | `GET /api/v1/health/readiness` | public |
| Full detail | `GET /api/v1/health/all` | `@Roles('admin')` |
| Health metrics / errors / incidents / alerts | `GET /api/v1/health/{metrics,errors,incidents,alerts}` | `@Roles('admin')` |
| Admin actions | `POST /health/actions/run`, `/components/:id/recheck`, `/actions/test-email`, `/queues/:name/action`, `/actions/export` | `@Roles('admin')` |
| Prometheus | `GET /metrics` (outside `api/v1`) | `METRICS_BEARER_TOKEN` bearer, **fails closed** |
| Errors | Sentry, `environment: NODE_ENV`, `sendDefaultPii: false` | `src/observability/sentry.ts:31,37` |

**Indicators:** `database`, `redis`, `queue`, `storage`, `scheduler`, `document`, `backend-api`, `external-providers` (Firebase, WhatsApp, Twilio, Bunny, Sentry, frontend reachability).

**Finding A-20.** Sentry's `environment` is `NODE_ENV`. Because staging must run `NODE_ENV=production` (§3.16), staging errors would be tagged `production`. Fix scheduled for Phase 1.

**Reference stack:** `AUDIT/monitoring/docker-compose.monitoring.yml` (Prometheus + Grafana) — local reference only, not deployed.

### 3.16 `NODE_ENV` coupling

`NODE_ENV` is treated as a binary switch controlling, at minimum:

| Behaviour | Location |
|---|---|
| Redis required / in-memory cache forbidden | `app.module.ts:121-133` |
| BullMQ required | `queues.module.ts:61-66` |
| `TYPEORM_SYNCHRONIZE=true` rejected | `app.module.ts:261` |
| Object storage required; `R2_PUBLIC_BASE_URL` rejected; Bunny-only rejected | `storage.service.ts:392,415,429` |
| `CORS_ORIGINS` required | `cors.util.ts:19`, `public-url.util.ts:131` |
| `FRONTEND_URL` / `BACKEND_URL` must be public HTTPS | `public-url.util.ts:110` |
| CSP enabled | `main.ts:137` |
| Swagger suppressed | `main.ts:205` |
| Stack traces hidden | `http-exception.filter.ts:82` |
| Password-reset token withheld from response | `auth.service.ts:614` |
| Paymob defaults to live mode | `paymob.gateway.ts:63` |
| Payment timing vars required | `env.validation.ts:474` |
| Throttler guard registered | `app.module.ts:360` (disabled when `test`) |
| SQL logging default | `app.module.ts:291` |
| Cookie `Secure`/`SameSite=None`/`Partitioned` | `cookie-security.util.ts:21` |

The `Environment` enum accepts only `development` \| `production` \| `test` (`env.validation.ts:16-20`).

**Finding A-21 (CRITICAL, design).** `NODE_ENV=staging` is impossible — it would fail validation and, if forced, disarm every guard above. Staging must therefore run `NODE_ENV=production`, which makes it **indistinguishable from Production** in Sentry, logs, health payloads, and the `GET /` banner. Resolved in Phase 0 by adding `APP_ENV` as an additive dimension.

**Positive precedent:** `common/utils/database-ssl.util.ts` deliberately derives behaviour from the connection string rather than `NODE_ENV`, with a comment explaining why. The isolation guard follows this pattern.

---

## 4. Consolidated findings

| ID | Severity | Finding | Phase 0 action |
|---|---|---|---|
| A-09 | **Critical** | Production-shaped secrets in local `.env` | Rotation checklist written; no code rotation |
| A-11 | **Critical** | 104-migration chain unverified on empty DB | Migration-chain harness added |
| A-13 | **Critical** | Unflagged financial + destructive cron | Feature flags added |
| A-21 | **Critical** | `NODE_ENV` overloaded; staging indistinguishable | `APP_ENV` added |
| A-18 | High | Login limit 150/min in Production | Restored to `AUTH` tier |
| A-06 | High | No migration locking across replicas | Deferred to Phase 2 (documented) |
| A-12 | High | Redis has no environment namespace | Guard blocks shared instance; namespace deferred to Phase 2 |
| A-14 | High | No email recipient allowlist | Guard requires `MAIL_ALLOWLIST` in staging |
| A-07 | Medium | 30+ env vars undocumented | `.env.example` rewritten |
| A-17 | Medium | Dev CORS fallback trusts production origin | Deferred to Phase 1 (documented) |
| A-19 | Medium | `npm run seed` targets a non-existent file | Repointed to the new staging seed |
| A-20 | Medium | Sentry would tag staging as `production` | Deferred to Phase 1 (documented) |
| A-02 | Low | Frontend seed reads mismatched env names | Documented |
| A-03 | Low | No frontend `.env.example` | Created |
| A-08 | Low | Dead / mismatched validation properties | Documented |
| A-01 | Low | `main` vs `master` asymmetry | Deferred to Phase 5 |
| A-04/05/10/15/16 | Info | Architecture facts | Documented |

---

## 5. Dashboard items still unknown

Each row is a manual action. See §12 of the Phase 0 report in `STAGING_ENVIRONMENT_IMPLEMENTATION_PLAN.md`.

| # | Unknown | Where | Needed for |
|---|---|---|---|
| D-01 | Production Railway variable **key list** | Railway | Completing this inventory |
| D-02 | Replicas, region, CPU/RAM, volumes | Railway | Sizing staging |
| D-03 | Postgres major version + backup settings | Railway | Phase 2 |
| D-04 | Vercel project settings, domains, env scopes | Vercel | Phase 4 |
| D-05 | R2 bucket list, token scopes, **object versioning** | Cloudflare | Phase 3, rollback design |
| D-06 | Bunny Stream library IDs and pull zones | Bunny | Phase 3 |
| D-07 | Which Paymob merchant is live; sandbox availability | Paymob | Phase 3 |
| D-08 | MailerSend domains, API keys, template IDs | MailerSend | Phase 3 |
| D-09 | Sentry projects and environments | Sentry | Phase 3 |
| D-10 | Is `learnix.school` DNS on Cloudflare? | DNS registrar | Phase 4 gate design |
| D-11 | GitHub branch-protection state | GitHub | Phase 5 |
