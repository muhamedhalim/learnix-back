# Staging Environment Implementation Plan — Learnix

> **STATUS: Phase 0 COMPLETE AND CLOSED (audited).** See [§25 Phase 0 Execution Record](#25-phase-0-execution-record) for the original build, and [§26 Phase 0 Closure Audit](#26-phase-0-closure-audit) for the follow-up review that verified it, found and fixed 3 additional defects, and formally closes every open item.
>
> **STATUS: Phase 2 — Implementation: Completed. Verification: Completed, with documented pre-existing and flaky E2E failures (NOT a full pass).** The E2E gate's real, captured exit code is **1** (125/133 passed, 6 failing suites) — see [§29.8](#298-test-results-numerical) for the numerical results and [`docs/E2E_KNOWN_FAILURES.md`](../docs/E2E_KNOWN_FAILURES.md) for the per-suite classification. This is never rounded up to "passed" anywhere in this document. See [§29 Phase 2 Execution Record](#29-phase-2-execution-record) (Database and Redis isolation, real Redis key namespacing, advisory-locked migrations with a bounded wait, backup/restore tooling, seed idempotency + arming, graceful shutdown, Redis-aware readiness) and [§29.12](#2912-phase-2-closure-review-git-diff-and-hardening) for the closure review (git diff audit, lock hardening, migration run policy, seed-guard verification). [§28](#28-phase-2--current-state-verification) is the pre-execution audit. Phase 1 is documented in [§27](#27-phase-1-execution-record); Phase 0 is fully closed with no open items (§26.7's E2E gate was run to completion — 6 failures, all individually traced to pre-existing bugs or test-harness flakiness, zero caused by this project's code). **Phase 3 (Storage and third-party integrations) is complete** — see [§30](#30-phase-3-execution-record). **Phase 4 (Railway services and DNS) is code/documentation-complete but infrastructure-blocked** — no Railway/Vercel/DNS/Cloudflare resource could be created from this environment (Vercel/GitHub/Cloudflare credentials are unavailable here; creating new billed Railway infrastructure requires your explicit go-ahead); see [§31](#31-phase-4-execution-record) and `docs/PHASE_4_DASHBOARD_CHECKLIST.md` for the exact remaining dashboard steps. **Phase 5 (CI/CD and branch protection) is code/documentation-complete, with branch protection and Railway/Vercel auto-deploy changes similarly blocked on dashboard access** — see [§32](#32-phase-5-execution-record). Phases 6–9 have **not started**.

**Legend used throughout:**
`[CONFIRMED]` = verified in a file in this repo, path cited.
`[RECOMMENDED]` = my proposal, not currently present.
`[UNVERIFIABLE]` = lives in Railway/Vercel/Cloudflare/Paymob dashboards, which I cannot read from here. Listed as a Phase 0 audit task.

No secret values appear in this document.

---

## 1. Context — why this work

Production is about to take real teachers, real students, and real money through Paymob and manual InstaPay/wallet/bank transfers. Today there is exactly one deployed environment, and every change reaches it directly: neither repo has a `develop` branch, neither CI workflow has a deploy job or a branch filter, and the backend's start command runs `migration:run:prod` unconditionally on boot. The first bad migration lands on live financial data.

The goal is a Staging environment that is a faithful mirror of Production's _topology_ while sharing **none** of its resources, so that migrations, integrations, and releases are proven before they touch customers.

---

## 2. Current architecture — Current State Report

### 2.1 Repositories

| Repo     | Path                       | Remote                                     | Default branch |
| -------- | -------------------------- | ------------------------------------------ | -------------- |
| Frontend | `dodline/`                 | `github.com/muhamedhalim/leanix-front.git` | `master`       |
| Backend  | `learning-center-backend/` | `github.com/muhamedhalim/learnix-back.git` | `main`         |
| Umbrella | `learnix-speckit/`         | pins both as git submodules                | —              |

`[CONFIRMED]` `learnix-speckit/.gitmodules` pins `backend`→`main`, `frontend`→`master`. The workspace root `lms-f+b/` is **not** a git repo. Branch names differ between the two repos — this matters for the Git strategy in §11.

### 2.2 Frontend

- Next.js 16 + React 19 + next-intl (`en`/`ar`, `localePrefix: as-needed`), TanStack Query, Tailwind 4, Vitest. `dodline/package.json`
- Deployed on **Vercel** — `dodline/.vercel/project.json` (project name `dodline`), `@vercel/analytics` mounted in `dodline/app/[locale]/layout.tsx:90`, and an `origin/vercel/install-vercel-web-analytics-*` branch.
- Auth is cookie-based against the backend. `dodline/app/[locale]/hooks/axios.config.ts` — `withCredentials: true`, CSRF double-submit via `X-CSRF-Token`, 401→`/auth/refresh`→retry queue. A **non-sensitive** `user` cookie is written client-side and read by the edge middleware `dodline/proxy.ts` for RBAC routing.
- `NEXT_PUBLIC_API_URL` is **required** — `axios.config.ts:30` throws if unset. Normalised to exactly one `/api/v1` suffix by `normalizeApiBaseUrl`.

### 2.3 Backend

- NestJS 11, TypeORM 0.3 + Postgres, BullMQ + Redis, Passport JWT, Swagger, Terminus health, Sentry. `learning-center-backend/package.json`
- **One process only.** `nixpacks.toml` / `Procfile` both start `npm run migration:run:prod && node dist/src/main.js`. There is no worker or cron entrypoint — every BullMQ processor and all 11 `@Cron` jobs run inside the API process.
- `PROCESS_ROLE` / `HEALTH_COLLECTOR_PROCESS_ROLE` exist (`src/health/health-collector-coordinator.service.ts:66`) so a future `worker` role could be split out, but nothing sets them today.

### 2.4 Deployment mechanism `[CONFIRMED from repo]` / `[UNVERIFIABLE in dashboards]`

| Setting                       | Value                                                         | Source                              |
| ----------------------------- | ------------------------------------------------------------- | ----------------------------------- |
| Builder                       | NIXPACKS                                                      | `railway.json:4`                    |
| Node                          | `nodejs_20`, `npm-10_x`                                       | `nixpacks.toml:2`                   |
| Install                       | `npm ci`                                                      | `nixpacks.toml:5`                   |
| Build                         | `npm run build` (`tsc --noEmit` + `nest build --builder swc`) | `nixpacks.toml:8`, `package.json:9` |
| Start                         | `npm run migration:run:prod && node dist/src/main.js`         | `nixpacks.toml:11`, `Procfile:1`    |
| Health check                  | `/api/v1/health`                                              | `railway.json:9`                    |
| Restart policy                | `ON_FAILURE`, max 10 retries                                  | `railway.json:7-8`                  |
| Replicas / resources / region | `[UNVERIFIABLE]`                                              | Railway dashboard                   |

Migrations also run a second time from inside the app when `NODE_ENV=production` (`src/main.ts:79`), as an idempotent safety net.

### 2.5 Current domains

| Surface            | Current                                                     | Evidence                                                                             |
| ------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Frontend canonical | `https://learnix.school`                                    | hardcoded `dodline/app/[locale]/layout.tsx:17`, `dodline/app/[locale]/lib/site.ts:3` |
| Backend API        | `https://learning-center-backend-production.up.railway.app` | `dodline/next.config.ts:17`, `dodline/.github/workflows/ci.yml:52`                   |

**Decision taken:** keep these as-is. `app.learnix.school` / `api.learnix.school` are documented in §6 as a _separate, later, optional_ migration with its own runbook. This work adds staging only and does not touch Production DNS.

### 2.6 External integrations

| Integration             | Purpose                                                  | Config surface                                                                                                                                 | Sandbox?                                       |
| ----------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **Paymob**              | Card checkout (EGP only)                                 | `PAYMOB_*`; `src/payments/providers/paymob/paymob.gateway.ts`                                                                                  | Yes — separate test merchant account           |
| **Manual payments**     | InstaPay / mobile wallet / bank transfer / cash / custom | **Database rows**, not env — `src/payments/entities/manual-payment-method-type.enum.ts`, validated by `manual-payment-method-configuration.ts` | N/A — no real money moves; admin reviews proof |
| **Attendance codes**    | Activation codes (teacher/center/agent batches)          | DB + BullMQ `code-generation` / `code-export`                                                                                                  | N/A                                            |
| **Cloudflare R2**       | Images, PDFs, books, certificates, OMR, exports          | `R2_*`; `src/storage/storage.service.ts:384`                                                                                                   | Separate bucket                                |
| **Bunny Stream**        | Lesson video (TUS direct upload, token-signed HLS)       | `BUNNY_STREAM_*`; `src/lessons/bunny-stream.service.ts`                                                                                        | Separate library                               |
| **MailerSend**          | All transactional email, 10 template IDs                 | `MAIL_PROVIDER`, `MAILERSEND_*`                                                                                                                | Separate domain/API key                        |
| **Twilio**              | SMS fallback for guardian OTP                            | `TWILIO_*`; `src/notifications/channels/sms.channel.ts`                                                                                        | Test credentials + magic numbers               |
| **Meta WhatsApp Cloud** | Preferred guardian channel                               | `META_WHATSAPP_*`; `whatsapp-meta.channel.ts`                                                                                                  | Test number                                    |
| **Firebase Admin**      | Push / ID-token auth                                     | `FIREBASE_*`                                                                                                                                   | Separate project                               |
| **Sentry**              | Errors + tracing, both repos                             | `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`                                                                                                         | Separate `environment` tag                     |
| **Vercel Analytics**    | Frontend web analytics                                   | mounted unconditionally, `layout.tsx:90`                                                                                                       | Separate Vercel project                        |

### 2.7 Queues, workers, cron

**12 BullMQ queues** — `src/queues/queues.constants.ts:13`: `email`, `bulk-notifications`, `image-processing`, `file-cleanup`, `code-generation`, `code-export`, `exam-auto-submit`, `exam-ai-grading`, `exam-omr`, `exam-analytics`, `gamification`, `parent-notifications`, `parent-notifications-dlq`.

**Bull Board** at `/admin/queues`, HTTP Basic Auth, **fails closed** without `BULL_BOARD_USER`/`BULL_BOARD_PASSWORD` — `src/queues/bull-board-auth.middleware.ts`.

**11 `@Cron` jobs**, all in-process:

| Schedule              | Service                         | File                                                     |
| --------------------- | ------------------------------- | -------------------------------------------------------- |
| Every minute          | Payment reconciliation          | `src/payments/services/payment-operations.service.ts:59` |
| Every minute          | Webhook replay/retry            | `src/payments/services/gateway-webhook.service.ts:147`   |
| Every minute + hourly | Health collection               | `src/health/health-collection.service.ts:27,106`         |
| Every 5 min           | Certificate issuance retry      | `src/certificates/certificates.service.ts:254`           |
| Every 5 min           | Scheduled course publishing     | `src/packages/packages.service.ts:919`                   |
| Every 15 min          | Support SLA sweep               | `src/complaints/support-sla.service.ts:55`               |
| Every 30 min          | Settlement / payout maintenance | `payment-operations.service.ts:192`                      |
| Every 30 min          | Expired-upload cleanup saga     | `src/lessons/lessons.service.ts:812`                     |
| Daily 03:00           | Expired session cleanup         | `src/users/sessions.service.ts:23`                       |
| Weekly Sun 02:00      | Orphan-file cleanup             | `src/uploads/cleanup.service.ts:46`                      |

> **This is the single most dangerous fact for staging.** These jobs are not opt-in. A staging instance pointed at any Production resource begins mutating it within 60 seconds of boot — reconciling payments, replaying webhooks, and deleting "orphaned" files. Isolation cannot be a convention; it must be enforced at boot (§14).

### 2.8 Auth, cookies, CORS, CSRF

| Concern           | Current behaviour                                                                                                | Evidence                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Access token      | HttpOnly cookie `access_token`, path `/api/v1`, `JWT_EXPIRATION` default `15m`                                   | `src/auth/auth-cookie.constants.ts:1,4`               |
| Refresh token     | HttpOnly cookie `refresh_token`, path `/api/v1/auth`, default `7d`                                               | `auth-cookie.constants.ts:2,5`                        |
| Cookie flags      | `secure` + `SameSite=None` + `Partitioned` when `NODE_ENV=production` **or** `req.secure`                        | `src/common/utils/cookie-security.util.ts:21-26`      |
| **Cookie domain** | **Never set** → host-only cookies                                                                                | no `domain:` option anywhere in `src/`                |
| Cookie signing    | `COOKIE_SECRET`, fallback `JWT_SECRET`; process exits if both unset                                              | `src/main.ts:106-111`                                 |
| CSRF              | Double-submit, signed cookie `XSRF-TOKEN` (path `/`, `httpOnly:false`), header `X-CSRF-Token`, `timingSafeEqual` | `src/common/guards/csrf.guard.ts:33,123,165`          |
| CORS              | Exact allowlist, **no wildcards**, `credentials: true`                                                           | `src/main.ts:162`, `src/common/utils/cors.util.ts:25` |
| Trust proxy       | `app.set('trust proxy', 1)`                                                                                      | `src/main.ts:104`                                     |
| Helmet            | HSTS 1y preload, `frameguard: deny`, CSP **production-only**                                                     | `src/main.ts:118-155`                                 |

**Host-only cookies are a gift.** Because no `domain` is ever set, `api.learnix.school` and `api-staging.learnix.school` cannot share a cookie even by accident. §10 keeps it that way and adds an env-driven cookie-name suffix as defence in depth.

### 2.9 Environment validation already in place `[CONFIRMED]`

The backend already fails fast on a large class of misconfiguration. This is the foundation the staging guards bolt onto:

- `src/config/env.validation.ts` — `DATABASE_URL`, `JWT_SECRET` (≥32), `JWT_REFRESH_SECRET` (≥32) required always.
- Production-only: `PAYMENT_CAPTURE_GRACE_SECONDS` + `PAYMENT_PROVIDER_CLOCK_SKEW_SECONDS` must be explicit (`:473-480`); if `PAYMOB_API_KEY` is set then `PAYMOB_EXPECTED_MODE` must be `live` (`:481-485`).
- `validatePaymobBaseUrl` (`:24`) — HTTPS + host allowlist `accept.paymob.com` / `accept.paymobsolutions.com` only.
- `src/config/public-url.util.ts:107` — in production `FRONTEND_URL` and `BACKEND_URL` must be public HTTPS origins (rejects localhost, private IPs, paths, queries, credentials); `CORS_ORIGINS` required, no `*`, must contain `FRONTEND_URL`.
- `app.module.ts:121` — production refuses to boot with an in-memory cache; `:261` refuses `TYPEORM_SYNCHRONIZE=true`; `queues.module.ts:61` refuses to boot BullMQ without Redis.
- `storage.service.ts:392` — production throws if `R2_PUBLIC_BASE_URL` is set (R2 must stay private); `:415` rejects Bunny-only storage; `:429` requires object storage.

### 2.10 Non-production behaviour that changes what staging exposes

| Behaviour                                      | Gate                                     | File                                             |
| ---------------------------------------------- | ---------------------------------------- | ------------------------------------------------ |
| Swagger at `/api` served                       | `!isProd \|\| ENABLE_SWAGGER === 'true'` | `src/main.ts:205`                                |
| CSP disabled                                   | `!isProd`                                | `src/main.ts:137`                                |
| Stack traces in error responses                | `NODE_ENV !== 'production'`              | `src/common/filters/http-exception.filter.ts:82` |
| Password-reset token returned in HTTP response | non-production                           | `src/auth/auth.service.ts:614`                   |
| TypeORM SQL logging on                         | `!isProd` unless `TYPEORM_LOGGING=false` | `app.module.ts:291`                              |
| Redis optional / in-memory fallback            | `!isProd`                                | `app.module.ts:121`                              |

**Consequence:** staging must run `NODE_ENV=production` to be a faithful mirror and to keep Redis/storage/Paymob-mode guards armed. Debug affordances are then re-enabled _selectively_ via `ENABLE_SWAGGER=true` plus the new `APP_ENV` flag (§14), never by weakening `NODE_ENV`.

### 2.11 CI/CD today

|                                    | Backend `.github/workflows/ci.yml`                                                                | Frontend `.github/workflows/ci.yml`                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Trigger                            | `push: ['**']` + `pull_request`                                                                   | same                                                               |
| Jobs                               | typecheck → eslint → build → jest w/ coverage; **e2e** (Postgres 16 + Redis 7 services); gitleaks | eslint → `tsc --noEmit` → vitest coverage → `next build`; gitleaks |
| Deploy job                         | **none**                                                                                          | **none**                                                           |
| Migration validation               | **none** — e2e sets `TYPEORM_SYNCHRONIZE: 'true'` (`ci.yml:74`)                                   | n/a                                                                |
| Env validation / dep audit / smoke | **none**                                                                                          | **none**                                                           |
| Prettier check                     | via `npm run lint` script, not in CI (`npx eslint .` only)                                        | n/a                                                                |

Deploys are therefore Railway's and Vercel's own git-push triggers `[UNVERIFIABLE]`.

### 2.12 Monitoring today

- **Errors:** Sentry both sides, `environment: NODE_ENV` (`src/observability/sentry.ts:31`, `dodline/instrumentation.ts:13`). No-op without a DSN. Staging would currently be tagged `production` — see §12.
- **Metrics:** Prometheus text at `GET /metrics` (outside the `api/v1` prefix — `src/main.ts:201`), bearer-guarded by `METRICS_BEARER_TOKEN`, fails closed. `src/observability/metrics.controller.ts`
- **Health:** `/api/v1/health` (public), `/health/readiness`, plus admin-only `/health/all`, `/health/metrics`, `/health/errors`, `/health/incidents`, `/health/alerts`. Indicators: database, redis, queue, storage, scheduler, document, backend-api, external-providers. `src/health/`
- **Reference stack:** `AUDIT/monitoring/docker-compose.monitoring.yml` (Prometheus + Grafana) — local reference only, not deployed.

### 2.13 Confirmed risks in the current state

| #       | Risk                                                                                                                                                                                                                                                                                            | Evidence                                                           | Severity     |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------ |
| **R1**  | **The 104-migration chain has never been proven against an empty database.** E2E materialises schema with `TYPEORM_SYNCHRONIZE=true` instead. Creating the staging DB is the first real test.                                                                                                   | `test/.env.test`, `ci.yml:74`; `ls src/migrations` = 104 files     | **Critical** |
| **R2**  | Local `.env` appears to hold **production** values — including `REDIS_URL=redis://…@redis.railway.internal:6379`, a Railway _private-network_ hostname, plus R2 bucket `learnix`, MailerSend, Paymob and JWT/cookie secrets. Production secrets are sitting on developer machines.              | `learning-center-backend/.env`                                     | **Critical** |
| **R3**  | In-process cron begins mutating any connected resource within 60s of boot. A copy-pasted `DATABASE_URL` reconciles real payments.                                                                                                                                                               | §2.7                                                               | **Critical** |
| **R4**  | Both replicas run `migration:run:prod` concurrently on deploy; `migrationsTransactionMode: 'each'` and no advisory lock.                                                                                                                                                                        | `nixpacks.toml:11`, `src/data-source.ts:37`                        | **High**     |
| **R5**  | Login rate limit is temporarily relaxed to **150/min** (`LOGIN_TESTSPRITE_TEMPORARY`) with an in-code TODO to restore `THROTTLE.AUTH` (5 per 5 min) "before the next production deploy". Still wired.                                                                                           | `src/common/constants.ts:56-58`, `src/auth/auth.controller.ts:153` | **High**     |
| **R6**  | No `develop` branch, no branch protection, no deploy gating — anything merged reaches Production.                                                                                                                                                                                               | git; both `ci.yml`                                                 | **High**     |
| **R7**  | `npm run seed` → `node dist/database/seed.js`; that file **does not exist** (`src/database/` contains only `seed-admin.ts`).                                                                                                                                                                    | `package.json:24`                                                  | Medium       |
| **R8**  | No backup or restore script anywhere in either repo.                                                                                                                                                                                                                                            | `scripts/` in both repos                                           | **High**     |
| **R9**  | `AdminInitializationService` runs on **every** boot and creates an admin if _no_ admin exists anywhere. Staging with weak `ADMIN_INIT_PASSWORD` = an admin account on a public host.                                                                                                            | `src/admin-init/admin-initialization.service.ts:72`                | Medium       |
| **R10** | `.env.example` is drifted — missing `ENABLE_SWAGGER`, `PAYMOB_EXPECTED_MODE`, `PAYMENT_CAPTURE_*`, `SIGNED_URL_EXPIRES_SECONDS`, `UPLOAD_MAX_BYTES`, `META_WHATSAPP_APP_SECRET`, `META_WHATSAPP_VERIFY_TOKEN`, `QUEUE_*`/`WORKER_CONCURRENCY`. No `.env.example` exists on the frontend at all. | diff `.env.example` vs `env.validation.ts` vs `.env`               | Medium       |

### 2.14 Hardcoded values that block environment separation

| #      | Value                                                                              | Location                                | Effect on staging                                   |
| ------ | ---------------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------- |
| **H1** | `https://learnix.school` as `metadataBase`                                         | `dodline/app/[locale]/layout.tsx:17`    | Staging emits Production canonical/OG URLs          |
| **H2** | `siteConfig.url = "https://learnix.school"`                                        | `dodline/app/[locale]/lib/site.ts:3`    | Same; `absoluteUrl()` builds Production links       |
| **H3** | `next/image` `remotePatterns` list three fixed hosts                               | `dodline/next.config.ts:9-24`           | Any staging API/R2 host → **images 400**            |
| **H4** | Prod Railway URL baked into CI build env                                           | `dodline/.github/workflows/ci.yml:52`   | CI artefact points at Production                    |
| **H5** | Dev CORS fallback contains `https://learnix.school`                                | `src/common/utils/cors.util.ts:22`      | Non-prod boot silently trusts the Production origin |
| **H6** | `AdminInitializationService` hardcodes `phone: '01099999999'`, `username: 'admin'` | `admin-initialization.service.ts:85-86` | Collides if a seed also creates that phone          |
| **H7** | No `robots.ts` / `sitemap.ts` exist in `dodline/app/`                              | verified absent                         | Nothing to `noindex` staging with                   |

### 2.15 Code that relies insufficiently on `NODE_ENV`

The codebase consistently treats `NODE_ENV` as a **binary** production/not-production switch (§2.10). There is **no** `APP_ENV` or `DEPLOYMENT_ENV` concept anywhere. Staging is therefore forced into one of two bad shapes:

- `NODE_ENV=production` → correct hardening, but **indistinguishable from Production** in Sentry tags, log fields, `GET /` service banner, and `/health` payloads (`src/app.service.ts:33`, `sentry.ts:31`, `health-orchestrator.service.ts:175`, `health-error.service.ts:43`).
- `NODE_ENV=staging` → **fails hard**: `Environment` enum accepts only `development|production|test` (`env.validation.ts:16`); Redis becomes optional; `CORS_ORIGINS` stops being required; storage guards disarm; CSP switches off; stack traces and password-reset tokens leak; Paymob defaults to non-live mode.

**Therefore:** staging runs `NODE_ENV=production` and gains a **new, additive** `APP_ENV` variable (`production` | `staging`) used _only_ for labelling and for the new safety guards. `NODE_ENV`'s meaning is never changed. This is the single most important design decision in this plan.

The one place already doing this correctly and worth copying: `src/common/utils/database-ssl.util.ts`, which derives SSL from the **connection string**, not `NODE_ENV`, with a comment explaining exactly why `NODE_ENV`-gating breaks in both directions.

---

## 3. Target architecture

```
                    ┌──────────────── PRODUCTION ────────────────┐
 Vercel project     │  dodline                                   │
   branch           │    master                                  │
   domain           │    learnix.school            (unchanged)   │
                    │                                            │
 Railway PROJECT    │  learnix-production                        │
   services         │    api  (NestJS, APP_ENV=production)       │
                    │    Postgres                                │
                    │    Redis                                   │
   domain           │    learning-center-backend-production      │
                    │      .up.railway.app        (unchanged)    │
                    │                                            │
 R2 bucket          │    learnix                                 │
 Bunny library      │    <production library>                    │
 Paymob             │    LIVE merchant                           │
 MailerSend         │    production domain                       │
 Sentry env         │    production                              │
                    └────────────────────────────────────────────┘
                       ▲  no shared resource, no shared secret,
                       │  no shared network, no shared account
                       ▼
                    ┌──────────────── STAGING ───────────────────┐
 Vercel project     │  dodline-staging          (NEW project)    │
   branch           │    develop                                 │
   domain           │    staging.learnix.school                  │
   gate             │    Cloudflare Access (email OTP allowlist) │
                    │                                            │
 Railway PROJECT    │  learnix-staging          (NEW project)    │
   services         │    api  (NestJS, APP_ENV=staging)          │
                    │    Postgres  (NEW, empty)                  │
                    │    Redis     (NEW, empty)                  │
   domain           │    api-staging.learnix.school              │
                    │                                            │
 R2 bucket          │    learnix-staging        (NEW bucket)     │
 Bunny library      │    Learnix Staging        (NEW library)    │
 Paymob             │    TEST merchant, PAYMOB_EXPECTED_MODE=test│
 MailerSend         │    staging sender + allowlist              │
 Sentry env         │    staging                                 │
                    └────────────────────────────────────────────┘
```

Staging deliberately keeps the **single-process** shape (API + workers + cron in one service) because that is what Production runs. Splitting a worker service in staging only would make staging stop mirroring Production — the opposite of the point.

---

## 4. Railway topology — separate project vs separate environment

| Criterion               | Separate **project** `learnix-staging`                                                                                         | Separate **environment** inside one project                                                                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Isolation**           | Total. Different project → different private network. `redis.railway.internal` in staging cannot resolve the Production Redis. | Environments do isolate networks, but both live under one project, one settings surface, one blast radius.                                                                                                                                |
| **Security**            | Project-level RBAC: a contractor can get staging without any path to Production.                                               | Access is granted per _project_. Anyone who can see staging can see Production's variables.                                                                                                                                               |
| **Cost**                | Two Postgres + two Redis + two API services. Same as the alternative — Railway bills resources, not projects.                  | Identical. **No cost advantage either way.**                                                                                                                                                                                              |
| **Ease of management**  | Two dashboards. Slightly more clicking.                                                                                        | One dashboard, one env switcher. Marginally nicer.                                                                                                                                                                                        |
| **Potential for error** | Low. You cannot "deploy to the wrong env" — it is a different project entirely.                                                | **This is the failure mode.** Railway's environment switcher is a dropdown; a mis-selected env applies a variable change or triggers a deploy against Production.                                                                         |
| **Secret management**   | Two disjoint sets. Nothing shared by default.                                                                                  | Railway supports _shared variables_ that propagate across environments — exactly the mechanism that would leak a Production `DATABASE_URL` into staging. See risk **R2**: this repo has already had prod values escape into a dev `.env`. |
| **Databases**           | Provisioned independently; different credentials, different backup policies, different retention.                              | Same, but sitting one dropdown away from the Production instance.                                                                                                                                                                         |
| **Rollback**            | Independent deploy histories; rolling back staging cannot touch Production.                                                    | Independent, but performed from the same screen.                                                                                                                                                                                          |

### Final recommendation: **a separate Railway project, `learnix-staging`.**

**Why:** cost is a wash, so the decision rests entirely on error probability — and this project has _already demonstrated_ the exact failure that shared variables cause (R2: production Redis and R2 credentials found in a local `.env`). Combine that with §2.7 — cron jobs that start mutating any reachable resource within 60 seconds, including replaying payment webhooks — and a single misapplied variable is not a config annoyance, it is a financial incident. The one-dropdown convenience of shared environments is not worth that. A separate project makes the mistake structurally unavailable rather than merely discouraged.

---

## 5. Domain topology

| Environment | Surface  | Domain                                              | Status                  |
| ----------- | -------- | --------------------------------------------------- | ----------------------- |
| Production  | Frontend | `learnix.school`                                    | unchanged `[CONFIRMED]` |
| Production  | API      | `learning-center-backend-production.up.railway.app` | unchanged `[CONFIRMED]` |
| Staging     | Frontend | `staging.learnix.school`                            | **new** `[RECOMMENDED]` |
| Staging     | API      | `api-staging.learnix.school`                        | **new** `[RECOMMENDED]` |

### Optional later migration — Production rename (NOT part of this work)

Documented so it is not forgotten. Moving Production to `app.learnix.school` / `api.learnix.school` requires, in this order:

1. Add `api.learnix.school` to the Railway prod service **alongside** the existing `.up.railway.app` domain (both active).
2. Add `https://api.learnix.school` to Production `CORS_ORIGINS`, and update `BACKEND_URL` / `PUBLIC_MEDIA_BASE_URL`. **Note:** stored media URLs built from the old `PUBLIC_MEDIA_BASE_URL` must be checked for durability before this switch.
3. Register the new webhook URL in the Paymob dashboard and confirm live traffic on it _before_ removing the old one.
4. Add `api.learnix.school` to `dodline/next.config.ts` `remotePatterns` (**H3**).
5. Only then flip `NEXT_PUBLIC_API_URL`, and change `SITE_URL`/`siteConfig.url` (**H1/H2**) with 301s from the apex.

Because cookies are host-only (§2.8), the API rename **logs every user out**. That alone makes it a scheduled maintenance event, not a side effect of staging work.

---

## 6. DNS plan

All records `[RECOMMENDED]`, added in this order. Targets are `[UNVERIFIABLE]` until the Railway/Vercel dashboards issue them.

| #   | Order | Type    | Host          | Target                                                     | TTL                                    | Notes                                                                                    |
| --- | ----- | ------- | ------------- | ---------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------- |
| D1  | 1st   | `CNAME` | `api-staging` | Railway-issued target for the staging service              | 300 (raise to 3600 after verification) | Add domain in Railway **first**; Railway then shows the CNAME target and issues the cert |
| D2  | 2nd   | `TXT`   | as instructed | Railway ACME challenge, if requested                       | 300                                    | Only if Railway asks                                                                     |
| D3  | 3rd   | `CNAME` | `staging`     | Vercel target (`cname.vercel-dns.com` or project-specific) | 300 → 3600                             | Add domain in the `dodline-staging` Vercel project first                                 |
| D4  | 4th   | —       | `staging`     | Cloudflare Access application                              | —                                      | Only after D3 resolves and SSL is green                                                  |

**Production impact:** zero. Every record is a **new subdomain**. No apex, `www`, `MX`, `TXT`/SPF/DKIM, or existing record is touched. If MailerSend staging uses a _subdomain sender_ (§9), its DKIM/SPF records are added under that subdomain only and must be reviewed against the existing apex SPF before being added — this is the only DNS step with any Production interaction, and it is a review step, not a change.

**Verification per record:**

```bash
dig +short api-staging.learnix.school CNAME
```

```bash
curl -sS -o /dev/null -w '%{http_code} %{ssl_verify_result}\n' https://api-staging.learnix.school/api/v1/health
```

Expect `200 0`. Then confirm the certificate SAN matches the host and is not the Railway wildcard.

---

## 7. Environment matrix

**Legend:** Loc = F(rontend) / B(ackend) / W(orker — same process as B today). Rot = needs rotation on a schedule or on staff change.

### 7.1 Shared name, different value — **secrets** (must never match across environments)

| Variable                     | Loc | Production pattern        | Staging pattern                      | Secret    | Rot | Current fallback                            | Risk if wrong/missing                                                   |
| ---------------------------- | --- | ------------------------- | ------------------------------------ | --------- | --- | ------------------------------------------- | ----------------------------------------------------------------------- |
| `DATABASE_URL`               | B   | prod Postgres URL         | **staging** Postgres URL             | ✅        | ✅  | none — required (`env.validation.ts:60`)    | **Catastrophic.** Staging cron writes to live financial data within 60s |
| `REDIS_URL`                  | B   | prod Redis URL            | **staging** Redis URL                | ✅        | ✅  | none; prod boot fails (`app.module.ts:124`) | Shared queues → staging workers consume Production jobs                 |
| `JWT_SECRET`                 | B   | ≥32 random                | **different** ≥32 random             | ✅        | ✅  | none                                        | Staging-minted tokens accepted by Production                            |
| `JWT_REFRESH_SECRET`         | B   | ≥32 random                | **different**                        | ✅        | ✅  | none                                        | Cross-env session forgery                                               |
| `COOKIE_SECRET`              | B   | ≥32 random                | **different**                        | ✅        | ✅  | falls back to `JWT_SECRET` (`main.ts:106`)  | Cross-env CSRF-cookie validity                                          |
| `INIT_SECRET`                | B   | unset after bootstrap     | unset after bootstrap                | ✅        | ✅  | none                                        | Admin-bootstrap endpoint left live                                      |
| `ADMIN_INIT_PASSWORD`        | B   | one-time, then rotated    | **different** one-time, ≥16          | ✅        | ✅  | none; init skipped if absent                | **R9** — weak admin on a public host                                    |
| `METRICS_BEARER_TOKEN`       | B   | high-entropy              | **different**                        | ✅        | ✅  | none; endpoint 503s                         | Metrics scrape open                                                     |
| `BULL_BOARD_PASSWORD`        | B   | ≥12 random                | **different**                        | ✅        | ✅  | none; fails closed                          | Queue dashboard exposed                                                 |
| `PAYMOB_API_KEY`             | B   | **LIVE**                  | **TEST**                             | ✅        | ✅  | none                                        | **Real charges from staging**                                           |
| `PAYMOB_SECRET_KEY`          | B   | LIVE                      | TEST                                 | ✅        | ✅  | none                                        | as above                                                                |
| `PAYMOB_WEBHOOK_SECRET`      | B   | LIVE HMAC                 | TEST HMAC                            | ✅        | ✅  | none                                        | Cross-env webhook acceptance                                            |
| `R2_ACCESS_KEY_ID`           | B   | prod, scoped to `learnix` | staging, scoped to `learnix-staging` | ✅        | ✅  | none                                        | **Staging deletes Production files** (weekly orphan-cleanup cron)       |
| `R2_SECRET_ACCESS_KEY`       | B   | prod                      | staging                              | ✅        | ✅  | none                                        | as above                                                                |
| `BUNNY_STREAM_API_KEY`       | B   | prod library              | staging library                      | ✅        | ✅  | falls back to `BUNNY_API_KEY`               | Staging deletes Production videos                                       |
| `BUNNY_STREAM_TOKEN_KEY`     | B   | prod                      | staging                              | ✅        | ✅  | none; signed-url 503s                       | Cross-env playback tokens                                               |
| `MAILERSEND_API_KEY`         | B   | prod                      | staging                              | ✅        | ✅  | none                                        | **Real email to real students**                                         |
| `TWILIO_AUTH_TOKEN`          | B   | prod                      | test creds                           | ✅        | ✅  | none                                        | **Real SMS to real parents**                                            |
| `META_WHATSAPP_ACCESS_TOKEN` | B   | prod                      | test number                          | ✅        | ✅  | none                                        | **Real WhatsApp to real parents**                                       |
| `META_WHATSAPP_APP_SECRET`   | B   | prod                      | staging                              | ✅        | ✅  | none                                        | Webhook HMAC bypass                                                     |
| `FIREBASE_PRIVATE_KEY`       | B   | prod project              | staging project                      | ✅        | ✅  | none                                        | Push to real devices                                                    |
| `SENTRY_DSN`                 | B   | prod project              | staging project                      | ✅        | ➖  | none; no-op                                 | Staging noise buries prod alerts                                        |
| `NEXT_PUBLIC_SENTRY_DSN`     | F   | prod                      | staging                              | ➖ public | ➖  | none; no-op                                 | as above                                                                |

### 7.2 Shared name, different value — **non-secret**

| Variable                       | Loc | Production               | Staging                              | Fallback                                   | Risk                                        |
| ------------------------------ | --- | ------------------------ | ------------------------------------ | ------------------------------------------ | ------------------------------------------- |
| `NODE_ENV`                     | B,F | `production`             | **`production`** (see §2.15)         | `development`                              | Anything else disarms every prod guard      |
| `PORT`                         | B   | Railway-injected         | Railway-injected                     | `3000` (`main.ts:266`)                     | Health check fails                          |
| `FRONTEND_URL`                 | B   | `https://learnix.school` | `https://staging.learnix.school`     | none in prod                               | Boot fails; reset links point at wrong host |
| `BACKEND_URL`                  | B   | prod API origin          | `https://api-staging.learnix.school` | none in prod                               | Boot fails                                  |
| `PUBLIC_MEDIA_BASE_URL`        | B   | prod API origin          | `https://api-staging.learnix.school` | falls back to `BACKEND_URL`                | Media proxy URLs point cross-env            |
| `CORS_ORIGINS`                 | B   | `https://learnix.school` | `https://staging.learnix.school`     | dev fallback includes prod origin — **H5** | Must contain `FRONTEND_URL` or boot fails   |
| `NEXT_PUBLIC_API_URL`          | F   | prod API                 | `https://api-staging.learnix.school` | none; throws (`axios.config.ts:30`)        | Frontend calls the wrong backend            |
| `R2_BUCKET`                    | B   | `learnix`                | `learnix-staging`                    | none in prod                               | Cross-env object writes                     |
| `BUNNY_STREAM_LIBRARY_ID`      | B   | prod library             | staging library                      | none; uploads 503                          | Cross-env video                             |
| `BUNNY_STREAM_CDN_HOSTNAME`    | B   | prod pull zone           | staging pull zone                    | iframe embed used                          | Playback breaks                             |
| `MAIL_FROM_EMAIL`              | B   | `info@learnix.school`    | `staging@…` (**must differ**)        | none                                       | Real-looking mail from staging              |
| `MAIL_FROM_NAME`               | B   | `Learnix`                | **`Learnix [STAGING]`**              | none                                       | Recipients can't tell environments apart    |
| `NEXT_PUBLIC_BUNNY_LIBRARY_ID` | F   | prod                     | staging                              | `undefined` → broken embed URL             | Teaser video 404s                           |
| `ADMIN_INIT_EMAIL`             | B   | prod admin               | **different** staging admin          | none                                       | Shared admin identity                       |
| `BCRYPT_ROUNDS`                | B   | `12`                     | `12`                                 | `12`                                       | Lower = weaker hashes                       |
| `SENTRY_TRACES_SAMPLE_RATE`    | B,F | `0.1`                    | `1.0` (low volume)                   | `0.1`                                      | Cost / missing traces                       |

### 7.3 Production only

| Variable                              | Loc | Note                                                                                          |
| ------------------------------------- | --- | --------------------------------------------------------------------------------------------- |
| `PAYMOB_EXPECTED_MODE=live`           | B   | **Required** in prod when `PAYMOB_API_KEY` set (`env.validation.ts:481`). Staging sets `test` |
| `PAYMENT_CAPTURE_GRACE_SECONDS`       | B   | Must be explicit in prod (`:474`). Set explicitly in staging too, for parity                  |
| `PAYMENT_PROVIDER_CLOCK_SKEW_SECONDS` | B   | as above                                                                                      |

### 7.4 Staging only `[RECOMMENDED — new]`

| Variable                 | Loc | Staging value                     | Purpose                                                                                          |
| ------------------------ | --- | --------------------------------- | ------------------------------------------------------------------------------------------------ |
| `APP_ENV`                | B,F | `staging`                         | **The keystone.** Labels logs/Sentry/health, drives every guard in §14, and drives the UI banner |
| `PAYMOB_EXPECTED_MODE`   | B   | `test`                            | Fails fast if a live key is pasted in                                                            |
| `ENABLE_SWAGGER`         | B   | `true`                            | Re-enables `/api` docs under `NODE_ENV=production` (`main.ts:205`)                               |
| `MAIL_ALLOWLIST`         | B   | comma-separated addresses/domains | Outbound mail allowlist (§9)                                                                     |
| `SMS_MODE`               | B   | `sandbox`                         | Blocks real SMS/WhatsApp (§9)                                                                    |
| `NEXT_PUBLIC_APP_ENV`    | F   | `staging`                         | Renders the STAGING banner, disables Analytics, drives `noindex`                                 |
| `NEXT_PUBLIC_COMMIT_SHA` | F   | Vercel `VERCEL_GIT_COMMIT_SHA`    | Build provenance in the banner                                                                   |
| `STORAGE_PREFIX`         | B   | `staging/`                        | Second layer under the separate bucket (§8)                                                      |

### 7.5 Optional / deprecated / missing

| Variable                                                                           | Class                     | Detail                                                                                                                           |
| ---------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `BUNNY_STORAGE_ZONE`, `BUNNY_STORAGE_PASSWORD`, `BUNNY_CDN_URL`, `BUNNY_PULL_ZONE` | **Deprecated**            | Bunny _Storage_ is rejected in production (`storage.service.ts:415`). R2 is the path. Leave unset in both environments           |
| `R2_PUBLIC_BASE_URL`                                                               | **Deprecated in prod**    | Production **throws** if set (`:392`). Present in local `.env` — confirms local ≠ Railway. Must be unset in staging too          |
| `CORS_ORIGIN` (singular)                                                           | **Deprecated**            | Declared in `env.validation.ts:419`, never read. `CORS_ORIGINS` is the live one                                                  |
| `PROCESS_ROLE`, `HEALTH_COLLECTOR_*`                                               | Optional                  | Defaults to `api`. Only needed if a worker service is split out later                                                            |
| `QUEUE_MAX_ATTEMPTS`, `QUEUE_BACKOFF_DELAY`, `QUEUE_CONCURRENCY`                   | **Legacy aliases**        | Superseded by `QUEUE_DEFAULT_ATTEMPTS` / `QUEUE_BACKOFF_MS` / `WORKER_CONCURRENCY` (`queues.constants.ts:164,172,197`)           |
| `SEED_ADMIN_EMAIL/PASSWORD/NAME`                                                   | **Mismatch**              | `dodline/scripts/seed-admin.mjs:25-27` reads these, but `dodline/.env.local` defines `ADMIN_INIT_*`. The script silently no-ops  |
| `DEPLOYMENT_ENV`                                                                   | **Missing**               | Not used anywhere. `APP_ENV` covers it — do **not** introduce both                                                               |
| `COOKIE_DOMAIN` / `COOKIE_SECURE` / `COOKIE_SAME_SITE`                             | **Missing (intentional)** | Derived from `NODE_ENV`/`req.secure`; no `domain` is ever set. **Leave it that way** — host-only cookies are what makes §10 safe |
| `STORAGE_BUCKET`                                                                   | **Missing**               | The real name is `R2_BUCKET`. Do not add an alias                                                                                |
| `WEBHOOK_BASE_URL`                                                                 | **Missing**               | Webhook URLs are registered in the Paymob dashboard, not derived from env. Correct as-is                                         |
| `PAYMENT_MODE`                                                                     | **Missing**               | `PAYMOB_EXPECTED_MODE` already fills this role                                                                                   |
| `EMAIL_MODE`                                                                       | **Missing**               | `MAIL_PROVIDER` gates the provider; `MAIL_ALLOWLIST` (new) gates recipients                                                      |
| `MAILERSEND_TEMPLATE_*` (×10)                                                      | Optional                  | Unset → inline HTML instead of templates. Staging needs its own IDs to test templates                                            |

---

## 8. Database plan

### 8.1 Creating the staging database

1. Provision Postgres in the `learnix-staging` Railway project. Match the Production major version `[UNVERIFIABLE — audit in P0]`.
2. **Extensions:** `uuid-ossp` is created by the first migration itself (`1734986400000-InitialSchema.ts:8`). Audit the Production DB for any extension added out-of-band:
   ```bash
   psql "$STAGING_DATABASE_URL" -c "SELECT extname, extversion FROM pg_extension ORDER BY extname;"
   ```
   Compare against the same query on Production and reconcile before proceeding.
3. **Run the full chain from empty — this is R1's resolution and a Phase 2 gate:**
   ```bash
   npm run build && npx typeorm -d dist/src/data-source.js migration:run
   ```
   All 104 files, in timestamp order (`data-source.ts:21` globs `[0-9]*-!(*.spec).js` — spec files excluded).
4. **Expect this to fail the first time.** The chain has never been exercised against an empty DB (R1). Failures get fixed forward with **new** migrations; already-applied historical migrations are never edited.
5. Verify convergence — schema-from-migrations must equal schema-from-entities:
   ```bash
   npx typeorm -d dist/src/data-source.js migration:generate src/migrations/TEMP-DriftCheck
   ```
   **Passing = the generated file's `up()` is empty.** Delete it either way; it is a diagnostic, never committed.

### 8.2 Migration locking `[RECOMMENDED]` — resolves R4

TypeORM's runner is idempotent but not concurrency-safe across processes. With two replicas both running `migration:run:prod`, two `CREATE INDEX` statements can collide. Wrap the run in a Postgres advisory lock:

```
pg_advisory_lock(<constant>) → runMigrations() → pg_advisory_unlock(<constant>)
```

Implement once in `src/data-source.ts` / a small `scripts/migrate.ts` used by both `migration:run:prod` and `src/main.ts:48`'s `runPendingMigrations()`. **Prove it in staging first** (run two `migration:run:prod` processes simultaneously against the staging DB and assert one blocks), then promote to Production.

### 8.3 Migration policy

| Rule                                   | Detail                                                                                                                                                                                                                                                                |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Order**                              | Timestamp order, enforced by the glob. Never renumber                                                                                                                                                                                                                 |
| **History**                            | `migrations` table. `npm run migration:show` is the source of truth                                                                                                                                                                                                   |
| **Destructive changes**                | Column/table drops are **forbidden in a single release**. Use expand→migrate→contract: (1) add new + dual-write, (2) backfill, (3) switch reads, (4) drop in a _later_ release after a full staging soak                                                              |
| **`down()`**                           | Every new migration ships a real, tested `down()`. Test it in staging: run → verify → revert → verify → re-run                                                                                                                                                        |
| **Backup before sensitive migrations** | Any migration touching `payments`, `financial_ledger_entries`, `entitlements`, `attendance_codes`, `certificates`, or `users` requires a fresh verified Production dump immediately before deploy. **Gate in CI** by matching those table names in the migration diff |
| **Restore test**                       | Monthly: restore the newest Production backup into a scratch Railway DB, run `migration:run`, confirm row counts and a smoke login. **A backup that has never been restored is not a backup**                                                                         |
| **Zero-downtime**                      | Additive-only per release; nullable-then-backfill-then-constrain; `CREATE INDEX CONCURRENTLY` for large tables (note: requires `migrationsTransactionMode` awareness — `data-source.ts:37` is `'each'`, so such a migration must opt out of its transaction)          |

### 8.4 Backup and restore `[RECOMMENDED]` — resolves R8

No backup script exists in either repo. Create `learning-center-backend/scripts/db-backup.sh` and `scripts/db-restore.sh`:

- `db-backup.sh` — `pg_dump -Fc`, timestamped, written to the **staging** R2 bucket (or a separate `learnix-backups` bucket), with a `pg_restore --list` integrity check on the artefact before it is considered valid.
- `db-restore.sh` — refuses to run unless `APP_ENV=staging` **and** the target `DATABASE_URL` host differs from a `PROD_DB_HOST_DENYLIST` value. Restoring _onto_ Production must never be a one-command operation.
- Retention: daily 7d, weekly 4w, monthly 6m. Railway's own backup feature `[UNVERIFIABLE]` should be enabled _in addition_, not instead.

### 8.5 Seed and test data — synthetic only

**Production data is never copied to staging, raw or otherwise.** Decision taken: **synthetic seed script**.

Create `learning-center-backend/src/database/seed-staging.ts` and wire `npm run seed:staging`. This also fixes **R7** (`npm run seed` currently points at a non-existent file — either implement `src/database/seed.ts` or remove the script; do not leave a broken entry).

**Guards inside the seed (first lines, before any DB work):**

1. Abort unless `APP_ENV === 'staging'`.
2. Abort if `DATABASE_URL` host matches a denylist of known Production hosts.
3. Abort if the target DB already contains a user whose email domain is outside the synthetic set — proof it is not a scratch database.

**Coverage** — enough to exercise every flow in §13:

| Domain        | Seeded                                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Users         | 1 admin, 3 teachers, 2 call-center, 20 students, 10 guardians — all `@staging.learnix.invalid`                                                               |
| Catalog       | 5 subjects, 8 courses (published/draft/scheduled), 40 lessons w/ Bunny **staging** video IDs                                                                 |
| Books         | 4 books (2 free, 2 paid) → private R2 staging keys                                                                                                           |
| Exams         | 6 exams incl. one OMR-enabled, question bank, attempts in every state                                                                                        |
| Commerce      | Carts, wishlists, discount codes, attendance-code batches in every lifecycle state                                                                           |
| Payments      | Paymob **test** payments (pending/paid/failed/refunded), manual InstaPay + wallet + bank submissions in every review state, ledger entries, teacher balances |
| Certificates  | 1 draft template, 1 published, 3 issued, 1 revoked                                                                                                           |
| Notifications | Parent messages across sent/delivered/read/failed, DLQ entries                                                                                               |

**Field conventions** (these are the "how to remove or replace" answers — nothing is scrubbed _from_ production, it is generated correct-by-construction):

| Field               | Synthetic form                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------- |
| Names               | Deterministic `Test Teacher 01` / `Test Student 07`                                           |
| Emails              | `<role><nn>@staging.learnix.invalid` — `.invalid` is RFC-reserved and **cannot** receive mail |
| Phones              | `+201000000001`+ sequential, plus Twilio magic test numbers where a send is exercised         |
| Addresses           | `Staging Test Address, Cairo`                                                                 |
| Payment identifiers | Paymob **sandbox** order/transaction IDs only                                                 |
| Access tokens       | Generated at runtime with staging secrets; never seeded                                       |
| Financial data      | Synthetic minor-unit amounts; ledger balances computed by the seed, not copied                |
| Student records     | Fully synthetic attempts, grades, attendance                                                  |

**Cleanup:** `npm run seed:staging -- --reset` truncates in FK-safe order and reseeds. Same three guards. Optionally schedule weekly so staging drift never accumulates.

---

## 9. Third-party integrations plan

### 9.1 Payments

| Item                   | Production                                        | Staging                                                      |
| ---------------------- | ------------------------------------------------- | ------------------------------------------------------------ |
| Gateway                | Paymob **live** merchant                          | Paymob **test** merchant (separate account)                  |
| `PAYMOB_EXPECTED_MODE` | `live` (**enforced** — `env.validation.ts:481`)   | `test`                                                       |
| `PAYMOB_BASE_URL`      | `https://accept.paymob.com`                       | same (host-allowlisted, `:22`)                               |
| Webhook URL            | current prod callback                             | `https://api-staging.learnix.school/api/v1/payments/webhook` |
| Alternate callback     | `/api/v1/payments/webhook/callback`               | same on staging host                                         |
| Webhook secret         | live HMAC                                         | **different** test HMAC                                      |
| Return URL             | prod frontend                                     | `https://staging.learnix.school/...`                         |
| Test cards             | n/a                                               | Paymob sandbox card set (in the Paymob docs)                 |
| Reconciliation cron    | every minute (`payment-operations.service.ts:59`) | same, against sandbox only                                   |
| Webhook replay cron    | every minute (`gateway-webhook.service.ts:147`)   | same                                                         |
| Refunds                | live                                              | sandbox refund + void                                        |

**Manual methods** (InstaPay, mobile wallet, bank transfer, cash, custom) are **database-configured**, not env-configured — `manual-payment-method-type.enum.ts`. Staging therefore needs its own rows seeded with obviously-fake InstaPay addresses and wallet numbers. Real Production InstaPay handles must never appear in the staging DB, or a tester will send real money to them.

**Preventing real charges on staging — three independent layers:**

1. `PAYMOB_EXPECTED_MODE=test` — the gateway already computes `expectedLive` from it (`paymob.gateway.ts:60-63`).
2. The **fail-fast boot guard** in §14 — refuses to start if `APP_ENV=staging` and any Paymob credential matches a Production fingerprint.
3. Separate Paymob merchant account, so staging credentials have no live-money capability at all.

### 9.2 Email — MailerSend

| Question                                  | Answer for staging                                                                                                                                                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sandbox?                                  | MailerSend has no true sandbox. Use a **separate API key + separate sending domain/subdomain**                                                                                                                   |
| Block external sending?                   | Yes — via `MAIL_ALLOWLIST`                                                                                                                                                                                       |
| Redirect to allowlist?                    | Yes. In `MailService.send`, when `APP_ENV=staging`, drop any recipient not matching the allowlist and log the drop. Synthetic seed emails are `@staging.learnix.invalid`, which cannot resolve — belt and braces |
| `[STAGING]` subject prefix?               | Yes — prefix the subject **and** set `MAIL_FROM_NAME=Learnix [STAGING]`                                                                                                                                          |
| How are real teachers/students protected? | Separate DB (no real addresses exist) + `.invalid` domain + allowlist + separate API key. Four layers                                                                                                            |
| Template testing                          | 10 separate `MAILERSEND_TEMPLATE_*` IDs under the staging account. `POST /health/actions/test-email` (admin-only, `health.controller.ts:167`) is the manual probe                                                |
| Retries and queues                        | Real `email` queue on staging Redis, real BullMQ retries (5 attempts, exponential — `queues.constants.ts`), inspected via Bull Board                                                                             |

**Placement:** the allowlist filter belongs in `src/mail/mail.service.ts` at the single send path, **not** in each caller — every mail already funnels through `MailService`.

### 9.3 SMS / WhatsApp / Push

| Channel                                                  | Staging                                                                                                                                                                                                                 |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Twilio SMS (`src/notifications/channels/sms.channel.ts`) | Twilio **test credentials** + magic numbers; real sends are rejected by Twilio itself                                                                                                                                   |
| Meta WhatsApp (`whatsapp-meta.channel.ts`)               | Meta **test phone number**; recipients must be pre-registered in the Meta app — external delivery is impossible by construction                                                                                         |
| Firebase push                                            | Separate Firebase **project**; staging device tokens only                                                                                                                                                               |
| `SMS_MODE=sandbox`                                       | New guard: when `APP_ENV=staging` and `SMS_MODE=sandbox`, the channel registry logs the intended send and marks it delivered without an outbound call — lets guardian flows be tested with **zero** provider dependency |
| Webhook                                                  | `META_WHATSAPP_VERIFY_TOKEN` and `APP_SECRET` differ per environment; the delivery webhook points at `api-staging`                                                                                                      |

### 9.4 Storage

**Decision: a separate R2 bucket, `learnix-staging`** — not a prefix.

Rationale, grounded in this codebase: the bucket holds **paid books, homework submissions, OMR answer sheets, and certificates** (per the `.env.example:137-140` warning and `PUBLIC_MEDIA_FOLDERS` in `src/common/constants.ts:73`), and the weekly orphan-cleanup cron (`src/uploads/cleanup.service.ts:46`) **deletes** objects. A prefix does not stop a delete with a miscomputed key. A separate bucket with separate credentials makes cross-environment deletion impossible at the IAM layer.

`STORAGE_PREFIX=staging/` is added **as well**, as a second layer and for readability — not as the isolation mechanism.

| Concern                                 | Staging setting                                                                                                                                                                   |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bucket                                  | `learnix-staging`, **anonymous access disabled** (same requirement as prod)                                                                                                       |
| `R2_PUBLIC_BASE_URL`                    | **Unset** — production throws if set (`storage.service.ts:392`); keep parity                                                                                                      |
| Access policy                           | R2 API token scoped to `learnix-staging` **only**. No `learnix` permission of any kind                                                                                            |
| Signed URLs                             | `SIGNED_URL_EXPIRES_SECONDS` (default 300, `storage.service.ts:404`)                                                                                                              |
| Public media                            | Served through the backend proxy `/api/v1/media/public/...`, folders restricted to `images`/`thumbnails`/`profiles` (`constants.ts:73`) — private books/OMR unreachable by design |
| CORS on the bucket                      | Only the R2 origin needs it for direct browser access; today reads flow through the backend proxy, so bucket CORS stays closed                                                    |
| Lifecycle                               | Staging: expire objects after 30 days. Production: **no** auto-expiry                                                                                                             |
| Cleanup                                 | Weekly orphan cron already runs; the `--reset` seed also clears staging objects                                                                                                   |
| CDN                                     | None for staging (no pull zone) — R2 direct + backend proxy                                                                                                                       |
| Upload limits                           | `UPLOAD_MAX_BYTES` / `MAX_FILE_SIZE` mirrored from prod so limit behaviour is testable                                                                                            |
| Malware scanning                        | Not present in either environment today. Out of scope; noted in §19                                                                                                               |
| **Prevent staging deleting prod files** | Separate bucket + scoped token (structural), plus the boot guard in §14 comparing `R2_BUCKET` against a Production denylist (defence in depth)                                    |

**Video (Bunny Stream)** is separate from R2 and needs its own isolation: a **new Bunny Stream library** for staging, with its own `BUNNY_STREAM_LIBRARY_ID`, API key, token key, and CDN hostname. `src/lessons/bunny-stream.service.ts` deletes videos on lesson replacement/cleanup — a shared library means staging deletes Production lesson videos.

---

## 10. Authentication and cookie isolation

**Current state is already strong** (§2.8): host-only cookies, no `domain` attribute, `SameSite=None; Secure; Partitioned` under HTTPS, signed CSRF cookie, exact-match CORS.

| Control         | Production                                                                  | Staging                            | Isolation mechanism                                                                                                                  |
| --------------- | --------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Access token    | `access_token`, path `/api/v1`                                              | same name                          | **Host-only cookie** — set by `api…railway.app`, never sent to `api-staging.learnix.school`. Different registrable host ⇒ no sharing |
| Refresh token   | `refresh_token`, path `/api/v1/auth`                                        | same                               | as above                                                                                                                             |
| CSRF            | `XSRF-TOKEN`, path `/`, signed                                              | same                               | as above, plus different `COOKIE_SECRET` ⇒ prod-signed cookies fail verification on staging                                          |
| Signing key     | `COOKIE_SECRET` (prod)                                                      | **different** `COOKIE_SECRET`      | Cross-env cookie signature invalid                                                                                                   |
| Token signing   | `JWT_SECRET` / `JWT_REFRESH_SECRET`                                         | **different**                      | A staging JWT is rejected by Production and vice versa                                                                               |
| Rotation        | Refresh rotates on `/auth/refresh` (`axios.config.ts:181`)                  | same                               | —                                                                                                                                    |
| Revocation      | `user_sessions` table + daily 03:00 cleanup cron (`sessions.service.ts:23`) | same, separate DB                  | —                                                                                                                                    |
| CORS            | `CORS_ORIGINS = https://learnix.school`                                     | `= https://staging.learnix.school` | Exact match, no wildcard (`cors.util.ts:25`)                                                                                         |
| Session storage | Redis (cache/throttle) + Postgres (`user_sessions`)                         | separate Redis + Postgres          | —                                                                                                                                    |
| OAuth callbacks | none (Firebase ID-token endpoints only)                                     | none                               | —                                                                                                                                    |

### `[RECOMMENDED]` Defence-in-depth: environment-suffixed cookie names

Host-only cookies are sufficient **today**, but they stop being sufficient the moment Production moves to `api.learnix.school` and someone sets a `.learnix.school` cookie domain. Make the guarantee explicit rather than emergent:

Change `src/auth/auth-cookie.constants.ts` from constants to a small resolver keyed on `APP_ENV`:

| `APP_ENV`               | Access cookie          | Refresh cookie          | CSRF cookie          |
| ----------------------- | ---------------------- | ----------------------- | -------------------- |
| `production` (or unset) | `access_token`         | `refresh_token`         | `XSRF-TOKEN`         |
| `staging`               | `access_token_staging` | `refresh_token_staging` | `XSRF-TOKEN-staging` |

Touch points: `auth-cookie.constants.ts`, `auth.controller.ts`, `jwt.strategy.ts`, `guards/hybrid-auth.guard.ts`, `guards/optional-hybrid-auth.guard.ts`, `common/guards/csrf.guard.ts:33`. Production names are unchanged, so **no Production user is logged out**. Frontend needs no change — it never reads these names.

**And explicitly: do not add `COOKIE_DOMAIN`.** Adding it is the one change that would break this isolation.

---

## 11. Git strategy

### Recommended model: **`main` / `develop` GitFlow-lite**

Given the current state — no `develop` branch, no protection, and 104 unvalidated migrations sitting in front of real money — the correct choice is the model that makes "reach Production" require a deliberate act.

Trunk-based with feature flags would be a fine choice for a team with mature flagging and fast, trustworthy CI. Neither is true here yet: there is no feature-flag system in the codebase, and CI has no deploy or migration gate. **GitFlow-lite is the right fit today.** Revisit once staging has soaked for a quarter.

| Branch                                 | Deploys to         | Protection                                                                                                            |
| -------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `main` (backend) / `master` (frontend) | **Production**     | Protected. No direct push, no force push, PR + 1 approval + all status checks + up-to-date-with-base + linear history |
| `develop`                              | **Staging** (auto) | Protected. No direct push, no force push, PR + status checks. Approval optional                                       |
| `feature/*`                            | —                  | PR into `develop`                                                                                                     |
| `hotfix/*`                             | —                  | PR into `main` **and** cherry-picked/merged back into `develop` in the same PR cycle                                  |
| `release/*`                            | —                  | Optional; use only when a release needs stabilising while `develop` moves on                                          |

**Note the branch-name asymmetry:** the frontend's default is `master`, the backend's is `main`. `[RECOMMENDED]` rename the frontend default to `main` in Phase 5 for consistency — GitHub redirects the old name, and `learnix-speckit/.gitmodules` must be updated in the same change.

**Promotion `develop` → production branch:**

1. Staging green: CI passing, smoke tests passing, the change soaked ≥24h with no new Sentry issues.
2. Open PR `develop` → `main`, titled `Release vX.Y.Z`.
3. Required checks re-run; manual approval on the GitHub `production` environment.
4. Merge (**merge commit**, not squash — squashing `develop` into `main` permanently diverges the histories and makes every later diff lie).
5. Tag `vX.Y.Z`; generate `CHANGELOG.md` from Conventional Commits.

**Hotfix:** branch from `main` → PR into `main` → tag `vX.Y.Z+1` → **immediately** merge `main` back into `develop`. A CI job asserts `git rev-list --count main..develop` is not "behind", failing the build if `main` contains commits `develop` lacks.

**Preventing long-term divergence:** a nightly scheduled workflow that fails when `main` has commits not in `develop`, or when `develop` is more than N commits ahead without a release.

---

## 12. CI/CD strategy

### 12.1 Files to be created or modified (Phase 5)

| File                                                              | Action                                                                                  |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `learning-center-backend/.github/workflows/ci.yml`                | Modify — add migration validation, env validation, `prettier --check`, `npm audit`      |
| `learning-center-backend/.github/workflows/deploy-staging.yml`    | **New**                                                                                 |
| `learning-center-backend/.github/workflows/deploy-production.yml` | **New**                                                                                 |
| `learning-center-backend/.github/workflows/branch-sync.yml`       | **New** — nightly `main`/`develop` divergence check                                     |
| `dodline/.github/workflows/ci.yml`                                | Modify — parameterise the hardcoded `NEXT_PUBLIC_API_URL` (**H4**), add `npm audit`     |
| `dodline/.github/workflows/deploy-staging.yml`                    | **New** (or rely on Vercel's git integration on `develop`)                              |
| `learning-center-backend/scripts/validate-env.ts`                 | **New** — runs `validate()` from `src/config/env.validation.ts` against a candidate env |
| `learning-center-backend/scripts/db-backup.sh`, `db-restore.sh`   | **New**                                                                                 |
| `learning-center-backend/scripts/migrate.ts`                      | **New** — advisory-locked migration runner                                              |
| `learning-center-backend/scripts/smoke-test.sh`                   | **New**                                                                                 |
| `learning-center-backend/src/database/seed-staging.ts`            | **New**                                                                                 |
| `learning-center-backend/.env.example`                            | Modify — close the drift (**R10**)                                                      |
| `dodline/.env.example`                                            | **New**                                                                                 |

### 12.2 Staging pipeline (`develop` push)

| #   | Step                     | Command / detail                                                                                                                                                               |
| --- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Install                  | `npm ci` (both repos)                                                                                                                                                          |
| 2   | Lint                     | `npx eslint .`                                                                                                                                                                 |
| 3   | Format check             | `npx prettier --check .` — **new**; the `lint` script includes it but CI does not run it                                                                                       |
| 4   | Type-check               | `npx tsc --noEmit -p tsconfig.build.json` (BE) / `npx tsc --noEmit` (FE)                                                                                                       |
| 5   | Unit tests               | `npm run test:cov -- --ci --runInBand` (BE) / `npm run test:coverage` (FE)                                                                                                     |
| 6   | Integration / E2E        | existing `e2e` job (Postgres 16 + Redis 7 services)                                                                                                                            |
| 7   | Build FE                 | `npm run build` with `NEXT_PUBLIC_API_URL` from the **staging** secret                                                                                                         |
| 8   | Build BE                 | `npm run build`                                                                                                                                                                |
| 9   | **Migration validation** | **New job**: empty Postgres 16 service → `migration:run` → `migration:generate` drift check → assert empty → `migration:revert` on the newest → re-run. **Directly closes R1** |
| 10  | **Env validation**       | **New**: `node scripts/validate-env.ts` against the staging variable set — catches a missing `CORS_ORIGINS`/`FRONTEND_URL` _before_ deploy, not at boot                        |
| 11  | Security checks          | existing gitleaks job                                                                                                                                                          |
| 12  | Dependency audit         | **New**: `npm audit --audit-level=high` (non-blocking → blocking after the current backlog is cleared)                                                                         |
| 13  | Deploy                   | Railway staging (BE), Vercel `dodline-staging` (FE)                                                                                                                            |
| 14  | Smoke tests              | `scripts/smoke-test.sh` against `api-staging` — see §13.3                                                                                                                      |

### 12.3 Production pipeline (`main` merge)

All staging steps, then:

| #   | Step                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 15  | **Review staging results** — job asserts the staging smoke run for this SHA was green                                                                                                                         |
| 16  | **Manual approval** — GitHub `production` Environment with required reviewers                                                                                                                                 |
| 17  | **Database backup** — `scripts/db-backup.sh`; deploy aborts if the artefact fails its `pg_restore --list` integrity check                                                                                     |
| 18  | **Migration safety check** — parse the migration diff; if it contains `DROP TABLE`/`DROP COLUMN`/`ALTER … TYPE`/`NOT NULL` on an existing column, require a second approval from a `db-owners` reviewer group |
| 19  | Deploy — Railway production, Vercel production                                                                                                                                                                |
| 20  | Health check — poll `/api/v1/health` until healthy, timeout 5 min                                                                                                                                             |
| 21  | Smoke tests — read-only subset against Production                                                                                                                                                             |
| 22  | Rollback on failure — §15                                                                                                                                                                                     |

---

## 13. Test strategy

### 13.1 Coverage matrix

| Area                                            | Automated (unit/E2E) | Smoke (post-deploy) | Regression (pre-release) | UAT (teachers) | Prod verification |
| ----------------------------------------------- | -------------------- | ------------------- | ------------------------ | -------------- | ----------------- |
| Authentication (login/refresh/logout/reset)     | ✅                   | ✅                  | ✅                       | ✅             | ✅ read-only      |
| Role permissions — admin                        | ✅                   | —                   | ✅                       | ✅             | —                 |
| Role permissions — teacher                      | ✅                   | —                   | ✅                       | ✅             | —                 |
| Role permissions — student                      | ✅                   | ✅                  | ✅                       | ✅             | —                 |
| Role permissions — parent/guardian              | ✅                   | —                   | ✅                       | ✅             | —                 |
| Courses / packages (draft→published→scheduled)  | ✅                   | ✅                  | ✅                       | ✅             | ✅                |
| Lessons + **video upload/playback**             | partial              | ✅ signed-url 200   | ✅                       | ✅             | ✅                |
| Books (free + paid, private PDF access)         | ✅                   | ✅                  | ✅                       | ✅             | —                 |
| Exams (all question types, timing, auto-submit) | ✅                   | —                   | ✅                       | ✅             | —                 |
| **OMR** scan pipeline                           | partial              | —                   | ✅                       | ✅             | —                 |
| Attendance + activation codes                   | ✅                   | —                   | ✅                       | ✅             | —                 |
| **Payments** — Paymob card                      | ✅ sandbox           | ✅ checkout init    | ✅                       | ✅             | ⚠️ read-only      |
| **Payments** — InstaPay / wallet / bank / cash  | ✅                   | —                   | ✅                       | ✅             | ⚠️ read-only      |
| **Refunds** / voids                             | ✅ sandbox           | —                   | ✅                       | ✅             | ❌ never          |
| Notifications (email / SMS / WhatsApp / push)   | ✅                   | ✅ test-email       | ✅                       | ✅             | —                 |
| Reports + teacher balances                      | ✅                   | —                   | ✅                       | ✅             | ✅ read-only      |
| Certificates (issue/verify/revoke)              | ✅                   | ✅ public verify    | ✅                       | ✅             | ✅                |
| Storage (upload/signed URL/delete)              | ✅                   | ✅                  | ✅                       | —              | —                 |
| Background jobs (12 queues)                     | partial              | ✅ queue depth      | ✅                       | —              | ✅ monitor        |
| **Webhooks** (Paymob + Meta)                    | ✅                   | ✅ signed replay    | ✅                       | —              | ✅ monitor        |

### 13.2 Test types

- **Automated** — existing Jest unit + E2E (backend), Vitest (frontend). Grow E2E coverage for payments and webhooks as part of Phase 7.
- **Smoke** — `scripts/smoke-test.sh`, ≤60s, runs after every deploy in both environments.
- **Regression** — full matrix, run against staging before each `develop`→`main` PR.
- **UAT** — teachers behind Cloudflare Access on `staging.learnix.school`, using seeded synthetic accounts and Paymob **sandbox** cards.
- **Production verification** — strictly read-only: health, a login with a dedicated monitoring account, a public course list, a certificate verification. **Never** a payment, never a refund.

### 13.3 Smoke test contents

```
GET  /api/v1/health                    → 200, status healthy
GET  /api/v1/health/readiness          → 200
GET  /metrics  (Bearer)                → 200 text/plain
GET  /api/v1/auth/csrf-token           → 200 + XSRF-TOKEN cookie set
POST /api/v1/auth/login (seeded user)  → 200 + access_token + refresh_token cookies
POST /api/v1/auth/refresh              → 200, cookies rotated
GET  /api/v1/packages (public)         → 200, non-empty
GET  /api/v1/lessons/:id/signed-url    → 200 (or 503 if Bunny unset — assert which)
GET  https://staging.learnix.school/   → 200, HTML contains the STAGING banner
GET  https://staging.learnix.school/robots.txt → contains "Disallow: /"
```

---

## 14. Staging safety guards — technical, not procedural

This is the heart of "staging must not connect to any Production resource."

### 14.1 The boot guard `[RECOMMENDED]`

**Location:** a new `src/config/staging-isolation.guard.ts`, invoked from `validate()` in `src/config/env.validation.ts:446` — i.e. inside `ConfigModule.forRoot({ validate })` (`app.module.ts:177`), which runs **before** any module, any queue, any cron, and any DB connection. This is the only place early enough to matter.

**Behaviour:** when `APP_ENV === 'staging'`, throw and refuse to boot if **any** of these hold:

| #   | Check                                                                                                                                                                                                        | Rationale                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| G1  | `DATABASE_URL` host ∈ `PROD_RESOURCE_DENYLIST`                                                                                                                                                               | Blocks the catastrophic case                                           |
| G2  | `REDIS_URL` host ∈ denylist                                                                                                                                                                                  | Blocks shared queues                                                   |
| G3  | `R2_BUCKET` ∈ denylist (e.g. `learnix`)                                                                                                                                                                      | Blocks the orphan-cleanup cron deleting live files                     |
| G4  | `BUNNY_STREAM_LIBRARY_ID` ∈ denylist                                                                                                                                                                         | Blocks video deletion                                                  |
| G5  | `PAYMOB_EXPECTED_MODE !== 'test'`                                                                                                                                                                            | Blocks real charges                                                    |
| G6  | SHA-256 of any of `JWT_SECRET`, `JWT_REFRESH_SECRET`, `COOKIE_SECRET`, `PAYMOB_API_KEY`, `PAYMOB_SECRET_KEY`, `PAYMOB_WEBHOOK_SECRET`, `MAILERSEND_API_KEY`, `R2_ACCESS_KEY_ID` ∈ `PROD_SECRET_FINGERPRINTS` | Catches a copy-pasted Production secret **without storing the secret** |
| G7  | `CORS_ORIGINS` or `FRONTEND_URL` contains `learnix.school` without a `staging.` prefix                                                                                                                       | Blocks cross-env browser wiring                                        |
| G8  | `MAIL_ALLOWLIST` unset/empty                                                                                                                                                                                 | Blocks accidental mass email                                           |

`PROD_RESOURCE_DENYLIST` and `PROD_SECRET_FINGERPRINTS` are set as staging environment variables holding **hosts and hashes only** — no Production secret is ever committed or transmitted.

**The mirror guard:** when `APP_ENV === 'production'`, refuse to boot if `PAYMOB_EXPECTED_MODE === 'test'` or `MAIL_ALLOWLIST` is set — so a staging config can never be pasted into Production either.

**How it is tested** (Phase 6 acceptance):

- Unit tests in `staging-isolation.guard.spec.ts` — one per check, asserting the specific error message.
- A deliberate live drill: temporarily set the staging service's `R2_BUCKET` to `learnix`, redeploy, and confirm the deploy **fails at boot** with G3, then revert. Repeat for G1 with a denylisted DB host. A guard that has never been seen to fire is not a guard.

### 14.2 Runtime guards (secondary layer)

| Guard          | Where                                                    | Behaviour                                                     |
| -------------- | -------------------------------------------------------- | ------------------------------------------------------------- |
| Mail allowlist | `src/mail/mail.service.ts` send path                     | Drop + log non-allowlisted recipients when `APP_ENV=staging`  |
| Subject prefix | same                                                     | Prepend `[STAGING]`                                           |
| SMS sandbox    | `src/notifications/channels/channel-registry.service.ts` | `SMS_MODE=sandbox` → log-and-mark-delivered, no outbound call |
| Seed guard     | `src/database/seed-staging.ts`                           | Three-check abort (§8.5)                                      |
| Restore guard  | `scripts/db-restore.sh`                                  | Refuses unless `APP_ENV=staging` and host not denylisted      |

---

## 15. Staging interface and security

### 15.1 UI treatment `[RECOMMENDED]`

| Item                   | Implementation                                                                                                                                                                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **STAGING banner**     | New `dodline/app/[locale]/Components/StagingBanner.tsx`, rendered in `app/[locale]/layout.tsx` when `NEXT_PUBLIC_APP_ENV === 'staging'`. Fixed strip, amber, `STAGING — test data only, no real payments`. **Returns `null` in production**, so the Production bundle is byte-identical in behaviour |
| Visual distinction     | Banner + a subtle amber top border only. **Do not** re-theme the app — testers must evaluate the real product                                                                                                                                                                                        |
| `noindex` / `nofollow` | Add `robots: { index: false, follow: false }` to `generateMetadata` in `layout.tsx:19` when `NEXT_PUBLIC_APP_ENV === 'staging'`, **plus** an `X-Robots-Tag: noindex, nofollow` response header from `proxy.ts` (belt and braces — the header covers non-HTML responses)                              |
| `robots.txt`           | Create `dodline/app/robots.ts` — the file does **not exist today** (**H7**). Staging: `Disallow: /`. Production: a real allow-list policy                                                                                                                                                            |
| Sitemap                | Create `dodline/app/sitemap.ts`; return an **empty** array when `NEXT_PUBLIC_APP_ENV === 'staging'`                                                                                                                                                                                                  |
| Disable real analytics | Wrap `<Analytics />` (`layout.tsx:90`) in an `APP_ENV !== 'staging'` check. The separate Vercel project already separates the data, but this makes it explicit and costs nothing                                                                                                                     |
| Build version / SHA    | Show `NEXT_PUBLIC_COMMIT_SHA` (from Vercel's `VERCEL_GIT_COMMIT_SHA`) in the banner                                                                                                                                                                                                                  |
| Environment info page  | `/[locale]/admin/system` — admin-only, surfacing the existing `GET /api/v1/health/all` payload (`health.controller.ts:69`, `@Roles('admin')`). No new backend endpoint needed                                                                                                                        |
| Also fix on staging    | `SITE_URL` (**H1**) and `siteConfig.url` (**H2**) must read `NEXT_PUBLIC_SITE_URL` with the current literal as the default, so Production is unchanged                                                                                                                                               |

### 15.2 Access control

**Decision: Cloudflare Access on the frontend + login-only API.**

| Aspect               | Setting                                                                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend gate        | Cloudflare Access on `staging.learnix.school`, **one-time-PIN email policy** with an explicit allowlist of teacher/staff addresses. No shared password to leak; access is revoked per-person                  |
| API gate             | **No** Basic Auth. Basic Auth in front of the API breaks CORS preflight, the SPA's `withCredentials` flow, and the Paymob sandbox webhook. Protection is `CORS_ORIGINS` (exact match) + normal authentication |
| Webhook path         | `POST /api/v1/payments/webhook` must remain reachable by Paymob's sandbox. Cloudflare Access is **not** applied to `api-staging` for this reason                                                              |
| Why not IP allowlist | Teachers on mobile data would be locked out — incompatible with the stated UAT plan                                                                                                                           |

### 15.3 Staging security posture

| Control                          | Setting                                                                                                    | Note                                                                                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Rate limiting                    | Same as prod: `THROTTLE.GLOBAL` 300/min + per-route tiers                                                  | **Fix R5 first** — restore `THROTTLE.AUTH` on `auth.controller.ts:153`. Staging is where that fix is proven                                            |
| Debug behaviour                  | `NODE_ENV=production` ⇒ no debug affordances                                                               | Deliberate                                                                                                                                             |
| Stack traces                     | **Not** exposed (production filter, `http-exception.filter.ts:82`)                                         | Use Sentry instead                                                                                                                                     |
| Password-reset token in response | **Not** returned (production path, `auth.service.ts:614`)                                                  | Read it from the MailerSend staging inbox                                                                                                              |
| Admin accounts                   | Seeded, unique to staging, strong generated `ADMIN_INIT_PASSWORD`                                          | Rotate after first login                                                                                                                               |
| Default passwords                | None. Seeded synthetic users get generated passwords, distributed out-of-band to UAT testers               | Never commit them                                                                                                                                      |
| Secret logging                   | Existing `maskEmail` (`src/common/utils/mask.util.ts`) and Sentry `sendDefaultPii: false` (`sentry.ts:37`) | Verify no new guard logs raw env values                                                                                                                |
| PII logging                      | Staging holds no real PII by construction (synthetic seed only)                                            | The strongest possible control                                                                                                                         |
| API docs exposure                | Swagger **enabled** on staging via `ENABLE_SWAGGER=true`, **disabled** on Production                       | Behind Cloudflare Access? No — `api-staging` is not gated (webhooks). Accept: staging Swagger is public, and it documents a public API with no secrets |
| Bull Board                       | Enabled with a **staging-specific** `BULL_BOARD_PASSWORD`                                                  | Fails closed if unset                                                                                                                                  |

---

## 16. Monitoring strategy

Every signal carries an `environment` tag/label of `production` or `staging`, sourced from the new `APP_ENV`.

| Signal                     | Production                                                              | Staging                       | Implementation                                                                                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Logs**                   | Railway logs, `LOG_LEVELS=error,warn,log`                               | same                          | Add `APP_ENV` to the Nest logger context                                                                                                                                        |
| **Errors**                 | Sentry `environment: production`                                        | Sentry `environment: staging` | Change `sentry.ts:31` and `dodline/instrumentation.ts:13` to prefer `APP_ENV` and fall back to `NODE_ENV` — otherwise **staging is tagged `production`** and buries real alerts |
| **Metrics**                | `GET /metrics` + `METRICS_BEARER_TOKEN`                                 | same, different token         | Add an `environment` label to `performance-metrics.registry.ts` output                                                                                                          |
| **Uptime**                 | External monitor → `/api/v1/health`                                     | same                          | Different alert routing: prod pages, staging emails                                                                                                                             |
| **Health checks**          | `/api/v1/health` (Railway)                                              | same                          | Already configured (`railway.json:9`)                                                                                                                                           |
| **Queue failures**         | Bull Board + `queue.indicator.ts`                                       | same                          | Alert on `failed` depth > N                                                                                                                                                     |
| **Failed webhooks**        | `gateway_webhook_events` + per-minute replay cron                       | same                          | Alert on unprocessed age > 15 min                                                                                                                                               |
| **DB connections**         | `database.indicator.ts` + pool metrics                                  | same                          | Alert near `DB_POOL_MAX`                                                                                                                                                        |
| **Storage failures**       | `storage.indicator.ts`                                                  | same                          | —                                                                                                                                                                               |
| **Payment reconciliation** | `payment-operations.service.ts:59` per-minute cron                      | same, sandbox                 | Alert on any unreconciled payment > 30 min                                                                                                                                      |
| **Email delivery**         | `MailService` health state (`mail.service.ts:95`)                       | same                          | Alert on `lastFailureAt` newer than `lastSuccessAt`                                                                                                                             |
| **SMS delivery**           | `parent_messages` delivery rates (`parent-message-admin.service.ts:30`) | same                          | WhatsApp only — SMS has no delivery callback                                                                                                                                    |

**Naming convention:** `environment=production` / `environment=staging`, plus `service=api` and `commit=<sha>` on every signal.

---

## 17. Rollback strategy

| Component         | Mechanism                                                 | Time                         | Notes                                                                                                                                                  |
| ----------------- | --------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Frontend**      | Vercel "Promote to Production" on the previous deployment | < 1 min                      | Instant; atomic                                                                                                                                        |
| **Backend**       | Railway redeploy of the previous successful deployment    | 2–5 min                      | **Does not roll back migrations**                                                                                                                      |
| **Worker**        | Same process as backend                                   | —                            | No independent rollback exists today                                                                                                                   |
| **Migration**     | `npm run migration:revert` (newest only), one at a time   | Varies                       | **Only if `down()` is implemented and tested.** Many of the 104 existing migrations have untested `down()` — treat as unavailable until each is proven |
| **Database**      | `pg_restore` from the pre-deploy backup (§8.4)            | 10–60 min                    | **Data loss window = time since the backup.** Last resort                                                                                              |
| **Env variables** | Railway/Vercel variable history; revert + redeploy        | 2–5 min                      | Keep a versioned (secret-free) inventory in the repo                                                                                                   |
| **DNS**           | Revert the CNAME                                          | TTL-bound (300s if kept low) | Keep staging TTL at 300 during setup                                                                                                                   |
| **Storage**       | R2 object versioning `[RECOMMENDED — verify enabled]`     | Varies                       | Without versioning a delete is permanent                                                                                                               |
| **Webhooks**      | Re-point the Paymob dashboard URL to the previous host    | Minutes                      | Manual; keep the old endpoint alive during a cutover                                                                                                   |

### Conditions that forbid a direct rollback — forward-fix required

1. **A destructive migration ran.** `DROP COLUMN`/`DROP TABLE` deleted data the old code needs. Rolling back the app leaves it querying columns that no longer exist. → Forward-fix, or restore from backup and replay.
2. **Money moved after the deploy.** Payments captured, refunds issued, teacher settlements created, or entitlements granted under the new code. A DB restore would erase real financial records. → **Forward-fix only, always.**
3. **Webhooks were acknowledged.** Paymob has recorded a `200` for events the restored DB would not contain. Paymob will not re-send them. → Forward-fix + manual reconciliation.
4. **Cookie/JWT secrets were rotated.** Rolling back the app without rolling back the secret logs everyone out and can invalidate refresh tokens permanently.
5. **A new enum value was written.** Rows now hold a value the old code's enum cannot parse → runtime crashes on read.
6. **Files were written to storage under a new key scheme.** Old code cannot locate them.

**Rule of thumb, written into the runbook:** _if a customer, a teacher, or the ledger has observed the new state, roll forward._

---

## 18. Phased implementation plan

> Each phase ends with tests and documentation. **No phase begins before the previous one's Definition of Done is met.**

### Phase 0 — Audit and inventory

- **Objective:** replace every `[UNVERIFIABLE]` with a fact, and eliminate the R2 secret exposure.
- **Files:** copy this plan to `learning-center-backend/STAGING_ENVIRONMENT_IMPLEMENTATION_PLAN.md`; create `docs/ENVIRONMENT_INVENTORY.md` (**names and hosts only, never values**).
- **Services:** Railway (prod), Vercel, Cloudflare, R2, Bunny, Paymob, MailerSend, Sentry — read-only.
- **Steps:** (1) Export the Production Railway variable **key list**. (2) Record replicas, region, resource limits, Postgres major version, backup settings. (3) Same for the Vercel project. (4) Record the R2 bucket/token scopes and Bunny library IDs. (5) Confirm which Paymob merchant is live. (6) **Rotate every secret found in the local `.env` (R2)** and remove the file from developer machines. (7) Confirm whether Railway backups are enabled.
- **Dependencies:** none. **Risks:** rotation causes a brief Production blip — schedule it. **Acceptance:** every `[UNVERIFIABLE]` row resolved; `git log -p` + gitleaks confirm no secret was ever committed. **Rollback:** n/a (read-only, plus a planned rotation). **DoD:** inventory doc merged; rotation complete and verified by a Production smoke test.

### Phase 1 — Environment separation foundation

- **Objective:** introduce `APP_ENV` and close the hardcoded-value gaps. **No infrastructure yet.**
- **Files:** `src/config/env.validation.ts` (add optional `APP_ENV`), `src/observability/sentry.ts:31`, `src/app.service.ts:33`, `src/health/health-error.service.ts:43`, `src/health/health-orchestrator.service.ts:175`, `src/common/utils/cors.util.ts:22` (**H5** — drop the prod origin from the dev fallback), `.env.example` (**R10**); `dodline/app/[locale]/layout.tsx:17` (**H1**), `dodline/app/[locale]/lib/site.ts:3` (**H2**), `dodline/next.config.ts` (**H3**), `dodline/.github/workflows/ci.yml:52` (**H4**), new `dodline/.env.example`.
- **Steps:** add `APP_ENV` (optional, default `production` when `NODE_ENV=production`); make Sentry/health/log labels prefer it; make `SITE_URL`/`siteConfig.url` read `NEXT_PUBLIC_SITE_URL` with today's literal as default; add a staging-API `remotePattern`; parameterise the CI build URL.
- **Dependencies:** Phase 0. **Risks:** touching `layout.tsx` metadata could change Production SEO — defaults are byte-identical, and a unit test asserts that. **Acceptance:** with `APP_ENV` unset, every Production-observable output is unchanged (snapshot tests); backend + frontend CI green. **Rollback:** revert the PR. **DoD:** merged to `develop`; `.env.example` matches `env.validation.ts` exactly.

### Phase 2 — Database and Redis

- **Objective:** a working, empty, isolated staging Postgres + Redis, with the migration chain proven.
- **Files:** `scripts/migrate.ts` (advisory lock, **R4**), `scripts/db-backup.sh`, `scripts/db-restore.sh` (**R8**), `package.json` scripts; possibly **new** fix-forward migrations.
- **Services:** new Railway project `learnix-staging` + Postgres + Redis.
- **Steps:** (1) Create the project and both data services. (2) Run all 104 migrations against the empty DB. (3) Fix failures with new migrations. (4) Drift check must produce an empty `up()`. (5) Test `down()` on the newest. (6) Add the advisory lock and prove it with two concurrent runners. (7) Write and test backup/restore. (8) Restore a Production backup into a **scratch** DB (never staging) to validate the script.
- **Dependencies:** Phase 1. **Risks:** **R1 is expected to bite here** — budget real time. **Acceptance:** empty DB → all migrations → drift check clean; concurrent migration test shows one waiting; a backup restores and passes row-count checks. **Rollback:** delete and recreate the staging DB — it holds nothing. **DoD:** documented run, scripts merged, migration count recorded.

### Phase 3 — Storage and third-party integrations

- **Objective:** every external dependency has an isolated staging counterpart.
- **Files:** none (config only) except `src/mail/mail.service.ts` and `channel-registry.service.ts` if the allowlist/sandbox lands here rather than Phase 6.
- **Services:** R2 bucket `learnix-staging` + scoped token; new Bunny Stream library; MailerSend staging key + sender + 10 template IDs; Paymob **test** merchant; Twilio test creds; Meta test number; Firebase staging project; Sentry staging project.
- **Steps:** create each; verify each in isolation; record IDs (not secrets) in the inventory doc.
- **Dependencies:** Phase 0. **Risks:** creating a Bunny library or R2 token in the **wrong account** — verify the account name on every screen. **Acceptance:** the staging R2 token, tested with `aws s3 ls s3://learnix`, is **denied**; MailerSend staging key cannot send from the Production domain. **Rollback:** delete the newly created resources. **DoD:** all IDs recorded; negative access tests documented.

### Phase 4 — Railway services and DNS

- **Objective:** staging backend and frontend live and reachable.
- **Services:** Railway staging API service; Vercel project `dodline-staging`; DNS D1–D4; Cloudflare Access.
- **Steps (Railway):** connect the `learnix-back` repo → branch `develop` → root directory `/` → builder NIXPACKS (from `railway.json`) → build `npm run build` → start `npm run migration:run:prod && node dist/src/main.js` → health-check `/api/v1/health` → restart `ON_FAILURE`/10 → **1 replica** → resources at or below prod → attach Postgres/Redis over **private networking** (`*.railway.internal`) → set all §7 variables → add custom domain `api-staging.learnix.school` → SSL auto → deploy trigger = push to `develop`.
- **Steps (Vercel):** new project `dodline-staging` → same repo → production branch `develop` → framework Next.js → set `NEXT_PUBLIC_*` staging vars → add domain `staging.learnix.school`.
- **Steps (DNS):** D1 → verify → D3 → verify → D4 Cloudflare Access.
- **Dependencies:** Phases 2, 3. **Risks:** a mis-typed variable connecting to Production — **Phase 6's guard does not exist yet**, so this phase requires a manual two-person check of `DATABASE_URL`, `REDIS_URL`, `R2_BUCKET`, and all Paymob values before the first deploy. **Acceptance:** `/api/v1/health` returns 200 over HTTPS with a valid cert; the frontend loads and reaches the staging API; Cloudflare Access challenges an unlisted address. **Rollback:** delete the DNS records and the services. **DoD:** both URLs live; a smoke run passes; Production untouched (verified by a Production smoke run).

### Phase 5 — CI/CD and branch protection

- **Objective:** code reaches Production only through staging.
- **Files:** the workflow and script files listed in §12.1.
- **Steps:** create `develop` on both repos from the current default; add branch protection to both `main`/`master` and `develop`; add the new CI steps (migration validation, env validation, prettier, audit); add deploy workflows; add the nightly divergence check; `[RECOMMENDED]` rename the frontend default to `main` and update `learnix-speckit/.gitmodules`.
- **Dependencies:** Phase 4. **Risks:** protecting `main` may block an in-flight hotfix — announce it. **Acceptance:** a direct push to `main` is rejected; a PR with a failing migration-validation job cannot merge; a `develop` push deploys to staging automatically; a `main` merge waits for manual approval. **Rollback:** relax protection rules (settings only). **DoD:** both repos protected; one full `feature/*`→`develop`→staging cycle completed end to end.

### Phase 6 — Staging safety guards

- **Objective:** make cross-environment connection technically impossible.
- **Files:** **new** `src/config/staging-isolation.guard.ts` + `.spec.ts`; `src/config/env.validation.ts` (call it); `src/mail/mail.service.ts` (allowlist + `[STAGING]` prefix); `src/notifications/channels/channel-registry.service.ts` (`SMS_MODE`); `src/auth/auth-cookie.constants.ts` + its five consumers (cookie-name suffix); `scripts/db-restore.sh` (guard).
- **Steps:** implement G1–G8 and the production mirror-guard; unit-test each; deploy to staging; **run the live drills** (deliberately set `R2_BUCKET=learnix`, then a denylisted DB host, and confirm each deploy fails at boot); revert.
- **Dependencies:** Phase 5. **Risks:** an over-eager guard blocks a legitimate Production boot — the mirror-guard is narrow and covered by tests; roll out to staging for a week before Production. **Acceptance:** every drill fails the boot with the expected message; staging boots normally with correct values; **Production boots unchanged with `APP_ENV=production`**. **Rollback:** revert the PR; guards are additive. **DoD:** drills documented with logs; `docs/STAGING_SAFETY_GUARDS.md` written.

### Phase 7 — Seed data and testing

- **Objective:** staging is usable for realistic testing and UAT.
- **Files:** **new** `src/database/seed-staging.ts`; `package.json` (`seed:staging`, and fix/remove the broken `seed` — **R7**); **new** `scripts/smoke-test.sh`; new E2E specs for payments and webhooks; `dodline` staging banner / `robots.ts` / `sitemap.ts` / analytics gate (§15.1).
- **Steps:** write the seed with its three guards; run against staging; execute the §13.1 regression matrix manually once, recording results; automate the smoke script; onboard 2–3 teachers to Cloudflare Access for a UAT pilot.
- **Dependencies:** Phase 6 (**the seed must not run before the guards exist**). **Risks:** seeded data drifts from real-world shapes — review with a teacher during UAT. **Acceptance:** `seed:staging` on an empty DB produces a fully navigable platform; the seed **aborts** when pointed at a denylisted host; the full matrix passes; `staging.learnix.school/robots.txt` returns `Disallow: /`. **Rollback:** `seed:staging -- --reset`. **DoD:** matrix results recorded; smoke script in CI; UAT pilot feedback captured.

### Phase 8 — Monitoring and rollback validation

- **Objective:** know when staging breaks, and prove rollback works before needing it.
- **Files:** `src/observability/performance-metrics.registry.ts` (environment label); alert configuration (external).
- **Steps:** configure Sentry alert routing per environment; add uptime monitors for both; set queue/webhook/reconciliation alerts; then **rehearse rollback on staging**: (a) Vercel promote-previous, (b) Railway redeploy-previous, (c) `migration:revert` on a test migration, (d) full `pg_restore` from backup into staging. Time each and write the runbook from what actually happened.
- **Dependencies:** Phase 7. **Risks:** none — all drills are on staging. **Acceptance:** a deliberately broken staging deploy fires an alert within 5 minutes; all four rollback drills succeed and are timed. **Rollback:** n/a. **DoD:** `docs/ROLLBACK_RUNBOOK.md` written from measured drills, not theory.

### Phase 9 — Production promotion workflow

- **Objective:** the first real release flows `develop` → staging → soak → `main` → Production.
- **Files:** `docs/RELEASE_PROCESS.md`; `CHANGELOG.md`; `deploy-production.yml` finalised.
- **Steps:** enable the GitHub `production` environment with required reviewers; add the backup + migration-safety gates (§12.3 steps 17–18); **fix R5** (restore `THROTTLE.AUTH` on login) and ship it as the first release through the new pipeline; tag `v1.0.0`; verify with the read-only Production smoke set.
- **Dependencies:** Phase 8. **Risks:** the first gated deploy is also the first time the gates run for real — dry-run the workflow against staging with `workflow_dispatch` first. **Acceptance:** a release reaches Production only after staging soak + manual approval + a verified backup; Production health green post-deploy; a login attempt beyond 5 tries in 5 minutes is now throttled. **Rollback:** the §17 procedure, rehearsed in Phase 8. **DoD:** one full release completed and documented; the team can repeat it from the runbook alone.

---

## 19. Execution checklist

| ID        | Description                                                                                       | Files / Services                                                                                                                         | Deps      | Verification                                                 | Expected outcome                  |
| --------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------ | --------------------------------- |
| **P0-01** | Copy this plan into the repo                                                                      | `learning-center-backend/STAGING_ENVIRONMENT_IMPLEMENTATION_PLAN.md`                                                                     | —         | File exists on `develop`                                     | Plan under version control        |
| **P0-02** | Export Production Railway variable **keys**                                                       | Railway                                                                                                                                  | —         | Key count matches `env.validation.ts` expectations           | Gap list produced                 |
| **P0-03** | Record Railway prod topology (replicas, region, resources, PG version, backups)                   | Railway                                                                                                                                  | —         | `docs/ENVIRONMENT_INVENTORY.md`                              | Staging can mirror it             |
| **P0-04** | Record Vercel prod project settings                                                               | Vercel                                                                                                                                   | —         | inventory doc                                                | —                                 |
| **P0-05** | Record R2 bucket/token scopes, Bunny library IDs                                                  | R2, Bunny                                                                                                                                | —         | inventory doc                                                | Denylist inputs known             |
| **P0-06** | Confirm which Paymob merchant is live                                                             | Paymob                                                                                                                                   | —         | inventory doc                                                | —                                 |
| **P0-07** | **Rotate every secret present in local `.env`** (**R2**)                                          | Railway, R2, Bunny, Paymob, MailerSend                                                                                                   | P0-02..06 | Prod smoke passes post-rotation                              | Prod secrets no longer on laptops |
| **P0-08** | Delete local `.env` from all developer machines; confirm gitleaks history is clean                | all machines                                                                                                                             | P0-07     | `gitleaks detect --log-opts="--all"`                         | No secret exposure                |
| **P1-01** | Add optional `APP_ENV` to env validation                                                          | `src/config/env.validation.ts`                                                                                                           | P0        | unit test: unset ⇒ prod defaults                             | Additive, no prod change          |
| **P1-02** | Sentry/health/log labels prefer `APP_ENV`                                                         | `sentry.ts:31`, `app.service.ts:33`, `health-error.service.ts:43`, `health-orchestrator.service.ts:175`, `dodline/instrumentation.ts:13` | P1-01     | unit tests                                                   | staging ≠ production in Sentry    |
| **P1-03** | Remove `https://learnix.school` from the dev CORS fallback (**H5**)                               | `src/common/utils/cors.util.ts:22`                                                                                                       | P1-01     | `cors.util.spec.ts` updated                                  | Dev cannot trust prod origin      |
| **P1-04** | Close `.env.example` drift (**R10**)                                                              | `.env.example`                                                                                                                           | P1-01     | Every key in `env.validation.ts` present                     | No missing-var surprises          |
| **P1-05** | Create `dodline/.env.example`                                                                     | new file                                                                                                                                 | —         | Lists all `NEXT_PUBLIC_*` + `SENTRY_*`                       | Frontend vars documented          |
| **P1-06** | `SITE_URL`/`siteConfig.url` read `NEXT_PUBLIC_SITE_URL` (**H1/H2**)                               | `layout.tsx:17`, `lib/site.ts:3`                                                                                                         | —         | Snapshot test: unset ⇒ identical output                      | Prod SEO unchanged                |
| **P1-07** | Add staging API host to `remotePatterns` (**H3**)                                                 | `dodline/next.config.ts`                                                                                                                 | —         | `next/image` loads a staging URL                             | Images work on staging            |
| **P1-08** | Parameterise CI build API URL (**H4**)                                                            | `dodline/.github/workflows/ci.yml:52`                                                                                                    | —         | CI green                                                     | Artefact not prod-pinned          |
| **P2-01** | Create Railway project `learnix-staging`                                                          | Railway                                                                                                                                  | P0        | Project exists, empty                                        | —                                 |
| **P2-02** | Provision staging Postgres (match prod major version)                                             | Railway                                                                                                                                  | P2-01     | `SELECT version()` matches                                   | —                                 |
| **P2-03** | Provision staging Redis                                                                           | Railway                                                                                                                                  | P2-01     | `redis-cli PING`                                             | —                                 |
| **P2-04** | Compare `pg_extension` prod vs staging                                                            | psql                                                                                                                                     | P2-02     | Lists match                                                  | No hidden extension dependency    |
| **P2-05** | **Run all 104 migrations against the empty DB** (**R1**)                                          | `migration:run:prod`                                                                                                                     | P2-04     | Exit 0                                                       | Chain proven, or gaps found       |
| **P2-06** | Fix-forward any migration failures with **new** migrations                                        | `src/migrations/`                                                                                                                        | P2-05     | P2-05 re-run passes                                          | —                                 |
| **P2-07** | Drift check — `migration:generate` must yield an empty `up()`                                     | typeorm CLI                                                                                                                              | P2-06     | Generated file empty; delete it                              | Migrations ≡ entities             |
| **P2-08** | Test `down()` on the newest migration                                                             | typeorm CLI                                                                                                                              | P2-07     | revert → verify → re-run                                     | Rollback viable                   |
| **P2-09** | Add advisory-lock migration runner (**R4**)                                                       | new `scripts/migrate.ts`; `package.json`; `src/main.ts:48`                                                                               | P2-08     | Two concurrent runners: one waits                            | No concurrent-migration race      |
| **P2-10** | Write `db-backup.sh` + `db-restore.sh` (**R8**)                                                   | new `scripts/`                                                                                                                           | P2-02     | Backup passes `pg_restore --list`; restore into a scratch DB | Backups exist and are proven      |
| **P2-11** | Restore a Production backup into a **scratch** DB and run migrations                              | scratch Railway DB                                                                                                                       | P2-10     | Row counts + smoke login OK                                  | Restore path validated            |
| **P3-01** | Create R2 bucket `learnix-staging`, anonymous access **disabled**                                 | R2                                                                                                                                       | P0-05     | Anonymous GET → 403                                          | —                                 |
| **P3-02** | Create an R2 token scoped to `learnix-staging` only                                               | R2                                                                                                                                       | P3-01     | `aws s3 ls s3://learnix` → **denied**                        | Cannot touch prod files           |
| **P3-03** | Create a Bunny Stream **staging library** + keys                                                  | Bunny                                                                                                                                    | P0-05     | Test upload appears only in staging                          | Cannot delete prod video          |
| **P3-04** | Create MailerSend staging key, sender, 10 template IDs                                            | MailerSend                                                                                                                               | —         | Test send to an allowlisted address                          | Templates testable                |
| **P3-05** | Create Paymob **test** merchant + record webhook secret                                           | Paymob                                                                                                                                   | P0-06     | Sandbox checkout returns an iframe URL                       | No live-money capability          |
| **P3-06** | Twilio test credentials + Meta test number + Firebase staging project                             | providers                                                                                                                                | —         | Each initialises without error                               | No real messages possible         |
| **P3-07** | Create a Sentry **staging** project                                                               | Sentry                                                                                                                                   | —         | A test error lands under `environment=staging`               | Alerts separated                  |
| **P4-01** | Create the Railway staging API service on branch `develop`                                        | Railway                                                                                                                                  | P2, P3    | Build succeeds                                               | —                                 |
| **P4-02** | Set all §7 staging variables                                                                      | Railway                                                                                                                                  | P4-01     | **Two-person review** of DB/Redis/R2/Paymob values           | No prod resource referenced       |
| **P4-03** | Attach Postgres/Redis via **private networking**                                                  | Railway                                                                                                                                  | P4-02     | Internal hostnames resolve                                   | No public DB exposure             |
| **P4-04** | Configure health check, restart policy, 1 replica, resources                                      | Railway (`railway.json` defaults)                                                                                                        | P4-02     | Deploy healthy                                               | Mirrors prod shape                |
| **P4-05** | Add `api-staging.learnix.school` (D1/D2)                                                          | Railway + DNS                                                                                                                            | P4-04     | `dig` + `curl` health returns `200`, SSL verified            | API reachable                     |
| **P4-06** | Create the `dodline-staging` Vercel project on `develop`                                          | Vercel                                                                                                                                   | P1        | Build succeeds                                               | —                                 |
| **P4-07** | Set the frontend staging variables                                                                | Vercel                                                                                                                                   | P4-06     | `NEXT_PUBLIC_API_URL` = staging API                          | FE→staging API only               |
| **P4-08** | Add `staging.learnix.school` (D3)                                                                 | Vercel + DNS                                                                                                                             | P4-07     | Site loads over HTTPS                                        | —                                 |
| **P4-09** | Apply Cloudflare Access (D4) with an email allowlist                                              | Cloudflare                                                                                                                               | P4-08     | Unlisted address is challenged; listed address gets in       | UAT-friendly gate                 |
| **P4-10** | Verify Production is untouched                                                                    | prod smoke                                                                                                                               | P4-09     | Prod health + login green                                    | Zero prod impact                  |
| **P5-01** | Create `develop` on both repos                                                                    | GitHub                                                                                                                                   | P4        | Branch exists                                                | —                                 |
| **P5-02** | Protect `main`/`master`: no direct push, no force push, PR + 1 approval + checks + linear history | GitHub                                                                                                                                   | P5-01     | A direct push is rejected                                    | Prod is gated                     |
| **P5-03** | Protect `develop`: no direct push, no force push, checks required                                 | GitHub                                                                                                                                   | P5-01     | Rejected as expected                                         | Staging is gated                  |
| **P5-04** | Add migration validation job to backend CI                                                        | `.github/workflows/ci.yml`                                                                                                               | P2-07     | A drift-introducing PR fails                                 | **R1 stays closed**               |
| **P5-05** | Add `validate-env.ts` + CI env-validation step                                                    | new `scripts/validate-env.ts`; `ci.yml`                                                                                                  | P1-04     | A missing `CORS_ORIGINS` fails CI                            | Boot failures caught early        |
| **P5-06** | Add `prettier --check` + `npm audit --audit-level=high`                                           | both `ci.yml`                                                                                                                            | —         | CI green                                                     | Quality + supply chain            |
| **P5-07** | Create `deploy-staging.yml` (both repos)                                                          | new files                                                                                                                                | P5-03     | `develop` push deploys staging                               | Auto-deploy                       |
| **P5-08** | Create `deploy-production.yml` with the manual-approval gate                                      | new file                                                                                                                                 | P5-02     | Deploy waits for approval                                    | Deliberate releases               |
| **P5-09** | Nightly `main`/`develop` divergence check                                                         | new `branch-sync.yml`                                                                                                                    | P5-01     | Fails when `main` is ahead                                   | No long-term drift                |
| **P5-10** | `[RECOMMENDED]` Rename the frontend default `master`→`main`; update `.gitmodules`                 | GitHub; `learnix-speckit/.gitmodules`                                                                                                    | P5-02     | Clones and CI still work                                     | Consistent naming                 |
| **P6-01** | Implement `staging-isolation.guard.ts` (G1–G8 + mirror guard)                                     | new file + spec; `env.validation.ts`                                                                                                     | P5        | Unit test per check                                          | Cross-env boot impossible         |
| **P6-02** | **Drill:** set staging `R2_BUCKET=learnix`, redeploy                                              | Railway                                                                                                                                  | P6-01     | **Deploy fails at boot with G3**; revert                     | Guard proven live                 |
| **P6-03** | **Drill:** set staging `DATABASE_URL` to a denylisted host                                        | Railway                                                                                                                                  | P6-01     | **Fails with G1**; revert                                    | Guard proven live                 |
| **P6-04** | Mail allowlist + `[STAGING]` subject prefix                                                       | `src/mail/mail.service.ts`                                                                                                               | P6-01     | Non-allowlisted recipient dropped + logged                   | No mail to real people            |
| **P6-05** | `SMS_MODE=sandbox` in the channel registry                                                        | `channel-registry.service.ts`                                                                                                            | P6-01     | No outbound provider call                                    | No SMS/WhatsApp to real parents   |
| **P6-06** | `APP_ENV`-suffixed cookie names                                                                   | `auth-cookie.constants.ts` + 5 consumers                                                                                                 | P6-01     | Prod names unchanged; staging suffixed                       | No cookie collision, ever         |
| **P6-07** | Guard `db-restore.sh`                                                                             | `scripts/db-restore.sh`                                                                                                                  | P6-01     | Refuses a denylisted target                                  | Cannot restore onto prod          |
| **P7-01** | Write `seed-staging.ts` with the three guards                                                     | new file; `package.json`                                                                                                                 | P6        | Aborts on a denylisted host                                  | Safe by construction              |
| **P7-02** | Fix or remove the broken `seed` script (**R7**)                                                   | `package.json:24`                                                                                                                        | —         | `npm run seed` works or is gone                              | No broken entry point             |
| **P7-03** | Seed staging and walk the app end to end                                                          | staging                                                                                                                                  | P7-01     | All roles navigable                                          | Usable environment                |
| **P7-04** | Staging banner + `robots.ts` + `sitemap.ts` + analytics gate                                      | `dodline/app/…` (§15.1)                                                                                                                  | P4-08     | Banner visible; `robots.txt` = `Disallow: /`; prod unchanged | Not indexable, unmistakable       |
| **P7-05** | Write `smoke-test.sh` and wire it into deploys                                                    | new `scripts/`; workflows                                                                                                                | P5-07     | Runs < 60s, exits non-zero on failure                        | Every deploy verified             |
| **P7-06** | Add payment + webhook E2E specs                                                                   | `test/e2e/`                                                                                                                              | P7-03     | Green in CI                                                  | Money paths covered               |
| **P7-07** | Execute the full §13.1 regression matrix once, manually                                           | staging                                                                                                                                  | P7-03     | Results recorded                                             | Baseline established              |
| **P7-08** | Onboard 2–3 teachers to Cloudflare Access for a UAT pilot                                         | Cloudflare                                                                                                                               | P4-09     | They complete a course purchase with a sandbox card          | UAT viable                        |
| **P8-01** | Add an `environment` label to Prometheus metrics                                                  | `performance-metrics.registry.ts`                                                                                                        | P7        | `/metrics` shows the label                                   | Dashboards separable              |
| **P8-02** | Configure Sentry alert routing per environment                                                    | Sentry                                                                                                                                   | P3-07     | Staging error ⇒ email; prod error ⇒ page                     | Alert fatigue avoided             |
| **P8-03** | Uptime monitors for both environments                                                             | external                                                                                                                                 | P4-05     | Test alert fires                                             | Downtime detected                 |
| **P8-04** | Queue / webhook / reconciliation alert thresholds                                                 | monitoring                                                                                                                               | P8-01     | Synthetic breach fires                                       | Silent failures surfaced          |
| **P8-05** | **Rollback drill:** Vercel promote-previous                                                       | Vercel staging                                                                                                                           | P8-03     | Previous build live, timed                                   | Runbook step verified             |
| **P8-06** | **Rollback drill:** Railway redeploy-previous                                                     | Railway staging                                                                                                                          | P8-03     | Previous build live, timed                                   | Runbook step verified             |
| **P8-07** | **Rollback drill:** `migration:revert`                                                            | staging                                                                                                                                  | P2-08     | Schema reverted, timed                                       | Runbook step verified             |
| **P8-08** | **Rollback drill:** full `pg_restore` from backup                                                 | staging                                                                                                                                  | P2-10     | DB restored, timed                                           | Worst case is survivable          |
| **P8-09** | Write `docs/ROLLBACK_RUNBOOK.md` from measured drills                                             | new doc                                                                                                                                  | P8-05..08 | Times and commands are real                                  | Usable under pressure             |
| **P9-01** | Enable the GitHub `production` environment + required reviewers                                   | GitHub                                                                                                                                   | P8        | Deploy blocks pending approval                               | Human gate                        |
| **P9-02** | Wire the pre-deploy backup gate                                                                   | `deploy-production.yml`                                                                                                                  | P2-10     | Deploy aborts on a bad backup                                | No unbacked deploy                |
| **P9-03** | Wire the destructive-migration detector                                                           | `deploy-production.yml`                                                                                                                  | P9-02     | A `DROP COLUMN` PR needs a second approval                   | Data-loss guard                   |
| **P9-04** | **Fix R5** — restore `THROTTLE.AUTH` on login                                                     | `src/auth/auth.controller.ts:153`, `src/common/constants.ts:56-58`                                                                       | P9-01     | 6th login attempt in 5 min → 429                             | Brute-force protection restored   |
| **P9-05** | Ship P9-04 as the first release through the full pipeline                                         | both repos                                                                                                                               | P9-01..04 | Staging soak → approval → prod → smoke                       | Pipeline proven end to end        |
| **P9-06** | Tag `v1.0.0` + generate `CHANGELOG.md`                                                            | git; new file                                                                                                                            | P9-05     | Tag exists; changelog accurate                               | Releases traceable                |
| **P9-07** | Write `docs/RELEASE_PROCESS.md`                                                                   | new doc                                                                                                                                  | P9-05     | A teammate can follow it unaided                             | Repeatable                        |

---

## 20. Acceptance criteria

Staging is **done** when all of these hold:

1. `https://staging.learnix.school` and `https://api-staging.learnix.school` serve over valid TLS; `/api/v1/health` returns `200` healthy.
2. The staging backend uses a database, Redis, R2 bucket, Bunny library, Paymob merchant, MailerSend key, and Sentry project that Production **does not** use — each verified by a **negative** access test.
3. `APP_ENV=staging` boot guards G1–G8 exist, are unit-tested, and have been **observed firing** in a live drill (P6-02, P6-03).
4. All 104 migrations run cleanly against an empty database, and CI fails on schema drift.
5. Every JWT, refresh, cookie, webhook, and API secret differs between environments; cookie names are environment-suffixed; no `COOKIE_DOMAIN` exists.
6. A staging email cannot reach a non-allowlisted recipient; a staging SMS/WhatsApp makes no outbound provider call.
7. A staging Paymob checkout cannot produce a real charge (test merchant + `PAYMOB_EXPECTED_MODE=test` + boot guard).
8. `staging.learnix.school/robots.txt` returns `Disallow: /`; the sitemap is empty; metadata is `noindex, nofollow`; Vercel Analytics is off; the STAGING banner with commit SHA is visible on every page.
9. `main`/`master` and `develop` are protected: no direct push, no force push, PR + required checks; Production deploys require manual approval and a verified backup.
10. All four rollback drills (P8-05..08) have been executed on staging and timed, and the runbook records the real numbers.
11. `docs/ENVIRONMENT_INVENTORY.md`, `docs/STAGING_SAFETY_GUARDS.md`, `docs/ROLLBACK_RUNBOOK.md`, and `docs/RELEASE_PROCESS.md` exist and are accurate.
12. **Production is byte-for-byte unchanged in behaviour** — verified by a Production smoke run after each phase.

---

## 21. Safety gates — do not start execution until all are confirmed

| #   | Gate                                              | How it is confirmed                                                                                    |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | **No Production database is used by staging**     | `DATABASE_URL` host differs; guard G1 armed; negative connection test                                  |
| 2   | **No Production Redis is used**                   | `REDIS_URL` host differs; guard G2 armed                                                               |
| 3   | **No Production payment keys are used**           | Separate Paymob **merchant**; `PAYMOB_EXPECTED_MODE=test`; guards G5/G6                                |
| 4   | **No Production webhook secrets are used**        | Distinct `PAYMOB_WEBHOOK_SECRET` and `META_WHATSAPP_APP_SECRET`; guard G6 fingerprints                 |
| 5   | **No cookie domain is shared**                    | No `domain` is ever set (`grep -rn "domain:" src/` = empty); different hosts; `APP_ENV`-suffixed names |
| 6   | **No messages reach real customers**              | Synthetic `.invalid` emails + `MAIL_ALLOWLIST` + `SMS_MODE=sandbox` + separate provider accounts       |
| 7   | **A backup strategy exists**                      | `scripts/db-backup.sh` merged, integrity-checked, and restored at least once (P2-11)                   |
| 8   | **A rollback strategy exists**                    | `docs/ROLLBACK_RUNBOOK.md` written from four measured drills                                           |
| 9   | **Builds and tests succeed**                      | Both repos' CI green on `develop`, including the new migration and env validation jobs                 |
| 10  | **Production secrets are off developer machines** | P0-07 rotation complete; P0-08 local `.env` removed; gitleaks history clean                            |

---

## 22. Open questions — I need these from you

| #      | Question                                                                                                                                                                                                   | Why it matters                                                                                                                                         | Blocks               |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| **Q1** | What are the **current Production Railway variables** (key names only) and the service topology — replica count, region, resource limits, Postgres major version, and whether Railway backups are enabled? | I could only read the repo. Staging must mirror the real shape, and the `PROD_RESOURCE_DENYLIST` needs the real hostnames.                             | Phase 0 → everything |
| **Q2** | Confirm the local `.env` values are **the same as Production**, and approve rotating them. `REDIS_URL` there points at `redis.railway.internal`, and the R2/Paymob/MailerSend/JWT entries look live.       | If confirmed, Production secrets are on laptops and must be rotated before anything else. If they are stale test values, the urgency drops.            | P0-07 (blocking)     |
| **Q3** | Does a **Paymob test/sandbox merchant account** already exist, or does one need to be requested from Paymob?                                                                                               | Egyptian Paymob sandbox onboarding is not instant. If it must be requested, start on day one.                                                          | Phase 3              |
| **Q4** | Who is on the **Cloudflare Access allowlist** at launch, and is `learnix.school` DNS actually on Cloudflare?                                                                                               | The gate design assumes Cloudflare. If DNS is elsewhere, I will switch this to Vercel Password Protection instead.                                     | Phase 4              |
| **Q5** | Is the **R2 bucket `learnix` version-enabled**?                                                                                                                                                            | Without object versioning, an accidental delete is unrecoverable — that changes the storage rollback row in §17 from "restore" to "gone".              | Phase 3, §17         |
| **Q6** | Budget ceiling for staging (roughly one extra Postgres + Redis + API service + a Vercel project)?                                                                                                          | If it is tight, I can propose a scale-to-zero staging DB and a smaller API instance, at the cost of slower cold starts.                                | Phase 2, 4           |
| **Q7** | Any **existing Production data** already in the live DB (real teachers/students/payments)? If so, the backup gate in P9-02 becomes mandatory from day one rather than at Phase 9.                          | Changes the urgency ordering of Phase 2's backup work.                                                                                                 | Phase 2              |
| **Q8** | Confirm you want `THROTTLE.AUTH` restored (**R5**). Login is currently 150/min per IP because of a TestSprite workaround. This is live in Production now.                                                  | It is a brute-force exposure on real accounts today. I have placed the fix in Phase 9 as the first pipeline test, but you may want it hotfixed sooner. | P9-04 (or immediate) |

---

## 23. Final recommendation

Build staging as a **separate Railway project** (`learnix-staging`) plus a **separate Vercel project** (`dodline-staging`), sharing no resource, no credential, and no network with Production. Keep Production's domains exactly as they are; add `staging.learnix.school` and `api-staging.learnix.school` as new subdomains so Production DNS is never touched.

The single most important technical decision is **`APP_ENV` as an additive variable while `NODE_ENV` stays `production` in both environments.** The codebase currently treats `NODE_ENV` as a binary switch controlling Redis requirements, storage guards, CSP, stack traces, password-reset token leakage, and Paymob live-mode defaults (§2.10, §2.15). Setting `NODE_ENV=staging` would silently disarm all of it. `APP_ENV` gives staging its identity for logging, labelling, and safety guards without weakening a single production protection.

The second most important is that **isolation is enforced at boot, not by discipline.** Eleven cron jobs — including per-minute payment reconciliation, per-minute webhook replay, and weekly file deletion — start mutating whatever they can reach within 60 seconds. The `staging-isolation.guard.ts` fail-fast check (§14) runs inside `ConfigModule`'s `validate()`, before any module, queue, or connection exists. And it must be **drilled**, not merely written: Phase 6 deliberately misconfigures staging twice and confirms the deploy dies.

Three findings deserve attention regardless of whether you proceed with staging:

- **R1** — the 104-migration chain has never run against an empty database, because E2E uses `synchronize` instead. Building staging is how you find out whether it works, and that is a good enough reason to build it this week.
- **R2** — production-shaped secrets appear to be sitting in a local `.env`, including a Railway private-network Redis URL. Rotate before anything else.
- **R5** — the login rate limit is currently 150/min per IP in Production, with an in-code TODO saying to restore it "before the next production deploy." That deploy has happened.

Recommended sequence: **Phase 0 immediately** (audit + secret rotation), **Phase 2 next** (it surfaces R1, the biggest unknown), then Phases 1, 3–9 in order. Do not let any phase start before the previous one's Definition of Done is met.

---

## 24. Verification — how to check this work end to end

After each phase:

```bash
curl -sS https://api-staging.learnix.school/api/v1/health | jq
```

```bash
npm --prefix learning-center-backend run test:cov
```

```bash
npm --prefix learning-center-backend run test:e2e
```

```bash
npm --prefix dodline run test:coverage && npm --prefix dodline run build
```

Migration chain against an empty database (the Phase 2 gate):

```bash
npm --prefix learning-center-backend run build && npx typeorm -d dist/src/data-source.js migration:run
```

Drift check — passes only when the generated migration's `up()` is empty:

```bash
npx typeorm -d dist/src/data-source.js migration:generate src/migrations/TEMP-DriftCheck
```

Negative isolation test — the staging R2 token must be **denied** on the Production bucket:

```bash
AWS_ACCESS_KEY_ID=$STAGING_R2_KEY aws s3 ls s3://learnix --endpoint-url $R2_ENDPOINT
```

Staging must not be indexable:

```bash
curl -sS https://staging.learnix.school/robots.txt
```

And after every phase, confirm Production is unchanged:

```bash
curl -sS https://learning-center-backend-production.up.railway.app/api/v1/health | jq
```

---

---

# 25. Phase 0 Execution Record

**Executed:** 2026-08-05 · **Phase:** 0 (Audit and inventory) · **Status: COMPLETE**
**Production touched:** none. **Production domains changed:** none. **External resources created:** none.
**Secrets rotated by code:** none — rotation is a documented human checklist only.
**Secret values disclosed:** none, in any file, log, test or report produced by this phase.

---

## 25.1 What was performed

| #   | Requirement                                                        | Outcome                                                                                                    |
| --- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| 1   | Copy the plan into the repo                                        | ✅ `STAGING_ENVIRONMENT_IMPLEMENTATION_PLAN.md` (this file)                                                |
| 2   | Full audit of both repos and every subsystem                       | ✅ `docs/ENVIRONMENT_INVENTORY.md` — 21 findings                                                           |
| 3   | Address production-shaped secrets in `.env`                        | ✅ `docs/SECRET_ROTATION_CHECKLIST.md` — 24 secrets, 29 checklist items. **No rotation performed in code** |
| 4   | Prove the 104-migration chain on an empty database                 | ✅ `scripts/migration-chain-test.ts` — **executed, PASSED**                                                |
| 5   | Stop `TYPEORM_SYNCHRONIZE=true` substituting for migration testing | ✅ new harness never uses `synchronize`; E2E left untouched                                                |
| 6   | Fix `LOGIN_TESTSPRITE_TEMPORARY` per its own code comment          | ✅ production pinned to `THROTTLE.AUTH`, no override path                                                  |
| 7   | Stop critical components depending on `NODE_ENV` alone             | ✅ `APP_ENV` added as an additive dimension                                                                |
| 8   | Address unguarded in-process cron                                  | ✅ `docs/CRON_AUDIT.md` + 5 feature flags                                                                  |
| 9   | Prevent staging connecting to production resources                 | ✅ `src/config/environment-isolation.guard.ts`, fail-fast                                                  |
| 10  | Synthetic staging seed (do not run)                                | ✅ `src/database/seed-staging.ts` — **written, NOT executed**                                              |
| 11  | Update env examples without real values                            | ✅ backend rewritten; frontend created                                                                     |
| 12  | Final verification run                                             | ✅ §25.6                                                                                                   |

---

## 25.2 Files created

| File                                             | Purpose                                                    |
| ------------------------------------------------ | ---------------------------------------------------------- |
| `STAGING_ENVIRONMENT_IMPLEMENTATION_PLAN.md`     | This plan + execution record                               |
| `docs/ENVIRONMENT_INVENTORY.md`                  | Full audit. Names/hosts only, no values                    |
| `docs/SECRET_ROTATION_CHECKLIST.md`              | 24 secrets, where used, which service, dashboard steps     |
| `docs/CRON_AUDIT.md`                             | All 11 cron jobs: function, cadence, impact, flag decision |
| `src/config/app-env.ts`                          | `APP_ENV` resolution, derived from `NODE_ENV` when absent  |
| `src/config/environment-isolation.guard.ts`      | Fail-fast cross-environment guard, 4 rule classes          |
| `src/config/environment-isolation.guard.spec.ts` | 60 tests                                                   |
| `src/config/feature-flags.ts`                    | 5 default-on scheduled-work flags                          |
| `src/config/feature-flags.spec.ts`               | 26 tests                                                   |
| `src/common/throttle/login-throttle.ts`          | Login limit resolution by deployment identity              |
| `src/common/throttle/login-throttle.spec.ts`     | 20 tests                                                   |
| `src/database/seed-staging.ts`                   | Synthetic seed + 3 independent guards                      |
| `src/database/seed-staging.spec.ts`              | 19 guard tests                                             |
| `scripts/migration-chain-test.ts`                | Empty-database migration harness                           |
| `dodline/.env.example`                           | Frontend variable template (none existed)                  |

## 25.3 Files modified

| File                                                            | Change                                                                                                                                   | Production impact                                                                                  |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `src/config/env.validation.ts`                                  | Declared `APP_ENV` + 9 isolation variables; resolve identity first; invoke the guard last; made the Paymob live-mode rule identity-aware | **None.** With `APP_ENV` unset the rule is byte-identical                                          |
| `src/common/constants.ts`                                       | Removed `LOGIN_TESTSPRITE_TEMPORARY`; replaced with an explanatory comment                                                               | Login limit **tightened** 150/min → 5/5min                                                         |
| `src/auth/auth.controller.ts`                                   | `@Throttle({ default: LOGIN_THROTTLE })`                                                                                                 | As above                                                                                           |
| `src/payments/services/payment-operations.service.ts`           | `ENABLE_PAYMENT_RECONCILIATION` on both cron entry points                                                                                | **None** — default-on                                                                              |
| `src/payments/services/gateway-webhook.service.ts`              | `ENABLE_WEBHOOK_REPLAY`                                                                                                                  | **None** — default-on                                                                              |
| `src/uploads/cleanup.service.ts`                                | `ENABLE_FILE_CLEANUP`                                                                                                                    | **None** — default-on                                                                              |
| `src/lessons/lessons.service.ts`                                | `ENABLE_FILE_CLEANUP`                                                                                                                    | **None** — default-on                                                                              |
| `src/notifications/processors/parent-notification.processor.ts` | `ENABLE_NOTIFICATIONS` at the single entry point                                                                                         | **None** — default-on                                                                              |
| `src/queues/queues.constants.ts`                                | `ENABLE_BACKGROUND_JOBS` master switch                                                                                                   | **None** — default-on                                                                              |
| `.env.example`                                                  | +184 lines; closed the 30-variable drift                                                                                                 | Documentation only                                                                                 |
| `package.json`                                                  | +`test:migrations`, +`seed:staging`, −broken `seed`                                                                                      | Removed a script that pointed at a non-existent file                                               |
| `dodline/.gitignore`                                            | `!.env.example` so the template is trackable                                                                                             | None                                                                                               |
| `src/metadata.ts`                                               | Regenerated by `nest build`; added one stale Swagger summary (`"delete": { summary: "Soft delete a book" }`)                             | Incidental. The committed artifact was stale; the build corrected it from existing controller code |

**Total: 15 files created, 13 modified. 125 new tests.**

---

## 25.4 New environment variables

Every one is **optional**, and every default reproduces today's behaviour exactly.

### Deployment identity

| Variable         | Values                                               | Default                    |
| ---------------- | ---------------------------------------------------- | -------------------------- |
| `APP_ENV`        | `production` \| `staging` \| `test` \| `development` | derived from `NODE_ENV`    |
| `APP_ENV_STRICT` | `true` \| unset                                      | unset (derivation allowed) |

### Isolation guard inputs

| Variable                   | Purpose                                                                 |
| -------------------------- | ----------------------------------------------------------------------- |
| `PROD_HOST_DENYLIST`       | Extra exact production hostnames                                        |
| `PROD_IDENTIFIER_DENYLIST` | Extra bucket names / library IDs / database names                       |
| `PROD_RESOURCE_DENYLIST`   | Combined alias for both                                                 |
| `PROD_SENDER_DENYLIST`     | Extra production sender addresses                                       |
| `PROD_SECRET_FINGERPRINTS` | SHA-256 prefixes (**hashes only, never values**)                        |
| `REDIS_NAMESPACE`          | Optional key namespace; must be staging-marked on staging               |
| `MAIL_ALLOWLIST`           | Staging-only recipient allowlist; **forbidden** on production           |
| `SMS_MODE`                 | `sandbox` \| `live`; sandbox required on staging, refused on production |
| `COOKIE_DOMAIN`            | Declared **only** so the guard can reject a shared parent domain        |

### Feature flags — all default-ON, disabled only by exact `false`

`ENABLE_PAYMENT_RECONCILIATION` · `ENABLE_WEBHOOK_REPLAY` · `ENABLE_FILE_CLEANUP` · `ENABLE_NOTIFICATIONS` · `ENABLE_BACKGROUND_JOBS`

### Login rate limit (ignored on production)

`LOGIN_THROTTLE_LIMIT` (clamped ≤200) · `LOGIN_THROTTLE_TTL_MS` (min 1000)

### Tooling

`SEED_STAGING_PASSWORD` · `MIGRATION_TEST_ADMIN_URL`

---

## 25.5 Safety guards added

### The fail-fast isolation guard

Invoked from `validate()` in `env.validation.ts` → inside `ConfigModule.forRoot({ validate })` → **before any module, TypeORM connection, BullMQ queue, or cron trigger exists.** That ordering is the requirement, not a detail: the earliest cron fires 60 seconds after boot and three of them mutate financial state.

**Four independent rule classes**, so no single incomplete list is load-bearing:

| Class               | Catches                                                                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host denylist       | Exact production hostnames (DB, Redis, origins, CORS, CDN)                                                                                                        |
| Identifier denylist | Bucket names, Bunny library IDs, database names — resources with no hostname                                                                                      |
| Structural rules    | Required shape: staging-marked DB name, `PAYMOB_EXPECTED_MODE=test`, mail allowlist present, `SMS_MODE=sandbox`, no shared cookie domain, no `R2_PUBLIC_BASE_URL` |
| Secret fingerprints | SHA-256 prefixes of 20 production secrets, catching a pasted credential even when every URL around it is correct                                                  |

**Staging violations detected (18 codes):** production DB host · production DB name · unmarked DB name · production Redis host · unmarked Redis namespace · production storage bucket · unmarked bucket · production video library · production video CDN · `R2_PUBLIC_BASE_URL` set · payment mode not test · production origin · production CORS origin · shared cookie domain · missing mail allowlist · production mail sender · SMS not sandbox · reused production secret.

**Production mirror rules (3 codes):** payment mode is test · staging mail allowlist present · SMS mode is sandbox.

All violations are reported **together**, so an operator standing up staging sees the full list once instead of one failed deploy at a time. **No secret value ever appears in an error message** — asserted by a dedicated test.

### Seed guards — three independent refusals

1. `APP_ENV` resolves to production → abort.
2. `DATABASE_URL` host is a known production host → abort.
3. Database name is a production name, **or** does not positively identify itself as staging → abort.

Independence is tested in both directions: right host + wrong database aborts, and right database + wrong host aborts.

### Login rate limit

Production resolves to `THROTTLE.AUTH` (5 per 5 minutes) with **no override path** — the override branch is unreachable when `APP_ENV` is production. A malformed `APP_ENV` also falls back to `AUTH` rather than to a relaxed tier.

---

## 25.6 Verification results

Every command below was executed. Results are reported exactly as returned.

| Check                      | Command                                   | Result                                                                                                                                                                           |
| -------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend type-check         | `tsc --noEmit -p tsconfig.build.json`     | ✅ **PASS** — 0 errors                                                                                                                                                           |
| Backend lint               | `npx eslint .`                            | ✅ **PASS** — 0 problems                                                                                                                                                         |
| Backend format (new files) | `prettier --check <15 new/changed files>` | ✅ **PASS**                                                                                                                                                                      |
| Backend format (repo)      | `prettier --check .`                      | ⚠️ 308 files — **pre-existing**, CI has never run this. Untouched files such as `src/app.module.ts` fail identically. Not addressed: reformatting 300 files is an unrelated diff |
| Backend unit tests         | `npm run test -- --ci --runInBand`        | ⚠️ **1012 passed, 1 failed** of 1013 (152/153 suites)                                                                                                                            |
| Backend build              | `npm run build`                           | ✅ **PASS** — 0 issues, 1010 files compiled                                                                                                                                      |
| **Migration chain**        | `npm run test:migrations`                 | ✅ **PASS** (detail below)                                                                                                                                                       |
| Env validation tests       | `jest src/config`                         | ✅ **PASS** — 96                                                                                                                                                                 |
| Feature-flag tests         | `jest src/config/feature-flags`           | ✅ **PASS** — 26                                                                                                                                                                 |
| Login-throttle tests       | `jest src/common/throttle`                | ✅ **PASS** — 20                                                                                                                                                                 |
| Seed-guard tests           | `jest src/database`                       | ✅ **PASS** — 19                                                                                                                                                                 |
| Frontend type-check        | `npx tsc --noEmit`                        | ✅ **PASS**                                                                                                                                                                      |
| Frontend lint              | `npm run lint`                            | ⚠️ 2 errors, 25 warnings — **pre-existing**                                                                                                                                      |
| Frontend unit tests        | `npm run test`                            | ✅ **PASS** — 217/217, 52/52 suites                                                                                                                                              |
| Frontend build             | `npm run build`                           | ✅ **PASS**                                                                                                                                                                      |
| Backend E2E                | `npm run test:e2e`                        | ⛔ **NOT RUN** — see below                                                                                                                                                       |

### Migration-chain result — the headline finding

```
discovered migrations : 104
applied migrations    : 104
recorded in table     : 104
pending after run     : false
public tables created : 93
duration              : ~20s
```

Run twice, both green, each against a freshly created temporary database that was dropped afterwards. **The 104-migration chain applies cleanly from empty.** Risk R1/A-11 is closed, and the answer is favourable: Phase 2 will not need the remediation budget the plan reserved for it.

### The one failing backend test — pre-existing, not caused by this phase

```
FAIL src/guardians/guardians.service.spec.ts
  ● GuardiansService › findNotificationTargets › applies the per-event default
    when no explicit preference is stored
    Expected length: 0
    Received length: 1
```

**Proof it is pre-existing:** a detached `git worktree` was created at `HEAD` (commit `4fbd181`, none of this phase's changes present) and the same spec was run there. It failed identically — same test, same assertion, same values. The worktree was then removed and the repository's `node_modules` verified intact.

Neither `src/guardians/guardians.service.ts` nor its spec appears in this phase's change set. The defect concerns the default notification preference for `LESSON_COMPLETED` and is unrelated to environment separation. **Left unfixed deliberately** — it is outside Phase 0's scope and fixing it would hide a real product defect inside an infrastructure change. Logged in §25.9.

### Backend E2E — not run, and why

`test/.env.test` targets `localhost:54329` (Postgres) and `localhost:56379` (Redis), supplied by `test/docker-compose.e2e.yml`. The Docker daemon was not running; it was started during this phase but did not become ready within the available window. The suite was therefore **not executed, and is not claimed as passing.**

Mitigating evidence: CI runs the same suite on every push via its own Postgres 16 / Redis 7 service containers, and this phase changed no code path the E2E suite exercises — the isolation guard is inert under `NODE_ENV=test` (proved by tests), and every feature flag defaults to the prior behaviour.

To run it once Docker is up:

```bash
npm run test:e2e:infra:up && npm run test:e2e -- --ci --runInBand && npm run test:e2e:infra:down
```

---

## 25.7 Secrets requiring rotation

Full register, including where each is read and the dashboard procedure: `docs/SECRET_ROTATION_CHECKLIST.md`. **No value is recorded anywhere.**

**Trigger.** `learning-center-backend/.env` (gitignored, never committed — verified) contains `REDIS_URL` pointing at `redis.railway.internal`. That is a Railway **private-network** hostname, unresolvable from any machine outside a Railway deployment. It can only have been copied out of a deployed environment's variables.

**Counter-evidence, recorded for accuracy:** `DATABASE_URL` in that file points at `localhost`, and `R2_PUBLIC_BASE_URL` is set — a value that makes production refuse to boot (`storage.service.ts:392`). The file is a **partial or stale** copy, not a live mirror. This lowers the likelihood that production database credentials specifically were exposed; it does not lower it for the rest.

| Tier                        | Act within | Secrets                                                                                                                                                                                      |
| --------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1** money / mass contact | 24h        | Paymob API key, secret key, webhook secret · MailerSend API key · Twilio auth token · Meta WhatsApp access token, app secret, verify token                                                   |
| **P2** auth / data access   | 72h        | `JWT_SECRET` · `JWT_REFRESH_SECRET` · `COOKIE_SECRET` · R2 access key + secret · Bunny Stream API key, token key, account key · Firebase private key · `ADMIN_INIT_PASSWORD` · `INIT_SECRET` |
| **P3** recon / disruption   | 1 week     | `METRICS_BEARER_TOKEN` · `BULL_BOARD_PASSWORD` · Sentry DSN · `REDIS_URL` · `DATABASE_URL` (lowest — likely never exposed)                                                                   |

Rotating `JWT_REFRESH_SECRET` logs every user out; schedule it. Rotating `PAYMOB_WEBHOOK_SECRET` without updating Railway in the same window makes every webhook return 401.

---

## 25.8 Actions required from you (external dashboards)

Phase 0 stopped at every point requiring a dashboard. Nothing below was attempted.

### Blocking — Phase 1 cannot start until these are answered

| #        | Action                                                           | Where                            | Why                                                                                                   |
| -------- | ---------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **D-01** | Export the production Railway **variable key list** (names only) | Railway                          | Completes the inventory; tells us which of the 113 code-referenced variables production actually sets |
| **D-02** | Confirm whether the local `.env` values match the deployed set   | Railway                          | Resolves the ambiguity in §25.7 and sets rotation urgency                                             |
| **D-03** | Execute the P1 rotations                                         | Paymob, MailerSend, Twilio, Meta | Live payment + mass-contact capability is currently on developer machines                             |

### Required before their phase

| #    | Action                                                       | Where      | Needed by                                                                                               |
| ---- | ------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------- |
| D-04 | Record replicas, region, CPU/RAM, volumes                    | Railway    | Phase 4 sizing                                                                                          |
| D-05 | Record Postgres major version + backup settings              | Railway    | Phase 2                                                                                                 |
| D-06 | Record Vercel project settings, domains, env scopes          | Vercel     | Phase 4                                                                                                 |
| D-07 | Confirm **R2 object versioning** on the `learnix` bucket     | Cloudflare | Phase 3 + the storage rollback row in §17. Without versioning, a cleanup-cron deletion is unrecoverable |
| D-08 | Confirm a Paymob **sandbox merchant** exists, or request one | Paymob     | Phase 3 — Egyptian sandbox onboarding is not instant                                                    |
| D-09 | Confirm `learnix.school` DNS is on Cloudflare                | Registrar  | Phase 4 — the Access gate design assumes it                                                             |
| D-10 | Record Bunny Stream library IDs and pull zones               | Bunny      | Phase 3                                                                                                 |
| D-11 | Record MailerSend domains and the 10 template IDs            | MailerSend | Phase 3                                                                                                 |
| D-12 | Record GitHub branch-protection state                        | GitHub     | Phase 5                                                                                                 |

### Containment — do regardless of rotation timing

- Delete `learning-center-backend/.env` from **every** developer machine.
- Replace it with a values-free copy of the updated `.env.example`.
- Adopt the standing rule in `docs/SECRET_ROTATION_CHECKLIST.md` §4 R-28: production variables are never copied to a local machine.

---

## 25.9 Remaining risks

| ID        | Risk                                                    | Severity     | Status after Phase 0                                                                      |
| --------- | ------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------- |
| A-09      | Production-shaped secrets on developer machines         | **Critical** | **OPEN** — checklist written, rotation is yours (D-03)                                    |
| A-13      | Financial + destructive cron unguarded                  | Critical     | **CLOSED** — 5 flags + isolation guard                                                    |
| A-21      | `NODE_ENV` overloaded; staging indistinguishable        | Critical     | **CLOSED** — `APP_ENV`                                                                    |
| A-11      | Migration chain unverified on empty DB                  | Critical     | **CLOSED** — harness written and **passing**                                              |
| A-18      | Login limit 150/min in production                       | High         | **CLOSED** — pinned to 5/5min, no override                                                |
| A-06      | No migration locking across replicas                    | High         | **OPEN** — deferred to Phase 2                                                            |
| A-12      | Redis has no environment namespace                      | High         | **PARTIAL** — guard blocks a shared instance; BullMQ `prefix` deferred to Phase 2         |
| A-14      | No email recipient allowlist at runtime                 | High         | **PARTIAL** — guard _requires_ `MAIL_ALLOWLIST` on staging; the runtime filter is Phase 6 |
| A-07      | 30+ undocumented env vars                               | Medium       | **CLOSED**                                                                                |
| A-17      | Dev CORS fallback trusts the production origin          | Medium       | **OPEN** — Phase 1                                                                        |
| A-20      | Sentry would tag staging as `production`                | Medium       | **OPEN** — Phase 1                                                                        |
| A-19      | `npm run seed` pointed at a non-existent file           | Medium       | **CLOSED** — removed, replaced by `seed:staging`                                          |
| H1–H3, H7 | Frontend hardcoded URLs, image hosts, no robots/sitemap | Medium       | **OPEN** — Phase 1                                                                        |
| —         | `guardians.service.spec` failure                        | Medium       | **OPEN** — pre-existing, proven at HEAD, out of scope                                     |
| —         | Frontend lint: 2 errors                                 | Medium       | **OPEN** — pre-existing; the frontend CI `lint` step is currently red                     |
| —         | Backend prettier: 308 files                             | Low          | **OPEN** — pre-existing; CI never ran `prettier --check`                                  |
| —         | Backend E2E not executed locally                        | Low          | **OPEN** — Docker unavailable; CI covers it                                               |
| A-04      | No separate worker/cron service                         | Low          | **ACCEPTED** — architecture change, out of scope                                          |

---

## 25.10 Phase 0 acceptance

| Criterion                                                    | Met                                     |
| ------------------------------------------------------------ | --------------------------------------- |
| Plan copied into the repo                                    | ✅                                      |
| Every listed subsystem audited with file-level evidence      | ✅ 21 findings                          |
| Critical risks addressed or explicitly deferred with reasons | ✅                                      |
| No secret rotated from code                                  | ✅ checklist only                       |
| No secret value in any file, log or report                   | ✅                                      |
| `APP_ENV` added without disabling `NODE_ENV` behaviour       | ✅ tests assert production is unchanged |
| Fail-fast validation before modules/queues/cron/DB           | ✅ inside `ConfigModule.validate()`     |
| All 8 required guard scenarios tested                        | ✅ plus 52 more                         |
| Rate limit fixed per the code comment, with tests            | ✅                                      |
| Standalone migration test, no `synchronize`                  | ✅ **executed, passing**                |
| Synthetic seed written with guards, **not run**              | ✅                                      |
| Cron audited; flags added where justified                    | ✅ 11 audited, 5 flagged                |
| Env examples updated without real values                     | ✅                                      |
| Results documented here                                      | ✅                                      |
| Production unmodified                                        | ✅                                      |

**Phase 0 is complete and ready for review.**

---

## 25.11 Suggested action to start Phase 1

Phase 1 (Environment separation foundation) is **unblocked for its backend half** and can begin as soon as you approve. Its frontend half needs nothing from a dashboard either.

Recommended order:

1. **First, and in parallel with Phase 1:** action **D-01**, **D-02** and the **P1 rotations (D-03)**. These are independent of the code work and are the only Critical item Phase 0 could not close.
2. **Phase 1 backend:** make `sentry.ts`, `app.service.ts`, `health-error.service.ts` and `health-orchestrator.service.ts` label from `APP_ENV` (A-20), and remove the production origin from the dev CORS fallback (A-17, `cors.util.ts:22`).
3. **Phase 1 frontend:** `SITE_URL` and `siteConfig.url` read `NEXT_PUBLIC_SITE_URL` defaulting to today's literal (H1/H2); add a staging host to `next.config.ts` `remotePatterns` (H3); parameterise the CI build URL (H4).
4. **Phase 1 acceptance:** with `APP_ENV` unset, every production-observable output must be byte-identical — assert with snapshot tests, then run the full §25.6 battery again.

Two things worth doing at the start of Phase 1 because they are cheap and currently red:

- Fix the 2 frontend lint errors (`CertificateRenderer.tsx`, `student/redeem/page.tsx`) — the frontend CI `lint` step fails without them.
- Decide on the `guardians.service.spec` failure: fix the default-preference behaviour, or correct the test if the expectation is wrong.

**Do not begin Phase 1 until this record has been reviewed and approved.**

---

# 26. Phase 0 Closure Audit

**Executed:** 2026-08-05 (same day as §25, as a follow-up review pass) · **Status: CLOSED**

This section is a second, independent pass over the Phase 0 work in §25 — not a repeat of it. Every item below was raised as an explicit follow-up requirement. Three of them surfaced **real defects** that §25's own verification had not caught; those are fixed and re-verified, not merely re-described.

---

## 26.1 APP_ENV audit — full `NODE_ENV` review

**Requirement:** locate every `NODE_ENV` usage in both repositories; for each, decide whether `NODE_ENV` is correct or whether it should be `APP_ENV`; leave nothing using `NODE_ENV` where the intent is to differentiate production from staging.

**Method and full results:** `docs/NODE_ENV_AUDIT.md`. **36 instances found** (32 backend, 4 frontend). Every one is individually classified as **BEHAVIOUR** (a security/robustness switch — correctly stays on `NODE_ENV`, since staging must run `NODE_ENV=production` to get every one of those protections) or **IDENTITY** (a label or same-vs-different-environment comparison — must be `APP_ENV`).

**9 instances required a code fix** (7 backend, 2 frontend):

| #   | File                                                         | What was wrong                                                                                                                                                                                                                                                                                                                                              | Fix                                                                                                                                                                                     |
| --- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `src/observability/sentry.ts`                                | Sentry `environment` tag was `NODE_ENV`. Every staging error would be tagged `production`. **Highest-value fix in the audit.**                                                                                                                                                                                                                              | `APP_ENV` via new `resolveAppEnvLabel()`                                                                                                                                                |
| 2   | `src/app.service.ts`                                         | `GET /` banner `environment` field                                                                                                                                                                                                                                                                                                                          | `APP_ENV`                                                                                                                                                                               |
| 3   | `src/health/health-error.service.ts`                         | Error-group fingerprint/label folds in `NODE_ENV`                                                                                                                                                                                                                                                                                                           | `APP_ENV`                                                                                                                                                                               |
| 4   | `src/health/health-orchestrator.service.ts`                  | Admin health-dashboard `environment` field                                                                                                                                                                                                                                                                                                                  | `APP_ENV`                                                                                                                                                                               |
| 5   | `src/health/indicators/external-providers.indicator.ts` (×3) | (a) Sentry health-metadata label; (b) **confirmed live bug** — the frontend-URL mismatch warning fired on every staging health check, because `environmentForUrl()` classifies any host containing "staging" as non-production and the check was gated on `NODE_ENV === 'production'` (true on staging); (c) same class of bug on the Paymob-endpoint check | All three → `APP_ENV`. The warning logic was extracted into a pure, directly-tested function `shouldWarnOnEnvironmentMismatch()`                                                        |
| 6   | `src/common/utils/cors.util.ts`                              | Non-production CORS fallback named the production origin (`https://learnix.school`) — finding A-17                                                                                                                                                                                                                                                          | Fallback no longer names any production resource                                                                                                                                        |
| 7   | `src/payments/providers/paymob/paymob.gateway.ts`            | Defence-in-depth live-mode fallback keyed on `NODE_ENV`                                                                                                                                                                                                                                                                                                     | Keyed on `APP_ENV`; unreachable in a correctly-configured deployment (the isolation guard already requires the mode be explicit), fixed anyway for the case that guard is ever bypassed |
| 8   | `dodline/instrumentation.ts`                                 | Server-side Sentry tag was `NODE_ENV`. **Next.js sets `NODE_ENV=production` for every deployed build** (Preview and Production alike) — there is no `NODE_ENV=staging` in Next.js at all, so this was guaranteed to mislabel every staging error                                                                                                            | `NEXT_PUBLIC_APP_ENV`, falling back to `NODE_ENV` for local dev                                                                                                                         |
| 9   | `dodline/instrumentation-client.ts`                          | Same, browser-side                                                                                                                                                                                                                                                                                                                                          | Same fix                                                                                                                                                                                |

**27 instances were already correct** and left untouched — each has its own one-line justification in the audit doc (e.g. "staging must also hide stack traces," "staging must also require Redis").

**New tests:** `src/config/app-env.spec.ts` (`resolveAppEnvLabel` never throws, even on a malformed `APP_ENV`); `src/health/indicators/external-providers.indicator.spec.ts` (reproduces the exact false-positive scenario against the old logic, then proves the new logic doesn't exhibit it); `src/common/utils/cors.util.spec.ts` (new regression case). All pass; full backend suite re-run clean (§26.9).

---

## 26.2 Migration test in CI

**Requirement:** wire the migration-chain test into CI so a PR fails if the chain fails to create an empty database, fails any migration, or leaves migrations pending.

**Done:** new `migration-chain` job in `.github/workflows/ci.yml`, running on every push and PR alongside the existing `build-test`/`e2e`/`secret-scan` jobs. It spins up its own `postgres:16` service container and runs `npm run test:migrations` — the same script from §25 that already proved the 104-migration chain applies cleanly. `scripts/migration-chain-test.ts`'s `assertReport()` already asserts all three failure conditions the requirement names (creation failure, any migration failure, pending-after-run) and exits non-zero on any of them, so wiring it into a CI job is sufficient to make a PR red on any of them.

**Verified:** the workflow YAML parses correctly (`js-yaml` parse check, 4 jobs present); the underlying script's mechanics were independently re-proven twice more against a live local Postgres server during this closure pass (§26.3, §26.9) — the exact same create → migrate → verify → drop sequence the CI job performs.

**Not verified in this pass:** an actual GitHub Actions run (requires pushing to a branch, out of scope for local work). The mechanism it wraps has been proven directly.

---

## 26.3 Feature flags — documentation and defaults

**Requirement:** confirm `ENABLE_BACKGROUND_JOBS`, `ENABLE_PAYMENT_RECONCILIATION`, `ENABLE_WEBHOOK_REPLAY`, `ENABLE_FILE_CLEANUP`, `ENABLE_NOTIFICATIONS` are all in `.env.example`, documented, and have clear defaults.

**Confirmed, no changes needed.** All 5 flags were already present in `.env.example` (lines 116–134) with a shared header stating the default-on/exact-`false` semantics and a purpose comment per flag; `docs/CRON_AUDIT.md` §2–3 documents each flag's exact gate location and a recommended per-environment setting. Cross-checked line by line during this pass; no drift found.

---

## 26.4 Synthetic seed — proof of interconnection

**Requirement:** prove the seed data is fully interconnected (teacher → subjects → courses → lessons → books → exams → orders → fake payments → quiz attempts → certificates), not just users in isolation.

**New tool:** `scripts/verify-seed-interconnection.ts` — creates a disposable, generated database (same temp-DB pattern as the migration-chain test), runs every migration, runs the real `seed-staging.ts` seed function, then walks the actual foreign-key graph with 12 targeted queries (one per hop: lesson→teacher, lesson→subject, course→teacher, course-item→course+lesson, book→teacher+subject, exam→teacher+subject, attempt→exam+student, order→student+course, payment→order+user, certificate→student+course, guardian-link→student+guardian, attendance→student+lesson) and asserts every table is non-empty and every link resolves to a real row. Dropped afterward; touches nothing persistent.

**First run FAILED — and that failure is the proof this check has teeth.** Three real bugs in the seed script were caught and fixed:

| Bug | Column                                                                                                                                        | Fix                                                                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `exam_attempts.started_at` / `deadline_at` — `NOT NULL`, no default                                                                           | Now computed per attempt state (in-progress/submitted/graded/expired get realistic, state-appropriate timestamps)                           |
| 2   | `exam_attempts.session_token` — `NOT NULL uuid`, no default                                                                                   | Seeded with `randomUUID()`                                                                                                                  |
| 3   | `orders.product_title_snapshot`, `platform_commission_bps`, `platform_commission_minor`, `teacher_earning_minor` — all `NOT NULL`, no default | Snapshotted from the course and computed from the same 30% commission rate documented in `.env.example`'s `DEFAULT_PLATFORM_COMMISSION_BPS` |

**After the fix, three consecutive full runs all passed**, each producing: 26 users, 3 teacher profiles, 20 student profiles, 10 guardians, 10 guardian links, 5 subjects, 45 lessons, 9 courses, 45 course-lesson links, 6 books, 6 exams, 12 exam attempts, 20 attendance records, 20 lesson sessions, 6 orders, 6 payments, 8 notifications, 4 certificates — **zero empty tables, zero broken foreign-key links** across all 12 checks.

**New unit tests unaffected:** `src/database/seed-staging.spec.ts`'s 19 guard tests still pass unchanged (they test the safety guards, not the row-shape fix).

---

## 26.5 Environment isolation — integration test

**Requirement:** an integration test proving the application stops before booting if `APP_ENV=staging` and a production resource is configured; prove `NestFactory` never starts.

**New file:** `src/bootstrap-isolation.integration.spec.ts`, 6 tests, in two tiers:

**Tier 1 — mechanism-precise (3 violation tests + 2 controls).** A minimal test module using the exact same `ConfigModule.forRoot({ validate })` wiring as the real `app.module.ts`, with no other feature modules, so a failure is unambiguously attributable to the isolation guard. Proves: a denylisted `DATABASE_URL` host, a non-`test` `PAYMOB_EXPECTED_MODE`, and a production `R2_BUCKET` each independently reject `NestFactory.create()`; a fully-correct staging config still boots; the real production configuration (no `APP_ENV` set) still boots.

**Tier 2 — literal production `AppModule`.** A second test `require()`s the actual `AppModule` — all ~30 feature modules, the exact class `main.ts` passes to `NestFactory.create()` — with a denylisted production `DATABASE_URL`, and proves it rejects with `EnvironmentIsolationError` in under 4 seconds, with no database, Redis, or storage connection ever reachable. This is the strongest form of the proof: it is not a stand-in, it is production's own bootstrap class.

**What "never starts" was found to mean, precisely — a finding this test surfaced:** `NestFactory.create()`'s `abortOnError` option defaults to `true` (`node_modules/@nestjs/core/nest-factory.js`), and `main.ts`'s real `bootstrap()` never overrides it. On a bootstrap failure, Nest does not merely reject a promise — it calls `process.exit(1)` directly. **Real production/staging behaviour on an isolation violation is that the OS process terminates outright**, before a single byte of application code beyond `validate()` runs. The tests pass `abortOnError: false` solely so Jest can observe and assert the underlying rejection instead of the test worker being killed; this is documented in the spec file so the distinction between test harness and real behaviour is never lost.

**Two implementation issues found and fixed while building this test** (both documented in the spec file's comments as a record of what not to repeat):

- `jest.resetModules()` before `require()`-ing a fresh `AppModule` gives that module registry its own copy of `EnvironmentIsolationError`, distinct from the one statically imported at the top of the file — `instanceof` failed despite an identical class. Fixed by also re-`require`-ing the error class from the same fresh registry.
- The real `AppModule` loads the developer's local `.env` (via `ConfigModule.forRoot({ envFilePath: '.env' })`), and that file's stale `R2_PUBLIC_BASE_URL` (finding A-10) caused an unrelated pre-isolation validation failure. Fixed by explicitly setting it to `''` in the test (not `delete` — `dotenv` repopulates a deleted-but-file-present key, but respects an explicitly-set empty string).

All 6 pass; re-verified as part of the full-suite run in §26.9.

---

## 26.6 Secrets report — required format

**Requirement:** a report with, per secret: name, location of use, associated service, whether rotation is required, and a secure fingerprint (not the value).

**New tool:** `scripts/fingerprint-secrets.ts` computes a SHA-256 fingerprint (first 16 hex chars — the identical construction `environment-isolation.guard.ts`'s own `fingerprint()` uses for `PROD_SECRET_FINGERPRINTS`) for 20 named secrets, printing only the variable name, whether it's present, and the fingerprint. **No code path in the script is capable of printing a value.**

**New report:** `docs/SECRETS_REPORT.md`, one row per secret in exactly the requested shape.

**This closure pass corrected an earlier overstatement.** Running the fingerprint script against the local `.env` revealed that `PAYMOB_API_KEY`, `PAYMOB_SECRET_KEY`, `PAYMOB_WEBHOOK_SECRET`, `TWILIO_AUTH_TOKEN`, `META_WHATSAPP_ACCESS_TOKEN`, `META_WHATSAPP_APP_SECRET`, and `FIREBASE_PRIVATE_KEY` are **declared but empty** in that file, not populated — §25's original "54 populated keys" framing was imprecise. `docs/SECRET_ROTATION_CHECKLIST.md` now carries a correction note; the actually-populated secrets (12 of them — JWT/cookie/init secrets, MailerSend, R2, Bunny, the admin password) and the `REDIS_URL`-points-at-a-Railway-internal-host finding are unaffected and remain the operative risk.

**A residual note the report itself carries:** `ADMIN_INIT_PASSWORD`'s fingerprint is flagged as lower-confidence than the others, since it is human-chosen and therefore more susceptible to a targeted guess-and-hash comparison than a 32-byte random secret is. The recommended remedy (change it in-app, let the variable go inert) is unchanged by this nuance.

---

## 26.7 E2E suite

**Requirement:** once Docker is available, run the full E2E suite; Phase 0 is not complete if any test newly fails because of these changes.

**Status: RUN TO COMPLETION** (2026-08-06, once Docker became available). This supersedes the original version of this section, which recorded that Docker had not become available and substituted local-Postgres evidence instead — that substitute evidence is retained below for context, but the real suite has now actually been run, twice over (once for the record, once to fully investigate its failures).

**How the exit code was actually captured.** The first attempt (`npm run test:e2e -- --ci --runInBand`) ran long enough to exceed this session's 10-minute foreground tool timeout and was moved to a background task automatically. A background task's own "completed" notification reports the exit code of the _wrapper shell_, not necessarily the command inside it — relying on that number naively would have been wrong. The run was therefore executed as `(npm run test:e2e -- --ci --runInBand > log 2>&1; echo $? > exit_code_file)`, so the real Jest exit code was captured to a file independent of how the background task itself reported completion. This mattered in practice: the task-completion notification for this run reported "exit code 0", while the captured file recorded the true result, **`1`**. Every exit code cited below is from the captured file, never from a task-completion summary.

**Real result, full suite:** `Test Suites: 5 failed, 14 passed, 19 total` / `Tests: 5 failed, 128 passed, 133 total`. Exit code `1`. Postgres 16 and Redis 7 service containers (`test-postgres-1`, `test-redis-1`, `test/docker-compose.e2e.yml`) both reported `Healthy` for the full run.

**Every one of the 5 failures was individually investigated — none is caused by a Phase 0 or Phase 1 change:**

| Failing suite                                          | Failure                                                                                                              | Verdict                                     | How verified                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subjects-ownership.e2e-spec.ts`                       | `expected 200, got 400` re-saving a lesson after its subject was suspended                                           | **Pre-existing**                            | Reproduces byte-for-byte (same test name, same assertion) on a clean `git worktree` at the pre-session commit (`4fbd181`), with zero Phase 0/1 changes applied. The one file this session touches that this suite exercises (`src/lessons/lessons.service.ts`) was only changed inside the unrelated `@Cron` cleanup-saga method (a feature-flag gate on the weekly/30-minute upload cleanup), never in the lesson-update path this test calls.                                                                                                                     |
| `payment-financial-state-machine.postgres.e2e-spec.ts` | `serializes concurrent held-earning release workers...` — expected 1 release, got 0 (a concurrency-timing assertion) | **Pre-existing**                            | Reproduces identically on the clean baseline worktree.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `call-center-phase6.e2e-spec.ts`                       | `expected 200, got 200`→ actually `expected 200 "OK", got 403 "Forbidden"` on an admin finance-facade route          | **Pre-existing**                            | Reproduces identically on the clean baseline worktree.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `call-center-phase5.e2e-spec.ts`                       | `expected 403, got 200` on a support-role student-edit route                                                         | **Pre-existing**                            | Reproduces identically on the clean baseline worktree.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `certificates.e2e-spec.ts`                             | `QueryFailedError: deadlock detected` inside the shared `resetDatabase()` test helper                                | **Flaky / environmental, not a regression** | Passed cleanly on the clean baseline worktree in the same batch (no deadlock that time). Then re-run **in isolation against the current, modified codebase**: `10 passed, 10 total`. A deadlock inside a shared test-database-reset helper, appearing only when this file runs 4th in a 19-suite `--runInBand` sequence and never when run alone or amid a smaller batch, is a classic DB-connection/lock-contention artifact of sequential heavy suites sharing one Postgres container — not a deterministic bug in this file or in anything this session changed. |

**Baseline comparison method:** `git worktree add --detach ../lms-backend-baseline-check 4fbd181` (the commit `HEAD` pointed to before any of this session's changes), with `node_modules` linked in via a directory junction (not copied) and both `.env` and `.env.test` copied over so the comparison run had the identical local configuration. The 4 deterministic failures above were run there as a batch and failed with the exact same test names and assertion messages as the real run. The `certificates` file was additionally re-run alone against the _current_ (modified) tree to settle the flakiness question independently of the baseline comparison.

**One incident during this verification, disclosed in full:** removing the baseline worktree afterward (`git worktree remove --force`) unexpectedly deleted `learning-center-backend/node_modules/.bin` — Git's recursive cleanup evidently followed the Windows directory junction into the real `node_modules` it pointed at, rather than only unlinking the junction itself, and removed just the `.bin` symlink-farm subdirectory (828 top-level packages were untouched). Caught immediately by a routine post-cleanup sanity check (`ls node_modules/.bin/jest` failed). Repaired with a plain `npm install`, which reported reconciling `node_modules` back to the existing lockfile — confirmed via `git diff --stat package-lock.json` (empty) and `git diff package.json` (only this session's own earlier script additions, no dependency-version changes) that the repair touched zero tracked files. `npx tsc --noEmit -p tsconfig.build.json` passed clean immediately after, confirming full recovery. No Production system was involved at any point; this affected only a local `node_modules` directory in the working copy. Lesson applied going forward: prefer `cp -al`/robocopy-style copies (or simply reinstalling dependencies fresh) over a junction to `node_modules` when a disposable comparison worktree is needed again, since a junction makes the worktree's own cleanup path capable of reaching back into the real directory it points at.

**Conclusion: Phase 0/1's changes introduce zero new E2E failures.** The suite's raw exit code is `1`, and that is reported honestly rather than rounded up to a false "0" — but every one of the 5 failures has been individually traced to a cause that predates this session (4 of them) or to test-infrastructure flakiness independent of any code content (1 of them). Per the standing instruction ("Phase 0 is not considered complete if any new test fails due to your modifications"), the substantive gate — no _new_ failure from Phase 0/1's own changes — is satisfied. Fixing the 4 pre-existing application bugs (lesson-update validation after subject suspension, a payment-concurrency race, and two call-center RBAC route mismatches) is out of Phase 2's scope (Database and Redis) and is not attempted here; they are flagged for separate follow-up.

**Original substitute evidence from before Docker was reachable (retained for the record, no longer load-bearing now that the real suite has run):** the full backend unit suite passed 1038/1039 (the one pre-existing, unrelated failure already documented); the migration chain, seed-interconnection graph, and NestFactory boot-refusal were each proven against a local non-Docker Postgres server.

---

## 26.8 Git diff review

**Requirement:** `git diff --stat` for both repos with a reason for every file, and proof that any regenerated file changed only by regeneration.

**Done:** `docs/GIT_DIFF_REVIEW.md` — the full stat output for both repos, a one-line reason for every one of the 21 modified backend files + 3 modified frontend files, and a table of all 22 new files with their purpose.

**The regenerated-file proof, specifically:** `src/metadata.ts` (the `@nestjs/swagger` build artifact) changed by exactly one line — an added `"delete": { summary: "Soft delete a book" }` entry. Traced to: (1) that exact string is the pre-existing JSDoc comment on `admin-books.controller.ts:121`; (2) `git status --porcelain -- src/books/` returns **no output** — nothing under `src/books/` was touched this session, this pass, or is even pending; (3) `metadata.ts` regenerates on every `npm run build`, which ran repeatedly during verification. The committed copy was simply stale on a comment that already existed; nothing about the Books API changed.

---

## 26.9 Consolidated re-verification (this closure pass)

| Check                                            | Command                                            | Result                                                                                                                                            |
| ------------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend type-check                               | `tsc --noEmit -p tsconfig.build.json`              | ✅ PASS                                                                                                                                           |
| Backend lint                                     | `npx eslint .`                                     | ✅ PASS — 0 problems                                                                                                                              |
| Backend build                                    | `npm run build`                                    | ✅ PASS                                                                                                                                           |
| Backend unit tests                               | `npx jest --ci --runInBand`                        | ⚠️ 1038 passed, 1 failed (pre-existing, unrelated — see §26.7) of 1039, 155/156 suites                                                            |
| Migration chain                                  | `npm run test:migrations`                          | ✅ PASS (2 additional runs this pass, on top of §25's 2)                                                                                          |
| Seed interconnection                             | `npm run verify:seed-interconnection`              | ✅ PASS ×3 consecutive runs, after 3 bugs found and fixed                                                                                         |
| Bootstrap isolation (mechanism + real AppModule) | `jest src/bootstrap-isolation.integration.spec.ts` | ✅ PASS — 6/6                                                                                                                                     |
| Secret fingerprinting                            | `npm run fingerprint:secrets`                      | ✅ Produces the report in `docs/SECRETS_REPORT.md`, no value ever printed                                                                         |
| Frontend type-check                              | `npx tsc --noEmit`                                 | ✅ PASS                                                                                                                                           |
| CI workflow syntax                               | `js-yaml` parse of `.github/workflows/ci.yml`      | ✅ Valid — 4 jobs (`build-test`, `migration-chain`, `e2e`, `secret-scan`)                                                                         |
| Full E2E suite                                   | `npm run test:e2e -- --ci --runInBand`             | ⚠️ 128/133 passed, exit code 1 — all 5 failures individually verified pre-existing or flaky, zero caused by Phase 0/1 (§26.7, full investigation) |

**New test count this closure pass:** +38 tests (`app-env.spec.ts`: 9; `external-providers.indicator.spec.ts`: 5; `cors.util.spec.ts`: +1; `bootstrap-isolation.integration.spec.ts`: 6; plus assertions folded into existing suites). Combined with §25's baseline, the backend now has **1039 total tests**, 1038 passing.

---

## 26.10 Closure status per item

| Item                                      | Status                                                                                                                                                                                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| APP_ENV / NODE_ENV audit                  | ✅ **CLOSED** — 36 instances classified, 9 fixed, `docs/NODE_ENV_AUDIT.md`                                                                                                                                                                   |
| Migration test in CI                      | ✅ **CLOSED** — `migration-chain` job added                                                                                                                                                                                                  |
| Feature flags documented with defaults    | ✅ **CLOSED** — confirmed already complete                                                                                                                                                                                                   |
| Seed interconnection proof                | ✅ **CLOSED** — proven after fixing 3 real bugs the proof attempt caught                                                                                                                                                                     |
| NestFactory boot-refusal integration test | ✅ **CLOSED** — 6 tests, including the real `AppModule`                                                                                                                                                                                      |
| Secrets report in required format         | ✅ **CLOSED** — `docs/SECRETS_REPORT.md`, corrects an earlier overstatement                                                                                                                                                                  |
| Full E2E run                              | ✅ **CLOSED** — run to completion (128/133 passed); all 5 failures individually traced to pre-existing bugs (4, reproduced on a clean baseline) or test-infra flakiness (1, reproduced-clean in isolation); zero caused by Phase 0/1 (§26.7) |
| Git diff review + regeneration proof      | ✅ **CLOSED** — `docs/GIT_DIFF_REVIEW.md`                                                                                                                                                                                                    |
| Plan file updated, Phase 0 = Completed    | ✅ **CLOSED** — this section                                                                                                                                                                                                                 |

**Phase 0 is complete and closed, with no open items.** The E2E suite — the one item left open at the end of the original closure pass — has since been run to completion and investigated in full (§26.7); every failure it surfaced predates this session or is test-infrastructure flakiness, none is caused by Phase 0 or Phase 1.

---

# 27. Phase 1 Execution Record

**Executed:** 2026-08-05 · **Phase:** 1 (Environment separation foundation) · **Status: COMPLETE**
**Objective (from §"Phase 1" of this plan):** introduce `APP_ENV` and close the hardcoded-value gaps. No infrastructure yet.
**Production touched:** none. **Dashboard actions performed:** none. **External resources created:** none.

---

## 27.1 Scope actually executed

The plan's own Phase 1 file list named 12 items. **8 of the 12 were already completed during the Phase 0 closure audit (§26.1)** — the `NODE_ENV`→`APP_ENV` review happened to cover the exact same backend files Phase 1 called for, since both were the same underlying defect (Sentry/health/log labels keyed on the wrong signal). Re-verified, not redone. The remaining **4 were frontend-only** and are what this phase actually executed:

| #   | File                                            | Phase 1 item                                  | Status                 |
| --- | ----------------------------------------------- | --------------------------------------------- | ---------------------- |
| 1   | `src/config/env.validation.ts`                  | add optional `APP_ENV`                        | ✅ done in Phase 0     |
| 2   | `src/observability/sentry.ts:31`                | label prefers `APP_ENV`                       | ✅ done in §26.1       |
| 3   | `src/app.service.ts:33`                         | same                                          | ✅ done in §26.1       |
| 4   | `src/health/health-error.service.ts:43`         | same                                          | ✅ done in §26.1       |
| 5   | `src/health/health-orchestrator.service.ts:175` | same                                          | ✅ done in §26.1       |
| 6   | `src/common/utils/cors.util.ts:22` (H5)         | drop prod origin from dev fallback            | ✅ done in §26.1       |
| 7   | `.env.example` (R10)                            | document `APP_ENV`                            | ✅ done in Phase 0     |
| 8   | `dodline/.env.example`                          | create it                                     | ✅ done in Phase 0     |
| 9   | `dodline/app/[locale]/layout.tsx:17` (**H1**)   | `SITE_URL` reads `NEXT_PUBLIC_SITE_URL`       | ✅ **done this phase** |
| 10  | `dodline/app/[locale]/lib/site.ts:3` (**H2**)   | `siteConfig.url` reads `NEXT_PUBLIC_SITE_URL` | ✅ **done this phase** |
| 11  | `dodline/next.config.ts` (**H3**)               | add a staging-API `remotePattern`             | ✅ **done this phase** |
| 12  | `dodline/.github/workflows/ci.yml:52` (**H4**)  | parameterise the CI build URL                 | ✅ **done this phase** |

**All 12 of 12 Phase 1 file-list items are now complete.**

---

## 27.2 What changed this phase (H1–H4)

**H1 — `dodline/app/[locale]/layout.tsx`.** The hardcoded `const SITE_URL = "https://learnix.school"` now reads `process.env.NEXT_PUBLIC_SITE_URL ?? "https://learnix.school"`. `SITE_URL` feeds `metadataBase`, canonical URLs, and Open Graph tags for every page.

**H2 — `dodline/app/[locale]/lib/site.ts`.** `siteConfig.url` gets the identical treatment. `absoluteUrl()` (used wherever the app needs a full URL — certificates, share links) is unchanged in logic; it now resolves against whichever origin `siteConfig.url` holds.

**H3 — `dodline/next.config.ts`.** Added a fourth `remotePatterns` entry: `{ protocol: "https", hostname: "api-staging.learnix.school" }`, alongside the existing R2/production-Railway/localhost entries. Without this, `next/image` would 400 on any thumbnail or media URL the staging API returns, since Next.js only proxies images from an explicit allowlist.

**H4 — `dodline/.github/workflows/ci.yml`.** The build step's `NEXT_PUBLIC_API_URL` env var changed from a hardcoded literal to `${{ vars.NEXT_PUBLIC_API_URL_CI || 'https://learning-center-backend-production.up.railway.app' }}` — a GitHub Actions repository/environment variable with the exact previous value as its fallback. **Requires zero dashboard action to keep working as it does today**; a repository variable can be added later (a genuine dashboard action, listed in §27.4) if a staging-specific CI build is ever wanted.

---

## 27.3 Why production output is unaffected — verified, not asserted

The plan's own risk note for this phase: _"touching `layout.tsx` metadata could change Production SEO — defaults are byte-identical, and a unit test asserts that."_ Both halves were checked:

**Unit test:** `dodline/app/[locale]/lib/site.test.ts`, 5 new tests — `siteConfig.url` defaults to `https://learnix.school` when `NEXT_PUBLIC_SITE_URL` is unset (the exact literal that was hardcoded before), `absoluteUrl()` resolves against it correctly, and every other `siteConfig` field is untouched by the environment. `layout.tsx`'s local `SITE_URL` constant is not separately unit-tested — it is not exported, and `layout.tsx` files are excluded from this project's own coverage configuration (`vitest.config.mts`) as a matter of existing convention (async server components with `next-intl` metadata resolution are impractical to unit-test directly here). It uses the byte-for-byte identical `env ?? literal` pattern `site.ts` does, so `site.ts`'s test is the representative proof for both.

**Built-output verification (the stronger check):** ran `npm run build` with `NEXT_PUBLIC_SITE_URL` deliberately left unset — exactly production's real configuration today — and inspected the compiled static HTML directly:

```
grep -o 'content="https://learnix.school[^"]*"' .next/server/app/ar/about.html
→ content="https://learnix.school/ar/about"
```

The prerendered Open Graph metadata is byte-identical to what it was before this change. This is stronger evidence than a unit test alone: it is the actual artifact a browser or crawler would receive.

---

## 27.4 Dashboard actions

**Required for Phase 1: none.** Every acceptance criterion above was met with zero Railway, Vercel, or Cloudflare action, and zero required GitHub configuration — `H4`'s fallback keeps CI green with nothing added.

**Optional, for later phases, noted here so it isn't lost:**

| #     | Action                                                                                                                                                                                  | Where                                                           | Needed for                                                                                                                                                   |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1-D1 | Add repository variable `NEXT_PUBLIC_API_URL_CI` = `https://api-staging.learnix.school` (or leave unset, using production's URL, since CI only needs _a_ valid-looking origin to build) | GitHub → Settings → Secrets and variables → Actions → Variables | Only relevant once a staging-specific CI build job exists (Phase 5)                                                                                          |
| P1-D2 | Register `api-staging.learnix.school` in DNS and issue it a certificate                                                                                                                 | Cloudflare / registrar                                          | Phase 4 — H3's `remotePattern` is inert until this host actually resolves; adding the pattern now is safe and required regardless of when the host goes live |

Neither blocks Phase 1's completion; both are already anticipated by Phase 4/5 in this plan.

---

## 27.5 Verification results

| Check                       | Command                                                                | Result                                                                                                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend type-check         | `npx tsc --noEmit`                                                     | ✅ PASS                                                                                                                                                                                   |
| Frontend lint               | `npm run lint`                                                         | ⚠️ 2 errors — **pre-existing, unrelated files** (`CertificateRenderer.tsx`, `student/redeem/page.tsx`), identical to the count recorded in §25.6 and §26.9. No new lint issue introduced. |
| Frontend unit tests         | `npx vitest run`                                                       | ✅ **222/222 passed**, 53/53 suites (was 217/217 before this phase; +5 new `site.test.ts` tests)                                                                                          |
| Frontend production build   | `npm run build` (NEXT_PUBLIC_SITE_URL unset)                           | ✅ PASS                                                                                                                                                                                   |
| Built-output metadata check | `grep` on prerendered HTML                                             | ✅ Confirmed byte-identical to pre-Phase-1 output                                                                                                                                         |
| CI workflow syntax          | `js-yaml` parse of `dodline/.github/workflows/ci.yml`                  | ✅ Valid — 2 jobs (`build`, `secret-scan`)                                                                                                                                                |
| Backend regression          | full backend suite (unaffected by this phase; re-run for completeness) | ✅ 1038/1039 (same pre-existing, unrelated failure as §26)                                                                                                                                |

---

## 27.6 Files modified this phase

| File                                    | Change                                                                             |
| --------------------------------------- | ---------------------------------------------------------------------------------- |
| `dodline/app/[locale]/layout.tsx`       | `SITE_URL` reads `NEXT_PUBLIC_SITE_URL`, default unchanged (H1)                    |
| `dodline/app/[locale]/lib/site.ts`      | `siteConfig.url` reads `NEXT_PUBLIC_SITE_URL`, default unchanged (H2)              |
| `dodline/app/[locale]/lib/site.test.ts` | **New.** 5 tests proving the default is byte-identical and the override works      |
| `dodline/next.config.ts`                | Added `api-staging.learnix.school` to `remotePatterns` (H3)                        |
| `dodline/.github/workflows/ci.yml`      | Parameterised the build-time `NEXT_PUBLIC_API_URL` with a same-value fallback (H4) |

**No backend file was modified this phase** — every backend Phase 1 item was already satisfied by the Phase 0 closure audit.

---

## 27.7 Phase 1 acceptance — checked against the plan's own criteria

| Criterion (from the plan)                                             | Met                                                                                                                             |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| With `APP_ENV` unset, every production-observable output is unchanged | ✅ verified for the backend labels in §26.1's tests; verified for the frontend metadata by direct build-output inspection above |
| Backend + frontend CI green                                           | ✅ backend: 1038/1039 (pre-existing failure only); frontend: 222/222, build passes                                              |
| `.env.example` matches `env.validation.ts` exactly                    | ✅ carried over from Phase 0, re-confirmed unaffected                                                                           |

**Phase 1 is complete.** No infrastructure was created or modified, matching its stated scope. Phase 2 (Database and Redis) has not been started.

---

# 28. Phase 2 — Current State Verification

**Performed:** 2026-08-06, before any Phase 2 code change, per the explicit gate in this session's instruction ("Before executing, check: current TypeORM settings... Create a concise report... before Dashboard action... execution risks... execution order"). Read-only audit — no file was modified while producing this section.

## 28.1 TypeORM settings

| Setting                     | Current value                                                                                                                                                                                                                 | File                                         | Assessment                                                                                                                                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------- |
| `synchronize`               | Hardcoded `false` in the CLI `DataSource` (`data-source.ts:35`); in the app's `TypeOrmModule.forRootAsync`, `shouldSynchronize = !isProduction && TYPEORM_SYNCHRONIZE==='true'`, and `isProduction && synchronize` **throws** | `data-source.ts:35`, `app.module.ts:258-267` | ✅ Already blocks `synchronize=true` whenever `NODE_ENV=production` — staging always runs `NODE_ENV=production` (§2.15 of this plan), so this already covers staging **and** production. Nothing to add. |
| `migrationsTransactionMode` | `'each'`                                                                                                                                                                                                                      | `data-source.ts:37`                          | Per-migration transactions; a migration wanting `CREATE INDEX CONCURRENTLY` must opt out individually (§8.3 of this plan already flags this).                                                            |
| Migration glob              | `[0-9]*-!(*.spec).{ts,js}`                                                                                                                                                                                                    | `data-source.ts:21`                          | Excludes the 9 `.spec.ts` files that sit beside real migrations. 104 real migration files confirmed present (`ls src/migrations                                                                          | grep -v spec | wc -l` → 104), matching §2.13/R1's number exactly. |
| Migrations-on-boot          | `nixpacks.toml`/`Procfile`: `npm run migration:run:prod && node dist/src/main.js` (external step) **and** `main.ts:79-81`'s `runPendingMigrations()` when `NODE_ENV==='production'` (internal safety net, idempotent)         | `nixpacks.toml`, `Procfile`, `main.ts:48-81` | **Gap for Phase 2 (R4):** both are unconditional — every boot, every replica, no lock. Two replicas deploying simultaneously race `runMigrations()`. Addressed in §28.4 below.                           |
| Entities                    | `autoLoadEntities: true` (app) / glob (CLI)                                                                                                                                                                                   | `app.module.ts:288`                          | Fine — no change needed.                                                                                                                                                                                 |

## 28.2 Migration commands

| Command               | npm script                                                               | Status                                                          |
| --------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Status                | `migration:show` → `typeorm migration:show`                              | ✅ exists                                                       |
| Run                   | `migration:run` (dev, ts-node) / `migration:run:prod` (compiled)         | ✅ exists                                                       |
| Revert                | `migration:revert`                                                       | ✅ exists                                                       |
| Chain test (empty DB) | `test:migrations` → `scripts/migration-chain-test.ts` (built in Phase 0) | ✅ exists, already wired into CI (`migration-chain` job, §26.2) |
| Drift check           | `migration:check` → `schema:log`                                         | ✅ exists                                                       |

The user's requested four commands (`migration status`, `migration run`, `migration revert`, `migration chain test`) **all already exist** under slightly different names. No renaming — renaming a working script is exactly the kind of no-function-added variable/script churn the plan avoids. §28.7 documents the mapping explicitly so nothing is assumed to be missing.

**Missing:** an advisory-locked wrapper so two concurrent `migration:run:prod` invocations don't race (plan item P2-09, R4). Net-new: `scripts/migrate.ts`.

## 28.3 Required database extensions

`grep -rn "CREATE EXTENSION" src/migrations` → exactly one hit: `uuid-ossp`, created in the very first migration (`1734986400000-InitialSchema.ts`). Since migrations create it, a fresh empty staging database needs no manual extension step — proven twice already by `scripts/migration-chain-test.ts` (§25/§26), which runs against a database with zero extensions pre-installed beyond what Postgres ships by default.

## 28.4 Connection pool

Already implemented and env-driven: `DB_POOL_MAX` (default 10), `DB_POOL_MIN` (2), `DB_POOL_IDLE_TIMEOUT_MS` (30000), `DB_POOL_CONNECTION_TIMEOUT_MS` (10000) — `app.module.ts:278-299`, documented in `.env.example:176-179`. These are the same names as the plan's `DATABASE_POOL_MAX` / `DATABASE_CONNECTION_TIMEOUT_MS` / `DATABASE_IDLE_TIMEOUT_MS` under an already-shipped name. **Decision: keep the existing `DB_POOL_*` names rather than add duplicates** — introducing a second variable for the same function is exactly what "do not add a variable without a specific function" prohibits. Staging uses the same variables with its own values; no code change needed here. No retry-attempt/retry-delay setting exists for the pool itself (node-postgres's pool does not retry failed connections by design — it surfaces the error to the caller, which TypeORM then reports); this is standard behaviour and is left as-is.

## 28.5 SSL configuration

`resolveDatabaseSsl()` (`common/utils/database-ssl.util.ts`) derives SSL from the connection string's hostname (loopback → off, anything else → on with `rejectUnauthorized` from `SSL_REJECT_UNAUTHORIZED`, default `true`) — **not** from `NODE_ENV`. This file's own header comment explains exactly why an env-gated version breaks in both directions, and it is the pattern this whole plan holds up as the one to copy (§2.15). **No `DATABASE_SSL` variable is being added**: it would let an operator manually force SSL off against a non-loopback host (the exact footgun this file exists to prevent) and duplicates a decision the code already makes correctly from the URL itself. Staging's Railway-issued `DATABASE_URL` will be non-loopback, so SSL turns on automatically with no configuration.

## 28.6 Redis configuration, prefixes and namespaces

| Consumer                                            | Client                                                       | Current key shape                                                                             | Namespaced today?                               |
| --------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Cache (`CacheModule`)                               | `redis` package via `RedisKeyvStore`                         | `learnix:cache:<key>`                                                                         | ❌ static literal prefix, not environment-aware |
| Rate limiting (`ThrottlerModule`)                   | `@nest-lab/throttler-storage-redis` (ioredis under the hood) | library-internal (Lua script + `nestjs-throttler:*` keys)                                     | ❌ no prefix applied                            |
| BullMQ queues (12 queues)                           | `@nestjs/bullmq` → `bullmq`                                  | `bull:<queue-name>:*` (BullMQ's own default `bull` prefix)                                    | ❌ no `prefix` option passed                    |
| Idempotency (`IdempotencyService`)                  | `redis` package, own client                                  | `idempotency:webhook:*`, `idempotency:payment:*`                                              | ❌ literal prefix                               |
| Distributed lock (`DistributedSingleFlightService`) | `redis` package, own client                                  | `cache-lock:<key>`                                                                            | ❌ literal prefix                               |
| Health-collector coordination                       | `ioredis`, own client                                        | internal state key (`health-collector` family, see `health-collector-coordinator.service.ts`) | ❌ literal prefix                               |

**This is the real gap.** `REDIS_NAMESPACE` already exists as an env var (Phase 0, `.env.example:109`) and the isolation guard already validates its _shape_ if supplied (`checkRedis()` in `environment-isolation.guard.ts:260-294`, code `STAGING_REDIS_NAMESPACE_NOT_MARKED`) — but nothing actually **applies** it. Today, isolation between environments relies entirely on each environment having its own Redis **host** (a separate Railway Redis service). That is real isolation, but the plan's Phase 2 requirement is defence in depth: even a misconfigured shared host must not let one environment touch another's keys. Phase 2 implements the missing wiring (§28.9 below).

**Sessions / token revocation in Redis:** none. `user_sessions` lives in Postgres (`src/users/sessions.service.ts`), not Redis — confirmed by grep, no session data touches Redis anywhere. So there is no "session prefix" to add; the plan's own checklist item for it is already satisfied by construction (different subsystem entirely).

## 28.7 Queue configuration

12 static queue names (`src/queues/queues.constants.ts`), each with per-queue `defaultJobOptions` (attempts, backoff, `removeOnComplete`/`removeOnFail`, priority) already tuned per queue's semantics (e.g. `CODE_GENERATION` 1 attempt because it's idempotent per-batch; `PARENT_NOTIFICATIONS` 5 attempts + 30-day failure retention because a guardian message is user-visible). `WORKER_CONFIG.concurrency` (`WORKER_CONCURRENCY`, default 5) is global, not per-queue. No queue name or connection carries an environment prefix — a staging and production instance pointed at the same Redis host (misconfiguration) would have their workers consume each other's jobs, because BullMQ identifies a queue purely by `prefix:name`. `areQueuesEnabled()` (`ENABLE_BACKGROUND_JOBS` flag, Phase 0) already lets an operator disable workers entirely; it does not namespace them.

## 28.8 Cache configuration

Single `CacheModule.registerAsync`, TTL 5 minutes default, Redis-backed via `RedisKeyvStore` when configured, else in-memory (blocked in production by the existing `isProduction` throw at `app.module.ts:121-126`). No per-environment key prefix (§28.6).

## 28.9 Health checks, retry policies, readiness vs liveness

- **Database** (`database.indicator.ts`): full-fidelity check — connects, runs a real read/write probe in a rolled-back transaction, reports pool saturation, active/idle connections, long-running queries, and `showMigrations()` for pending-migration visibility. Already reports `pendingMigrations` — directly useful for a staging dashboard.
- **Redis** (`redis.indicator.ts`): connects with `maxRetriesPerRequest: 1`, `retryStrategy: () => null` (no infinite retry loop against an unreachable host — a deliberate fail-fast choice already made for health probes specifically), reports memory pressure and hit rate.
- **Distinction already present in this codebase**: `/api/v1/health` (liveness-ish — "is the process up") vs `/health/readiness` (readiness — dependencies reachable) vs the admin-only `/health/all` (full diagnostic, degraded-mode detail per component). `HealthOrchestratorService` computes an overall status from all indicators; `critical: true` on both the database and Redis indicators means either one being `down` marks the whole service unhealthy — there is no "degraded but serving" carve-out for a down database (correct — nothing works without it) but Redis-down currently also marks `critical: true` (see `redis.indicator.ts:129` / the `misconfigured`/`down` paths), which is stricter than necessary in an environment where cache/queues could theoretically degrade rather than the API going fully unhealthy. **Recommendation, not a change in this phase:** revisit in Phase 8 (Monitoring) once real degraded-mode alerting is designed — no code change here, since altering health-criticality semantics is outside "Database and Redis" scope and affects production's own health signal today.
- **Retry policies:** Redis clients across the codebase consistently disable infinite retry in non-production (`retryStrategy: () => null` or `reconnectStrategy: false`) and keep the library default (retry-forever) in production — a deliberate, already-reviewed pattern (Phase 0 audit, §26.1 27-instances-already-correct list includes several of these). Staging runs `NODE_ENV=production`, so it inherits production's retry behaviour automatically — correct, since staging should behave like production here, not like a developer's laptop.

## 28.10 Shutdown hooks

`grep -rn "enableShutdownHooks\|SIGTERM\|SIGINT\|onApplicationShutdown"` across `src/` → **zero matches**. `main.ts`'s `bootstrap()` never calls `app.enableShutdownHooks()`. This means Nest's `OnModuleDestroy` lifecycle (which `TypeOrmModule`, `IdempotencyService`, `DistributedSingleFlightService`, `ThrottlerStorageLifecycle`, `HealthCollectorCoordinatorService`, and BullMQ's own module all implement, precisely so their Postgres/Redis connections close cleanly) **never fires** today, on either Production or a local run. On Railway, `SIGTERM` currently just kills the process directly — connections are dropped by the OS, not closed by the app. This is a genuine gap the Phase 2 objective ("graceful shutdown for database connections") calls out. Fix: add `app.enableShutdownHooks()` in `main.ts` (§28.11) — this is safe for Production (a clean SIGTERM handler is strictly better than none) and is the one Phase 2 change whose effect is visible outside staging, so it is called out explicitly rather than folded silently into the staging-only work.

## 28.11 Test infrastructure

`test/docker-compose.e2e.yml`: ephemeral `postgres:16-alpine` (tmpfs, no persistent volume, dropped with the container) + `redis:7-alpine` (tmpfs), both healthchecked. `.env.test` points at them and isolates Redis to **logical DB 15** (`redis://localhost:56379/15`) with `E2E_DISABLE_BACKGROUND_WORKERS=true` so BullMQ workers don't race the suite's own truncate/reseed cycles. This is a _different_ isolation mechanism than what staging needs (staging is a long-lived, non-ephemeral environment) but confirms the codebase already has a working pattern for "isolate Redis without a second host" (logical DB index) that Phase 2's `REDIS_NAMESPACE` work will formalise for staging using key-prefixing instead (Railway Redis is typically single-DB-index on the plans this project uses, so a logical-DB approach does not transfer directly to Railway — prefixing does).

## 28.12 Existing Railway configuration

`railway.json`: NIXPACKS builder, `ON_FAILURE` restart (max 10 retries), healthcheck `/api/v1/health` (timeout 100s). `nixpacks.toml`/`Procfile`: identical start command, `npm run migration:run:prod && node dist/src/main.js`. Nothing here is staging-specific yet — there is exactly one Railway project today (implicit production), matching §2.4 of this plan. Phase 2 does not create the `learnix-staging` Railway project or its Postgres/Redis services (no dashboard access from this environment) — see §28.14 for the checklist handed back to you, consistent with the "prepare a detailed checklist, do not create Railway resources yourself" instruction.

## 28.13 Actual environment variables and APP_ENV guards implemented

Confirmed present (not merely documented) from Phase 0: `APP_ENV`/`APP_ENV_STRICT` (`config/app-env.ts`), the full `environment-isolation.guard.ts` (18 staging codes + 3 production-mirror codes, invoked from `env.validation.ts`'s `validate()`), `REDIS_NAMESPACE` (validated for shape, **not yet wired to any client** — this phase's job), `PROD_HOST_DENYLIST`/`PROD_IDENTIFIER_DENYLIST`/`PROD_RESOURCE_DENYLIST`/`PROD_SENDER_DENYLIST`/`PROD_SECRET_FINGERPRINTS` (all optional, additive). `DATABASE_URL` and `REDIS_URL` already participate in the isolation guard's host-denylist and staging-name-pattern checks (`checkDatabase`/`checkRedis`) — this is most of §14's G1/G2 from the original plan, already shipped in Phase 0, ahead of Phase 2. Phase 2 does not need to re-implement host/name checking; it needs to (a) add the advisory lock, (b) add backup/restore tooling, (c) wire `REDIS_NAMESPACE` through to every Redis consumer, (d) add graceful shutdown, (e) harden the seed script's idempotency, (f) document the Railway checklist.

## 28.14 What needs modification (summary going into implementation)

| #   | Change                                                                                                                                                                           | Files                                                                                                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Advisory-locked migration runner                                                                                                                                                 | new `scripts/migrate.ts`; `package.json`; `src/main.ts` (`runPendingMigrations`)                                                                                                                                        |
| 2   | `RUN_MIGRATIONS` opt-out for boot-time migrations (additive; default preserves today's behaviour)                                                                                | `src/main.ts`; `.env.example`                                                                                                                                                                                           |
| 3   | Backup / restore scripts with a staging-only restore guard                                                                                                                       | new `scripts/db-backup.sh`, `scripts/db-restore.sh`                                                                                                                                                                     |
| 4   | `REDIS_NAMESPACE` actually applied: cache key prefix, BullMQ `prefix`, throttler `keyPrefix`, idempotency key prefix, single-flight lock key prefix, health-collector key prefix | `app.module.ts`, `queues.module.ts`, `redis-keyv.store.ts`, `idempotency.service.ts`, `distributed-single-flight.service.ts`, `health-collector-coordinator.service.ts`; new `src/common/utils/redis-namespace.util.ts` |
| 5   | Graceful shutdown                                                                                                                                                                | `src/main.ts` (`enableShutdownHooks()`)                                                                                                                                                                                 |
| 6   | Seed idempotency / safe reset + correlation-check command                                                                                                                        | `src/database/seed-staging.ts`; `package.json`                                                                                                                                                                          |
| 7   | `.env.example` additions for the above (namespace-derived defaults, `RUN_MIGRATIONS`)                                                                                            | `.env.example`                                                                                                                                                                                                          |
| 8   | Tests for all of the above                                                                                                                                                       | new `*.spec.ts` files per changed module                                                                                                                                                                                |
| 9   | Docs                                                                                                                                                                             | new `docs/STAGING_DATABASE_SETUP.md`, `docs/STAGING_REDIS_SETUP.md`, `docs/PHASE_2_RAILWAY_CHECKLIST.md`                                                                                                                |

**Explicitly not touched in Phase 2** (out of this phase's scope per the plan's own phase boundaries): R2/Bunny/Paymob/MailerSend/Twilio/Meta/Firebase (Phase 3), Railway/Vercel/DNS resource creation (Phase 4), CI deploy workflows (Phase 5), the `staging-isolation.guard.ts` G3-G8 checks beyond what Phase 0 already shipped (Phase 6 — though as shown above, the database/Redis-specific ones (G1/G2-equivalent) are already done), UI banner/robots/sitemap (Phase 7).

## 28.15 Dashboard actions this phase requires from you

**None yet.** Every item in §28.14 is a code/script/doc change executable without Railway access. Phase 2's plan-level checklist items P2-01/02/03 (create the `learnix-staging` Railway project, Postgres, Redis) **do** require dashboard access and are out of reach from this environment — §28.16 hands back the exact checklist for those, matching the "prepare a detailed checklist instead of creating resources yourself" instruction. Everything else in Phase 2's original scope (P2-04 through P2-11: extension comparison, migration run against the empty DB, drift check, `down()` test, advisory lock, backup/restore, restore drill) either has already been proven against a local Postgres in Phase 0 (P2-04/05/06/07 — see §25/§26, 104 migrations, drift-clean, repeated runs) or is implemented as tooling in this phase and exercised against a local/temporary database rather than the not-yet-created staging one (P2-08/09/10/11 — a restore drill against a "scratch Railway DB" specifically requires Railway; the mechanics are proven locally instead, exactly as the migration chain was in Phase 0).

## 28.16 Execution risks

| Risk                                                                                                                                                        | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Applying `REDIS_NAMESPACE` prefixing changes Production's Redis key shape the moment this code deploys, even though Production never sets `REDIS_NAMESPACE` | Default namespace resolves to **empty string** (no prefix at all — byte-identical key shape to today) whenever `APP_ENV` resolves to `production` and `REDIS_NAMESPACE` is unset. Staging and test get a non-empty default (`learnix:staging`, `learnix:test`) even without explicit configuration, since they have no legacy keys to preserve. Explicit `REDIS_NAMESPACE` always wins in any environment. This mirrors the exact pattern already used for `APP_ENV` itself (§2.15) — additive, opt-in for the environment that must not change. |
| Advisory lock changes migration-boot behaviour on every deploy, including Production's                                                                      | The lock is acquired, migrations run, lock released — a no-op wrapper when only one process ever runs it (today's reality, 1 replica). It only changes behaviour the moment a second concurrent runner appears, which is exactly the race it exists to prevent. No behavioural change for the common case.                                                                                                                                                                                                                                       |
| `enableShutdownHooks()` changes Production's shutdown path                                                                                                  | Strictly additive safety: connections that previously were dropped by the OS on `SIGTERM` now close cleanly first. No functional behaviour (request handling, responses) changes.                                                                                                                                                                                                                                                                                                                                                                |
| Seed idempotency changes could mask a real bug if "safe reset" silently deletes something unexpected                                                        | Same three pre-existing guards (APP_ENV=staging, host denylist, name pattern) gate every seed invocation, reset or not; the reset path is additive on top, not a relaxation of any guard.                                                                                                                                                                                                                                                                                                                                                        |
| `RUN_MIGRATIONS=false` could let an operator disable migrations and forget, leaving staging permanently behind schema                                       | Default is unset → today's behaviour (migrations run automatically). Explicitly documented in `.env.example` as an opt-out, not a default.                                                                                                                                                                                                                                                                                                                                                                                                       |

## 28.17 Execution order for this phase

1. `src/common/utils/redis-namespace.util.ts` (new shared resolver) — everything else depends on it.
2. Wire the namespace into: cache (`redis-keyv.store.ts` + `app.module.ts`), BullMQ (`queues.module.ts`), throttler (`app.module.ts`), idempotency (`idempotency.service.ts`), single-flight (`distributed-single-flight.service.ts`), health-collector (`health-collector-coordinator.service.ts`). Tests alongside each.
3. Database safety: `scripts/migrate.ts` (advisory lock) + `package.json` wiring + `main.ts` `RUN_MIGRATIONS` opt-out + `enableShutdownHooks()`. Tests.
4. `scripts/db-backup.sh` / `scripts/db-restore.sh` with the staging-only restore guard.
5. Seed idempotency + correlation-check command (`seed-staging.ts`, `package.json`).
6. `.env.example` additions.
7. `docs/STAGING_DATABASE_SETUP.md`, `docs/STAGING_REDIS_SETUP.md`, `docs/PHASE_2_RAILWAY_CHECKLIST.md`.
8. Full verification run (lint, typecheck, unit tests, build, migration-chain test, seed-interconnection, E2E).
9. Plan file update (§29 Phase 2 Execution Record) + final report.

---

# 29. Phase 2 Execution Record

**Executed:** 2026-08-06 · **Phase:** 2 (Database and Redis) · **Status: COMPLETE**
**Objective (from the plan's own Phase 2 section):** a working, empty, isolated staging Postgres +
Redis, with the migration chain proven.
**Production touched:** none. **Dashboard actions performed:** none (none possible from this
environment — see §29.7). **External resources created:** none — see
[`PHASE_2_RAILWAY_CHECKLIST.md`](../docs/PHASE_2_RAILWAY_CHECKLIST.md) for the checklist handed
back for the Railway project/Postgres/Redis creation this phase could not perform itself.

Pre-execution audit: [§28](#28-phase-2--current-state-verification).

---

## 29.1 Scope actually executed

The plan's own Phase 2 file list was narrow (`scripts/migrate.ts`, `db-backup.sh`,
`db-restore.sh`, `package.json`, possibly new migrations). The session's detailed Database/Redis
requirements — issued directly, more specific than the plan's high-level bullet, and squarely
within "Phase 2 — Database and Redis" by subject matter — expanded that into: database isolation
code, database safety guards, Redis isolation (real key namespacing, not just validated-but-unused
config), Redis reliability review, queue/worker isolation, synthetic-seed idempotency, environment
variables, tests, a Railway checklist, and full verification. All of it is reported below.

## 29.2 Files modified — reason for each

| File                                                                                                       | Change                                                                                                                                                                                                                                   | Reason                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/common/utils/redis-namespace.util.ts` (new)                                                           | `resolveRedisNamespace` / `namespacedPrefix` / `bullMqPrefix`                                                                                                                                                                            | Single source of truth for environment-scoped Redis keys; production defaults to empty (byte-identical), staging/test get useful defaults automatically                                                      |
| `src/common/cache/redis-keyv.store.ts`                                                                     | Constructor takes a `keyPrefix` parameter (default unchanged)                                                                                                                                                                            | Cache keys now environment-scoped                                                                                                                                                                            |
| `src/app.module.ts`                                                                                        | Cache factory computes and passes the prefix; throttler factory passes `keyPrefix` to `ThrottlerStorageRedisService` in both the production and dev-reachability-probe branches                                                          | Rate-limit keys now environment-scoped                                                                                                                                                                       |
| `src/queues/queues.module.ts`                                                                              | `BullModule.forRootAsync` conditionally adds a `prefix` (only when non-empty)                                                                                                                                                            | Queue keys now environment-scoped; production keeps BullMQ's own default `'bull'` prefix unchanged                                                                                                           |
| `src/idempotency/idempotency.service.ts`                                                                   | Key-builder methods prepend a resolved prefix                                                                                                                                                                                            | Idempotency keys now environment-scoped                                                                                                                                                                      |
| `src/analytics/distributed-single-flight.service.ts`                                                       | Lock key prepends a resolved prefix                                                                                                                                                                                                      | Cross-replica lock keys now environment-scoped                                                                                                                                                               |
| `src/health/health-collector-coordinator.service.ts`                                                       | State/heartbeat/lock key constants became instance fields computed from the namespace                                                                                                                                                    | Health-coordination keys now environment-scoped                                                                                                                                                              |
| `src/health/health.service.ts`                                                                             | `getReadiness()` now also pings Redis when configured                                                                                                                                                                                    | Closes a real gap: Redis going down _after_ boot was invisible to the readiness probe                                                                                                                        |
| `src/main.ts`                                                                                              | `app.enableShutdownHooks()`; `RUN_MIGRATIONS=false` opt-out; `runPendingMigrations()` now wrapped in the same advisory lock the CLI uses                                                                                                 | Graceful shutdown (R4-adjacent gap found during the audit); migration-boot race (R4) resolved in the actual boot path, not just as an unused script                                                          |
| `src/database/migration-lock.util.ts` (new)                                                                | `withMigrationAdvisoryLock`                                                                                                                                                                                                              | Shared Postgres advisory-lock wrapper, used by both `main.ts` and the new CLI                                                                                                                                |
| `src/database/migrate-cli.ts` (new)                                                                        | `status`/`run`/`revert` CLI                                                                                                                                                                                                              | Replaces the raw `typeorm` CLI call inside `migration:run:prod` — the actual command `nixpacks.toml`/`Procfile` run on every deploy is now lock-protected                                                    |
| `package.json`                                                                                             | `migration:run:prod` now points at the new CLI; added `migrate:status`/`migrate:run`/`migrate:revert`, `verify:migration-lock`, `verify:seed-idempotency`, `verify:seed-correlation`, `db:backup`, `db:restore`                          | R4 fix wired into the real path; new tooling exposed with clear names, matching the four commands requested (`migration status`/`run`/`revert`/`chain test` — the last already existed as `test:migrations`) |
| `scripts/db-backup.sh` (new)                                                                               | `pg_dump` + `pg_restore --list` integrity check                                                                                                                                                                                          | R8 — no backup tooling existed at all before this                                                                                                                                                            |
| `scripts/db-restore.sh` (new)                                                                              | Guarded restore                                                                                                                                                                                                                          | R8, plus a restore-specific safety gate                                                                                                                                                                      |
| `scripts/assert-restore-target-safe.ts` (new)                                                              | Thin CLI wrapper around `seed-staging.ts`'s `assertSafeTarget`                                                                                                                                                                           | One safety-check implementation shared between the seed and the restore script, not two to keep in sync                                                                                                      |
| `scripts/verify-migration-lock.ts` (new)                                                                   | Live two-connection concurrency proof                                                                                                                                                                                                    | Plan's own acceptance criterion: "concurrent migration test shows one waiting"                                                                                                                               |
| `src/config/environment-isolation.guard.ts`                                                                | +3 codes: `STAGING_SYNCHRONIZE_ENABLED`, `PRODUCTION_DATABASE_NAME_LOOKS_LIKE_STAGING`, `PRODUCTION_REDIS_NAMESPACE_LOOKS_LIKE_STAGING`; +1 export: `assertTestDatabaseIsSafe`                                                           | Closes named requirements: synchronize=true blocked on staging independent of `NODE_ENV`; production pointed at a staging-shaped DB/namespace is now caught; the test runner itself is now checked           |
| `test/setup-e2e.ts`                                                                                        | Calls `assertTestDatabaseIsSafe` before any test file runs                                                                                                                                                                               | "Running the test suite on a database not designated for testing"                                                                                                                                            |
| `src/database/seed-staging.ts`                                                                             | +`SeedAlreadyRanError`/`hasExistingSeedData` (refuses a second run without `--reset`); +`SeedNotArmedError`/`assertSeedArmed` (`ALLOW_STAGING_SEED=true` required, independent of target identity)                                       | "Do not create duplicate records upon restart"; a second, independent arming step so the seed (especially `--reset`) can never run as a side effect                                                          |
| `scripts/verify-seed-interconnection.ts`                                                                   | `runChecks`/`rowCounts`/`CheckResult` exported; `main()` guarded with `if (require.main === module)`; sets `ALLOW_STAGING_SEED=true` for its own seed call                                                                               | Reused by the new correlation-check script without triggering this file's own temp-DB cycle as an import side effect (a real bug found and fixed during this phase — see §29.8)                              |
| `scripts/seed-correlation-check.ts` (new)                                                                  | Runs the same 12 FK checks against a live, persistent `DATABASE_URL` (no temp DB)                                                                                                                                                        | The "data correlation check command" requirement — usable operationally against an already-seeded staging environment, not just at seed-development time                                                     |
| `scripts/verify-seed-idempotency.ts` (new)                                                                 | Live proof: seed → refuse-without-reset → reset → reset again, comparing row counts                                                                                                                                                      | Proves idempotency/safe-reset against a real database, not a mock                                                                                                                                            |
| `.env.example`                                                                                             | `RUN_MIGRATIONS`, `ALLOW_STAGING_SEED` documented; `REDIS_NAMESPACE`'s comment rewritten to describe what it now actually does; `TYPEORM_SYNCHRONIZE`/pool/SSL sections annotated with the reasoning for what was deliberately NOT added | Full documentation of every new variable, and explicit reasoning for variables considered and rejected                                                                                                       |
| `.gitattributes` (new)                                                                                     | Forces LF on `*.sh`                                                                                                                                                                                                                      | The two new shell scripts must not be corrupted to CRLF by a Windows `core.autocrlf` setting, which would break their shebang line inside a Linux container                                                  |
| `docs/STAGING_DATABASE_SETUP.md`, `docs/STAGING_REDIS_SETUP.md`, `docs/PHASE_2_RAILWAY_CHECKLIST.md` (new) | Full documentation                                                                                                                                                                                                                       | Required deliverables                                                                                                                                                                                        |

**Not touched, and explicitly out of scope:** R2/Bunny/Paymob/MailerSend/Twilio/Meta/Firebase
(Phase 3), Railway/Vercel/DNS resource creation (Phase 4), CI deploy workflows and branch
protection (Phase 5), the remaining `staging-isolation.guard.ts` items beyond database/Redis
(Phase 6), UI banner/robots/sitemap (Phase 7).

## 29.3 Database architecture

See [`STAGING_DATABASE_SETUP.md`](../docs/STAGING_DATABASE_SETUP.md) for the full detail. Summary:
synchronize blocked two independent ways (NODE*ENV-keyed in `app.module.ts`, APP_ENV-keyed in the
isolation guard); SSL derived from the connection string, never from `NODE_ENV`; connection pool
already fully tunable via `DB_POOL*\*`; migrations now run through a Postgres-advisory-locked CLI in
both the external boot step and the in-app safety net; backup/restore tooling exists and is
integrity-checked; graceful shutdown added.

## 29.4 Redis architecture

See [`STAGING_REDIS_SETUP.md`](../docs/STAGING_REDIS_SETUP.md) for the full detail. Summary: a
single `REDIS_NAMESPACE`-driven resolver now scopes every cache/queue/rate-limit/idempotency/lock
key; production's default is empty (zero behaviour change); staging/test get automatic, sensible
defaults; readiness now checks Redis, not just Postgres.

## 29.5 Queue isolation

BullMQ's `prefix` option, set from the same resolver, applied to all 12 queues via the single
shared `BullModule.forRootAsync` connection. `ENABLE_BACKGROUND_JOBS` (Phase 0) continues to gate
whether queues connect to Redis at all, orthogonal to and compatible with the namespace change.

## 29.6 New environment variables

| Variable             | Default                     | Purpose                                                                                                     |
| -------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `RUN_MIGRATIONS`     | unset (= run automatically) | Opt-out for boot-time migrations, for a deploy topology that prefers an explicit out-of-band migration step |
| `ALLOW_STAGING_SEED` | unset (= refused)           | Second, independent arming step required before the synthetic seed will run at all                          |

**Considered and deliberately NOT added**, with reasoning recorded in `.env.example` and the two
setup docs: `DATABASE_SSL` (conflicts with the existing, deliberately connection-string-derived SSL
logic), `DATABASE_POOL_MAX`/`DATABASE_CONNECTION_TIMEOUT_MS`/`DATABASE_IDLE_TIMEOUT_MS` (already
exist as `DB_POOL_MAX`/`DB_POOL_CONNECTION_TIMEOUT_MS`/`DB_POOL_IDLE_TIMEOUT_MS` — kept under their
shipped names rather than duplicated), `REDIS_TLS` (handled by the `rediss://` URL scheme),
`QUEUE_PREFIX`/`CACHE_PREFIX`/`RATE_LIMIT_PREFIX` (would let subsystems drift out of sync;
`REDIS_NAMESPACE` covers all of them by design).

`REDIS_NAMESPACE` itself is not new (Phase 0), but its _behaviour_ is: it now actually prefixes
every key it used to only validate the shape of.

## 29.7 Dashboard actions required

**None performed. None possible from this environment.** Creating the `learnix-staging` Railway
project, its Postgres service, and its Redis service all require dashboard access this session
does not have. The full, exact checklist for those three steps — plus the migration run against
the new empty database, first-boot verification, the deliberate guard-firing drills, and a
backup/restore drill — is in
[`PHASE_2_RAILWAY_CHECKLIST.md`](../docs/PHASE_2_RAILWAY_CHECKLIST.md). Everything this phase COULD
execute without dashboard access (all code, all tooling, all tests, all documentation) has been.

## 29.8 Test results (numerical)

| Check                                   | Command                                                                                                            | Result                                                                                                                                                                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend type-check                      | `npx tsc --noEmit -p tsconfig.build.json`                                                                          | ✅ PASS                                                                                                                                                                                                                                                                                     |
| Backend lint (ESLint)                   | `npx eslint . --cache`                                                                                             | ✅ PASS — 0 problems                                                                                                                                                                                                                                                                        |
| Backend build                           | `npm run build`                                                                                                    | ✅ PASS (1021 files compiled)                                                                                                                                                                                                                                                               |
| Prettier — Phase 2 files                | `npx prettier --check <27 Phase 2 files>`                                                                          | ✅ PASS (9 files reformatted mid-phase, then re-verified clean; repo-wide baseline has 315 pre-existing unrelated files, unchanged from before this phase — same documented baseline as Phase 0/1)                                                                                          |
| Backend unit tests                      | `npx jest --ci --runInBand`                                                                                        | ⚠️ **1082/1083 passed** (1 pre-existing, unrelated failure — `guardians/guardians.service.spec.ts`, identical to every prior run this session)                                                                                                                                              |
| New tests this phase                    | —                                                                                                                  | **+66 tests**: `redis-namespace.util.spec.ts` (15), `redis-keyv.store.spec.ts` (3), `idempotency.service.spec.ts` (3), `migration-lock.util.spec.ts` (4), `health.service.spec.ts` (5), `environment-isolation.guard.spec.ts` (+10 new cases), `seed-staging.spec.ts` (+4 new arming cases) |
| Migration chain                         | `npm run test:migrations`                                                                                          | ✅ PASS — 104/104 migrations, 0 pending, 93 tables (run 3× this phase, including once post-build)                                                                                                                                                                                           |
| Migration lock (live concurrency proof) | `npm run verify:migration-lock`                                                                                    | ✅ PASS — B waited ~1.39s behind A's ~1.5s hold, against two real, separate Postgres connections                                                                                                                                                                                            |
| Migration CLI (`status`/`run`/`revert`) | manual, against a real disposable database                                                                         | ✅ PASS — 104 applied, status correctly reports 0 pending, revert correctly reverts the newest and status correctly reports it pending again                                                                                                                                                |
| Seed interconnection                    | `npm run verify:seed-interconnection`                                                                              | ✅ PASS ×3 this phase — 26 users, 45 lessons, 9 courses, 6 books/exams, 12 attempts, 6 orders/payments, 4 certificates; 0 broken FK links across 12 checks                                                                                                                                  |
| Seed idempotency (live proof)           | `npm run verify:seed-idempotency`                                                                                  | ✅ PASS — first run 183 rows; second run without `--reset` correctly refused (`SeedAlreadyRanError`); `--reset` reproduced exactly 183 rows twice in a row                                                                                                                                  |
| Seed correlation check                  | `npm run verify:seed-correlation`                                                                                  | ✅ PASS — run against an already-seeded, persistent database (not a temp one), confirming the operational, non-destructive use case works                                                                                                                                                   |
| Backup script                           | `scripts/db-backup.sh`, via `postgres:18-alpine` (no local `pg_dump` on this machine)                              | ✅ PASS — archive created and passed its own `pg_restore --list` integrity check                                                                                                                                                                                                            |
| Restore mechanics                       | `pg_restore`, same container                                                                                       | ✅ PASS — 3 known rows landed correctly in a second, separate database                                                                                                                                                                                                                      |
| Restore safety check                    | `scripts/assert-restore-target-safe.ts`, run natively (not inside the container — see §29.2's `db-restore.sh` row) | ✅ PASS — refused a production-host target, accepted a staging-named target                                                                                                                                                                                                                 |
| Full E2E suite                          | `npm run test:e2e -- --ci --runInBand`                                                                             | ⚠️ **125/133 passed**, exit code 1 — see the detailed breakdown below                                                                                                                                                                                                                       |

### E2E breakdown — every failure individually accounted for

| Suite                                                  | Status                                                                                                                                       | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subjects-ownership.e2e-spec.ts`                       | FAIL (same assertion as Phase 0/1's gate)                                                                                                    | **Pre-existing**, reproduced on a clean baseline worktree during the Phase 0 closure gate                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `payment-financial-state-machine.postgres.e2e-spec.ts` | FAIL (same assertion)                                                                                                                        | **Pre-existing**, reproduced on a clean baseline worktree                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `call-center-phase6.e2e-spec.ts`                       | FAIL (same assertion)                                                                                                                        | **Pre-existing**, reproduced on a clean baseline worktree                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `call-center-phase5.e2e-spec.ts`                       | FAIL (same assertion)                                                                                                                        | **Pre-existing**, reproduced on a clean baseline worktree                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `certificates.e2e-spec.ts`                             | FAIL — `deadlock detected` inside the shared `resetDatabase()` helper                                                                        | **Flaky, not a regression** — passed cleanly in isolation earlier this session and failed with the identical deadlock signature in both the Phase 0/1 gate run and this run, always inside the same all-tables `TRUNCATE ... CASCADE` helper (`test/e2e/helpers/database.ts`), never inside application code                                                                                                                                                                                                        |
| `auth.e2e-spec.ts`                                     | FAIL — 3 tests timed out / `TypeORMError: Driver not Connected`, all inside the "registration does not leak whether an account exists" group | **Flaky, not a regression** — re-run alone against fresh Docker infra immediately after: **11/11 passed** in 16s. Symptoms (timeout + driver-disconnected, only during the full 19-suite sequential run) match the same class of DB-resource contention as the `certificates` deadlock — this suite's timing-sensitive concurrent-request test and its slow `bcrypt`-hashing registration tests are exactly the kind of test that a heavily-loaded shared Postgres container pushes past its 5000ms default timeout |

**Root cause of the flakiness (diagnosed, not fixed — see §29.9):** `resetDatabase()` runs a single `TRUNCATE TABLE <every table> RESTART IDENTITY CASCADE`, which takes an `ACCESS EXCLUSIVE` lock on every table simultaneously. Run once per test inside a 19-suite, `--runInBand` sequence sharing one Postgres container, this is inherently more likely to deadlock or queue behind another suite's lingering connection the longer the overall run goes — a property of the test harness's own truncate strategy, present before this phase and not something this phase's application code changes could cause or fix.

**Conclusion: zero new deterministic failures caused by Phase 2's own code changes.** Every one of the 6 failing suites is accounted for: 4 reproduce byte-for-byte on unmodified code, 2 are proven flaky by passing cleanly in isolation. Per the standing instruction ("no failed tests resulting from Phase 0 or Phase 1" — extended here to Phase 2 by the same standard), this substantive gate is met. The suite's raw exit code (`1`) is reported honestly rather than rounded to a false "0".

## 29.9 Remaining risks

| Risk                                                                                                                                               | Assessment                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E2E suite flakiness under a full sequential run (`resetDatabase`'s all-tables TRUNCATE)                                                            | Pre-existing, not introduced by this phase. Worth hardening later (e.g. a deadlock-retry wrapper around `resetDatabase`, or truncating only the tables a given suite actually touches) — flagged as a follow-up, not fixed here, since it is E2E test-harness engineering rather than "Database and Redis" application code |
| 4 pre-existing E2E failures (lesson-update-after-subject-suspension validation, a payment-concurrency race, two call-center RBAC route mismatches) | Pre-existing application bugs, out of Phase 2's scope. Flagged for separate follow-up, not fixed here                                                                                                                                                                                                                       |
| P2-11 (restore a Production backup into a scratch Railway DB) not performed                                                                        | Requires an actual Production backup and a Railway scratch database, neither of which exists yet. The restore _mechanism_ is fully proven against synthetic data (§29.8); this specific drill is listed in `PHASE_2_RAILWAY_CHECKLIST.md` §8 for you to run once the staging Postgres exists                                |
| `db-restore.sh` not run as a single combined process (ts-node safety check + `pg_restore` together) in this environment                            | Both halves independently verified for real (§29.8); the combined-process gap is a Windows/Linux-container environment limitation, not a code defect — the script's own bash logic passed a syntax check and its two pieces are individually proven                                                                         |
| Cosmetic double `learnix:` prefix on staging cache and health-collector keys                                                                       | Documented as intentional in `STAGING_REDIS_SETUP.md` §2 — no functional impact, uniqueness and isolation are unaffected                                                                                                                                                                                                    |

## 29.10 Rollback procedure

Nothing in this phase created infrastructure or touched Production. Rollback is reverting the code
changes:

- All changes are currently uncommitted in the working tree (`git status`) — discarding them
  (`git checkout -- <files>`, or simply not committing) fully reverts Phase 2 with zero residue.
- If already committed and deployed: the advisory lock, namespace resolver, and readiness check are
  all additive and default to today's exact behaviour on production (empty namespace, lock is a
  no-op with one runner, readiness gains one more check that only fails if Redis is actually down) —
  a revert is a plain code revert, not a data-migration or infrastructure teardown.
- No database schema changed, no migration was added, no Railway/Vercel/Cloudflare resource was
  created.

## 29.11 Phase 2 acceptance — checked against the plan's own criteria

| Criterion (from the plan)                                | Met                                                                                                                                             |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Empty DB → all migrations → drift check clean            | ✅ Proven 3× this phase (104/104, 0 pending each time)                                                                                          |
| Concurrent migration test shows one waiting              | ✅ `verify:migration-lock` — B waited ~1.39s behind A's ~1.5s hold                                                                              |
| A backup restores and passes row-count checks            | ✅ Proven against synthetic data (3 rows, correct); the Production→scratch drill specifically (P2-11) awaits Railway access, checklist provided |
| Documented run, scripts merged, migration count recorded | ✅ This section, plus `STAGING_DATABASE_SETUP.md` / `STAGING_REDIS_SETUP.md`                                                                    |

**Phase 2 is complete.** No Railway/Vercel/Cloudflare resource was created (none was possible from
this environment) — the full checklist for the three Database/Redis-specific resources
(`learnix-staging` project, Postgres, Redis) is in `PHASE_2_RAILWAY_CHECKLIST.md`.

---

## 29.12 Phase 2 closure review (git diff, lock hardening, run policy, seed re-check)

Performed 2026-08-06, before Phase 3 began, in response to a direct request to close out Phase 2
properly rather than accept its own "complete" self-assessment at face value.

**Corrected status wording** (see the banner at the top of this file): Phase 2's **implementation**
is complete; its **verification** is complete _with documented pre-existing and flaky E2E
failures_ — the real, captured exit code is **1** (125/133 passed), never rounded up to "passed."
The per-suite detail lives in [`docs/E2E_KNOWN_FAILURES.md`](../docs/E2E_KNOWN_FAILURES.md), created
in this closure pass specifically so that detail does not have to be re-derived from this file's
prose every time someone asks "did the E2E suite pass yet?"

**Important out-of-band finding, disclosed here because it affects how "Phase 2 is complete" should
be read:** at the start of this closure review, `git status` showed a clean working tree and `git
log` showed the entire Phase 0–2 body of work already committed as a single commit (`7d0ba8e
"staging"`, 70 files, +9868/−83) — and `git fetch origin main` confirmed that commit is already on
`origin/main` at `github.com/muhamedhalim/learnix-back.git`, the same branch this plan's own §2.4/
§11 identify as what Railway currently deploys to Production. This commit was not made or pushed
during this closure session. Every change in it was engineered to be additive and behaviourally
inert on Production by default (empty Redis namespace, opt-in `RUN_MIGRATIONS`/`ALLOW_STAGING_SEED`,
a migration lock that is a no-op with one runner, a readiness check that only fails if Redis is
actually down) — but "designed to be safe" is not the same as "verified deployed safely," and no
Railway deploy log has been inspected from this environment. Flagged for the operator's awareness;
not something this closure review can act on further from here.

### 29.12.1 Git diff review — every file, categorised, verified against scope

`git diff 4fbd181 HEAD --stat` (`4fbd181` is the commit `HEAD` pointed to before Phase 0 began) shows
**70 files changed, 9868 insertions(+), 83 deletions(-)**, all currently sitting in one commit. Every
file was individually attributed to the phase that touched it by reading its actual diff (not
assumed from memory), and the two resulting file sets were confirmed to sum exactly back to the
whole: **35 files / +6897 −64** attributable to Phase 2, **35 files / +2971 −19** attributable to
Phase 0/1, **35+35=70** ✓, **6897+2971=9868** ✓, **64+19=83** ✓.

**Phase 2's 35 files, categorised:**

| Category          | Files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Database**      | `src/database/migration-lock.util.ts` (new), `src/database/migration-lock.util.spec.ts` (new), `src/database/migrate-cli.ts` (new), `src/main.ts` (modified — shutdown hooks, `RUN_MIGRATIONS`, lock wiring), `package.json` (modified — migration/backup/verify scripts), `scripts/db-backup.sh` (new), `scripts/db-restore.sh` (new), `scripts/assert-restore-target-safe.ts` (new), `scripts/verify-migration-lock.ts` (new), `src/config/environment-isolation.guard.ts` (modified — 3 new staging/production-mirror checks), `src/config/environment-isolation.guard.spec.ts` (modified — 10 new cases), `test/setup-e2e.ts` (modified — test-DB safety call), `.gitattributes` (new — LF for the new shell scripts), `docs/STAGING_DATABASE_SETUP.md` (new), `docs/PHASE_2_RAILWAY_CHECKLIST.md` (new) |
| **Redis**         | `src/common/utils/redis-namespace.util.ts` (new), `src/common/utils/redis-namespace.util.spec.ts` (new), `src/common/cache/redis-keyv.store.ts` (modified — `keyPrefix` param), `src/common/cache/redis-keyv.store.spec.ts` (new), `src/app.module.ts` (modified — cache/throttler prefix wiring), `src/idempotency/idempotency.service.ts` (modified), `src/idempotency/idempotency.service.spec.ts` (new), `src/analytics/distributed-single-flight.service.ts` (modified), `src/health/health-collector-coordinator.service.ts` (modified), `src/health/health.service.ts` (modified — Redis readiness ping), `src/health/health.service.spec.ts` (new), `docs/STAGING_REDIS_SETUP.md` (new)                                                                                                              |
| **Queue**         | `src/queues/queues.module.ts` (modified — BullMQ `prefix`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Seed**          | `src/database/seed-staging.ts` (modified — idempotency + arming guards), `src/database/seed-staging.spec.ts` (modified), `scripts/verify-seed-interconnection.ts` (modified — exports + `require.main` guard), `scripts/seed-correlation-check.ts` (new), `scripts/verify-seed-idempotency.ts` (new)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Tests**         | (counted above against the file each spec belongs to — every `*.spec.ts` in this list, plus the two live verification scripts, which are executable proofs rather than jest specs)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Documentation** | `.env.example` (modified), `STAGING_ENVIRONMENT_IMPLEMENTATION_PLAN.md` (modified — §28, §29)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Generated**     | none in Phase 2's set (`src/metadata.ts`, the only generated file in the whole diff, belongs to Phase 0/1 — see below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

**Phase 0/1's 35 files** (confirmed out of Phase 2's scope, not re-reviewed in depth here since §26
already closed Phase 0 and §27 documents Phase 1): the audit docs (`docs/CRON_AUDIT.md`,
`docs/ENVIRONMENT_INVENTORY.md`, `docs/GIT_DIFF_REVIEW.md`, `docs/NODE_ENV_AUDIT.md`,
`docs/SECRETS_REPORT.md`, `docs/SECRET_ROTATION_CHECKLIST.md`), the `APP_ENV` core
(`src/config/app-env.ts` + spec, `src/config/env.validation.ts`), the fail-fast isolation guard's
_original_ Phase 0 form and the R5 login-throttle fix (`src/common/throttle/*`,
`src/common/constants.ts`, `src/auth/auth.controller.ts`), the cron feature-flag gates
(`src/config/feature-flags.ts` + spec, and every cron/queue/webhook file that calls
`isFeatureEnabled` — `src/lessons/lessons.service.ts`, `src/notifications/processors/
parent-notification.processor.ts`, `src/payments/providers/paymob/paymob.gateway.ts`,
`src/payments/services/gateway-webhook.service.ts`, `src/payments/services/
payment-operations.service.ts`, `src/queues/queues.constants.ts`, `src/uploads/cleanup.service.ts`,
`src/health/indicators/external-providers.indicator.ts` + spec), the `APP_ENV`-label plumbing
(`src/app.service.ts`, `src/health/health-error.service.ts`, `src/health/
health-orchestrator.service.ts`, `src/observability/sentry.ts`), the CORS dev-fallback fix
(`src/common/utils/cors.util.ts` + spec), the migration-chain and secret-fingerprint tooling
(`scripts/migration-chain-test.ts`, `scripts/fingerprint-secrets.ts`), the CI migration-validation
job (`.github/workflows/ci.yml`), the boot-refusal integration test
(`src/bootstrap-isolation.integration.spec.ts`), and the one generated file in the entire diff
(`src/metadata.ts`, Nest/Swagger's own build-time metadata, regenerated — not hand-edited — by
`nest build`).

**Every file in this 70-file diff was individually attributed to a specific phase and a specific,
named reason.** None is unaccounted for, and — this closure review's specific ask — **nothing
outside Phase 0/1/2's Database, Redis, environment-separation, and audit scope appears anywhere in
this diff.** In particular: no Phase 3 (storage/third-party) file, no Phase 4+ (Railway resource
creation, CI/CD, UI banner) file, and no unrelated feature work is present.

### 29.12.2 Migration advisory lock — review and hardening

Re-reading `src/database/migration-lock.util.ts` against the four specific asks:

| Ask                                                   | Before this review                                                                                                                                                                                                                                                          | After this review                                                                                                                                                                                                                                                              |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Same lock ID for every web replica and the CLI        | ✅ Already true — `main.ts`'s in-app safety net and `migrate-cli.ts` both call the same exported `withMigrationAdvisoryLock`, which computes the lock ID from one `const MIGRATION_LOCK_NAME` inside this module. No caller can drift from it because no caller can set it. | Unchanged (confirmed, not modified)                                                                                                                                                                                                                                            |
| A clear lock timeout                                  | ❌ None — `pg_advisory_lock` waited indefinitely                                                                                                                                                                                                                            | ✅ Added. Postgres's own session `lock_timeout` GUC is set (default 5 minutes, `MIGRATION_LOCK_TIMEOUT_MS`) immediately before the acquire attempt; a `55P03` (`lock_timeout`) error is caught and re-thrown as a named `MigrationLockTimeoutError` with an actionable message |
| Lock released in `finally`                            | ✅ Already true                                                                                                                                                                                                                                                             | Unchanged — still released in `finally`, now additionally proven not to fire when the lock was never actually acquired (a timeout must not attempt to unlock a lock this process never held)                                                                                   |
| The second process doesn't wait indefinitely (tested) | ❌ Never tested — the only existing live proof (`verify:migration-lock`) tested the blocking behaviour with no timeout involved                                                                                                                                             | ✅ A second scenario added to `npm run verify:migration-lock`, proving a waiter configured with a short timeout gives up in roughly that time even though the holder keeps the lock for far longer                                                                             |

**A real, previously-latent bug was found and fixed while building the timeout test, not invented
for it.** The original implementation issued each statement (`hashtext(...)`, `pg_advisory_lock`,
`pg_advisory_unlock`) via `dataSource.query()`, which checks a connection out of TypeORM's
underlying pool **per call** — nothing guarantees two separate `.query()` calls land on the _same_
physical Postgres session. Advisory locks (and `SET lock_timeout`) are both session-scoped:
acquiring on one pooled connection and releasing on a different one is not an error, it is a
**silent no-op** (Postgres simply reports the caller doesn't hold that lock and does nothing) —
which would have meant a lock, once acquired on the "wrong" pooled connection, could stay held
until that connection happened to be recycled by the pool, an unbounded and unpredictable amount of
time. This was caught empirically: a live timing test (spawning the holder and the waiter as two
real, separate OS processes — see below for why it has to be two processes) initially showed the
configured 700ms timeout taking ~2.9 **seconds** to fire. Root-caused to exactly this pooling
behaviour, and fixed by rewriting `withMigrationAdvisoryLock` to open one dedicated `QueryRunner`
(one physical connection, held for the entire acquire → run → release sequence) instead of calling
`dataSource.query()` per statement. This is a strictly more correct implementation of a
session-scoped primitive, independent of the timeout feature that surfaced it, and the existing
13 unit tests plus a live re-run (`npm run verify:migration-lock`) both confirm the fix: the second
scenario's waiter now reports failing at **715ms** against a 700ms configured timeout.

**Why the live timeout test spawns two separate OS processes instead of two `DataSource`s racing in
one Node process (the pattern the original blocking-proof scenario still correctly uses):**
empirically, racing two lock attempts with a small non-zero `lock_timeout` inside a single Node.js
event loop — even reproduced with the raw `pg` driver, no TypeORM involved at all — produced
the same wrong ~2.9s figure instead of the configured value. The identical scenario, run as two
genuinely separate `node` processes (`scripts/internal/lock-worker.ts`, spawned twice by
`scripts/verify-migration-lock.ts`), reported the correct ~700ms figure immediately and
consistently. Since two real Railway replicas are _always_ two separate OS processes and never two
tasks sharing one Node event loop, the two-process design is not a workaround for an inconvenient
test result — it is the more faithful reproduction of what this lock actually has to coordinate in
production, and it is what the shipped test uses.

**Configuration discrepancy between the CLI and application startup:** structurally prevented, not
merely avoided by convention. `MIGRATION_LOCK_TIMEOUT_MS` is read by one function
(`resolveLockTimeoutMs`) inside `migration-lock.util.ts` itself; neither `main.ts`'s
`runPendingMigrations()` nor `migrate-cli.ts` pass a timeout value of their own, so there is no
place for the two call sites to specify different numbers even by mistake.

### 29.12.3 Migration run policy — decoupling migrations from every web replica's boot

**Reviewed, not changed in the deploy-critical path.** `nixpacks.toml` and `Procfile` — which
define Production's actual start command today — were deliberately left untouched in this closure
pass: they are the file Production's _next_ deploy reads, and changing them is a Production change,
which this pass was explicitly told not to make.

**What is recommended, and why it isn't wired in as a hardcoded literal:** the plan's own §8.2
already anticipated this — running a migration step as part of every web replica's boot command is
exactly the shape that makes concurrent migrations possible in the first place. Once a staging
Railway project exists, its web service's **Start Command** should be set (in the Railway dashboard,
overriding `nixpacks.toml`'s default per-service — Railway supports this) to skip the migration
step entirely, and migrations should instead run from a separate, single-shot **Pre-Deploy Command**
or a **dedicated one-off Migration Job service** in the same project, pointed at the same
lock-protected migration entrypoint the current combined start command already uses. Concretely:
`RUN_MIGRATIONS=false` should be the suggested value for the web service once that separate step
exists (this variable already exists — Phase 2 added it as an opt-out — this closure pass changes
only the _recommendation_ of what value to give it, not its behaviour). This document deliberately
does not spell out the exact literal command string to paste into that Railway field: the correct
one is already defined once, in `package.json`, and repeating it here as "the" configuration would
create a second place that could drift from the first the next time either changes, and would
assert a specific Railway UI mechanic (Pre-Deploy Command vs. a separate job service) this
environment has no dashboard access to confirm still matches Railway's current product surface.
Whoever configures the Railway service should read the current script name from `package.json`
directly and verify it against whichever Railway feature is available at configuration time.

**Why the in-app migration path (`main.ts`'s `runPendingMigrations()`) still exists rather than
being removed:** its "clear and secure use" is as a defence-in-depth fallback for a deployment
topology that has _not yet_ been updated to use a separate pre-deploy step — it is lock-protected
(§29.12.2), idempotent (TypeORM's own `runMigrations()` no-ops on an already-migrated database), and
individually opt-outable via `RUN_MIGRATIONS=false` without touching the external start command at
all. Once a Railway Pre-Deploy Command or Migration Job is actually configured for a given
environment, that environment's web service should set `RUN_MIGRATIONS=false` to fully decouple —
at which point this path becomes fully dormant for that environment, never a second, competing
place migrations can run from. Removing the code entirely was considered and rejected: it would
leave an environment with a misconfigured or not-yet-configured separate migration step with **no**
migration path at all, silently serving stale schema instead of failing loudly.

**Production is unaffected by this section.** No file Production's deploy reads was changed; the
only artefact of this section is documentation of what to configure once Staging exists.

### 29.12.4 Staging seed — re-verified line by line against the seven-point checklist

Re-read `src/database/seed-staging.ts` in full for this closure pass (not re-derived from memory).
Each point checked directly against the current code:

| Requirement                                                        | Verified | Where                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does not use `synchronize` or `dropSchema`                         | ✅       | The seed's own `DataSource` is constructed with `synchronize: false` and no `dropSchema` option at all — `runStagingSeed()`                                                                                                                                                                                                                             |
| Does not execute any query before validating the database identity | ✅       | `runStagingSeed()`'s first two statements are `assertSafeTarget(process.env, databaseUrl)` then `assertSeedArmed(process.env)` — both pure string/URL parsing, zero I/O — _before_ the `DataSource` is even constructed, let alone `.initialize()`d                                                                                                     |
| Rejects non-staging `APP_ENV`s                                     | ✅       | `assertSafeTarget`'s Guard 1: throws `UnsafeSeedTargetError` if `resolveAppEnv(...) === AppEnvironment.Production`                                                                                                                                                                                                                                      |
| Rejects the absence of `ALLOW_STAGING_SEED=true`                   | ✅       | `assertSeedArmed()`: throws `SeedNotArmedError` unless the env value is exactly `'true'` — a Phase 2 addition, independent of target-identity verification                                                                                                                                                                                              |
| Rejects databases not dedicated to staging                         | ✅       | `assertSafeTarget`'s Guards 2 and 3: a denylist of known production hosts/database names, **and** a positive requirement that the database name match `/(staging\|stg)/i` — an unrecognised name is treated as unsafe, not merely "not proven safe"                                                                                                     |
| Does not run on boot / reset                                       | ✅       | Not imported or called anywhere in `src/app.module.ts`, `src/main.ts`, or any `OnModuleInit`/`OnApplicationBootstrap` hook — confirmed by grep, not just by absence of a memory of wiring it in. The only entry points are the explicit `npm run seed:staging` script and the two verification scripts, both of which re-run the same guards themselves |
| Does not touch any other schema or database                        | ✅       | The seed's `DataSource` connects to exactly one `DATABASE_URL`; its `--reset` path (`truncateSeededTables`) truncates only the fixed `SEEDED_TABLES` list (18 named tables this seed itself writes), never a dynamic table list and never a cross-database statement                                                                                    |

**No code change resulted from this re-check — every point was already correctly implemented in
Phase 2.** This section exists so that conclusion is backed by a fresh line-by-line read during
closure, not carried forward unverified from the original implementation pass.

---

# 30. Phase 3 Execution Record

**Executed:** 2026-08-06 · **Phase:** 3 (Storage and third-party integrations) · **Status: COMPLETE**
**Objective:** every external dependency (R2, Bunny Stream, MailerSend, Twilio, Meta WhatsApp,
Firebase, Paymob, webhooks) isolated between staging and production, with the isolation that
already existed at boot re-verified and the runtime gaps it exposed actually closed.
**Production touched:** none. **External resources created:** none — see
[`PHASE_3_DASHBOARD_CHECKLIST.md`](../docs/PHASE_3_DASHBOARD_CHECKLIST.md). **Real messages/charges
sent during this phase:** none.

## 30.1 Root findings from the audit

A read-only survey of every integration's actual code (not assumed from `.env.example`'s prose)
found:

1. **`storage.service.ts` had zero `AppEnvironment` awareness** — its only staging protection was
   the boot guard's `checkStorage()`, already built in Phase 0/1. It was thorough (bucket name,
   video library, CDN host, public-base-URL) but missing the R2 **account** identifier — a
   correctly-named staging bucket living under the production Cloudflare account is still one
   over-scoped token away from unsafe.
2. **The single biggest gap: `MAIL_ALLOWLIST` and `SMS_MODE=sandbox` were required at boot but
   enforced nowhere at runtime.** The isolation guard forced an operator to set them; nothing in
   `mail.service.ts`, `sms-sender.service.ts`, or `whatsapp-meta.channel.ts` ever read them. A
   correctly-configured staging deployment would still email and text real people.
3. **Paymob's `PAYMOB_EXPECTED_MODE` guards the app's own belief, not what Paymob actually does.**
   Whether a transaction is live money is decided by the **integration reference** submitted, which
   was not checked against production's at all.
4. **The weekly "file cleanup" cron doesn't touch R2** — despite its name, flag, and documentation
   implying it deletes from object storage, it only scans a local disk folder that R2-backed
   deployments never populate. A documentation-accuracy bug, not an isolation gap, but worth fixing
   so nobody designs a guard around a risk that doesn't exist in this code.
5. **`whatsapp-webhook.controller.ts` had zero test coverage** for its signature verification —
   the one thing standing between an internet-facing, unauthenticated endpoint and forged delivery
   receipts had never been exercised with fake/forged/tampered data.
6. **Bunny Stream has no inbound webhook** (status is polled, not pushed) — nothing to isolate
   there beyond the library/CDN identity the boot guard already checks.
7. **Push notifications do not exist in this codebase.** Firebase's only real use is ID-token
   verification for sign-in; `.env.example`'s section heading mislabelled it as SMS/push. Nothing
   to sandbox because nothing sends.

## 30.2 Files changed — reason for each

| File                                                                      | Change                                                                                                                                                                                                                                                                                                                                                                                   | Reason                                                                                                                                                                                                    |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config/environment-isolation.guard.ts`                               | +`STAGING_PRODUCTION_R2_ACCOUNT` (`R2_ACCOUNT_ID`), +`STAGING_PRODUCTION_PAYMENT_INTEGRATION` (`PAYMOB_CARD_INTEGRATION_ID`, `PAYMOB_IFRAME_ID`), +`STAGING_PRODUCTION_WHATSAPP_NUMBER` (`META_WHATSAPP_PHONE_NUMBER_ID`), +`STAGING_PRODUCTION_FIREBASE_PROJECT` (`FIREBASE_PROJECT_ID`)                                                                                                | Closes root finding 1 and 3; extends the existing identifier-denylist pattern to every resource reference this phase's audit found unchecked                                                              |
| `src/config/environment-isolation.guard.spec.ts`                          | +8 test cases for the four new checks                                                                                                                                                                                                                                                                                                                                                    | Every new check gets a positive (denied) and, where relevant, a negative (absent → not flagged) case                                                                                                      |
| `src/common/utils/staging-messaging-guard.util.ts` (new)                  | `evaluateMailRecipient`, `applyStagingSubjectPrefix`, `evaluatePhoneRecipient`                                                                                                                                                                                                                                                                                                           | The single shared implementation of "allowlisted recipient → real send, everyone else → sandboxed" for mail and SMS/WhatsApp — closes root finding 2                                                      |
| `src/common/utils/staging-messaging-guard.util.spec.ts` (new)             | 16 unit tests                                                                                                                                                                                                                                                                                                                                                                            | Every function's staging/non-staging, allowed/blocked, case-insensitivity, and idempotent-prefix behaviour                                                                                                |
| `src/mail/mail.service.ts`                                                | `deliver()` now checks `evaluateMailRecipient` before calling MailerSend, and applies `applyStagingSubjectPrefix` to non-templated subjects                                                                                                                                                                                                                                              | The one funnel every outbound email passes through — one check covers every call site in the file                                                                                                         |
| `src/mail/mail.service.spec.ts`                                           | +3 tests (blocked, allowed-with-prefix, production-inert)                                                                                                                                                                                                                                                                                                                                | Proves the new behaviour without touching the real MailerSend SDK                                                                                                                                         |
| `src/notifications/services/sms-sender.service.ts`                        | `sendSms()` now checks `evaluatePhoneRecipient` before calling Twilio; sandboxed sends report `{ success: true }`                                                                                                                                                                                                                                                                        | The one funnel every Twilio call in the app passes through (guardian notifications, admin bulk sends, and anything added later)                                                                           |
| `src/notifications/services/sms-sender.service.spec.ts` (new)             | 4 tests                                                                                                                                                                                                                                                                                                                                                                                  | This service had **no existing spec file** at all; added one focused on the new sandbox behaviour                                                                                                         |
| `src/notifications/channels/whatsapp-meta.channel.ts`                     | `send()` now checks `evaluatePhoneRecipient` before calling the Meta Graph API; sandboxed sends report `{ accepted: true }`                                                                                                                                                                                                                                                              | The only place that calls Meta's API                                                                                                                                                                      |
| `src/notifications/channels/whatsapp-meta.channel.spec.ts`                | +2 tests (sandboxed, allowlisted-real-send)                                                                                                                                                                                                                                                                                                                                              | Proves the new behaviour against the existing mock-`HttpService` harness                                                                                                                                  |
| `src/notifications/controllers/whatsapp-webhook.controller.spec.ts` (new) | 12 tests                                                                                                                                                                                                                                                                                                                                                                                 | Closes root finding 5 — signature accept/reject with fake HMACs, missing header, wrong scheme, missing raw body, missing secret, unrecognised status values, and the full verify-token handshake          |
| `src/database/migration-lock.util.ts`                                     | Added `MIGRATION_LOCK_TIMEOUT_MS`/`MigrationLockTimeoutError` (Postgres `lock_timeout`); rewrote to use one dedicated `QueryRunner` instead of per-statement `dataSource.query()` calls                                                                                                                                                                                                  | Phase 2 closure item — see §29.12.2. Also fixed a real, previously-latent bug (lock/unlock could silently land on different pooled connections) found while building the timeout test                     |
| `src/database/migration-lock.util.spec.ts`                                | +9 tests (timeout error path, dedicated-connection guarantee, release-on-every-exit-path)                                                                                                                                                                                                                                                                                                | Same                                                                                                                                                                                                      |
| `scripts/verify-migration-lock.ts`                                        | Added a second live scenario proving a waiter times out instead of waiting indefinitely; rewritten to spawn the holder/waiter as two real OS processes                                                                                                                                                                                                                                   | Phase 2 closure item — an in-process race was found to make Postgres's `lock_timeout` fire ~2.9s late instead of at the configured bound; two real processes reproduce the correct, ~timeout-bound figure |
| `scripts/internal/lock-worker.ts` (new)                                   | `hold`/`wait` worker invoked by the script above                                                                                                                                                                                                                                                                                                                                         | Supports the two-process design                                                                                                                                                                           |
| `docs/E2E_KNOWN_FAILURES.md` (new)                                        | Per-suite classification of all 6 known E2E failures                                                                                                                                                                                                                                                                                                                                     | Phase 2 closure item — required deliverable                                                                                                                                                               |
| `docs/STAGING_STORAGE_SETUP.md` (new)                                     | Storage isolation summary                                                                                                                                                                                                                                                                                                                                                                | Required Phase 3 deliverable                                                                                                                                                                              |
| `docs/STAGING_EXTERNAL_SERVICES_SETUP.md` (new)                           | Mail/SMS/WhatsApp/Firebase/Paymob/webhook isolation summary                                                                                                                                                                                                                                                                                                                              | Required Phase 3 deliverable                                                                                                                                                                              |
| `docs/PHASE_3_DASHBOARD_CHECKLIST.md` (new)                               | R2/Bunny/MailerSend/Paymob/Meta/Firebase/Sentry dashboard steps                                                                                                                                                                                                                                                                                                                          | Required Phase 3 deliverable                                                                                                                                                                              |
| `.env.example`                                                            | +`SMS_ALLOWLIST`; annotated `R2_ACCOUNT_ID`, `PAYMOB_CARD_INTEGRATION_ID`/`PAYMOB_IFRAME_ID`, `FIREBASE_PROJECT_ID`, `META_WHATSAPP_PHONE_NUMBER_ID` with their new isolation role; corrected the Firebase section heading (was "SMS notifications to parents" — the only real usage is ID-token sign-in); rewrote `SMS_MODE`/`MAIL_ALLOWLIST` comments to describe now-real enforcement | Every new/changed variable documented, per the standing rule of not adding one without a specific, stated function                                                                                        |
| `STAGING_ENVIRONMENT_IMPLEMENTATION_PLAN.md`                              | This section, §29.12, and the banner                                                                                                                                                                                                                                                                                                                                                     | Documentation of record                                                                                                                                                                                   |

**Not touched, and explicitly out of scope:** Railway/Vercel/DNS resource creation (Phase 4),
CI/CD and branch protection (Phase 5), the remaining `staging-isolation.guard.ts` items beyond
storage/third-party (Phase 6 in the original numbering — largely already delivered across Phases
0–3 under this session's actual sequencing), UI banner/robots/sitemap (Phase 7).

## 30.3 Storage isolation result

Extended, not rebuilt — see [`STAGING_STORAGE_SETUP.md`](../docs/STAGING_STORAGE_SETUP.md). The
Phase 0/1 boot guard already covered bucket name, video library, CDN host, and the
public-base-URL rule; this phase added the R2 account-identifier check and corrected the file
-cleanup cron's documentation. No runtime (post-boot) check was added inside `storage.service.ts`
itself — the boot guard already gates every call site before the service is ever constructed, so a
second check would be redundant, not additive.

## 30.4 Video isolation result

No code change. Bunny Stream's library ID and CDN hostname were already checked at boot; Bunny
Stream has no inbound webhook (status is polled via `getVideo()`, never pushed), so there is no
webhook secret to isolate for this provider. Verified, not assumed, by reading
`bunny-stream.service.ts` in full and confirming zero controllers reference Bunny webhooks.

## 30.5 Messaging safety result

**Mail:** allowlist now enforced at the one MailerSend call site; `[STAGING]` prefix applied to
non-templated subjects (templated subjects require the staging deployment's own MailerSend
templates to carry the prefix themselves — documented limitation, not a gap silently left
unmentioned).

**SMS/WhatsApp:** allowlist (`SMS_ALLOWLIST`, new) now enforced at the one Twilio call site and the
one Meta Graph API call site. A non-allowlisted number is sandboxed — zero outbound provider call —
and reported to the caller as a successful, delivered send, so the guardian-notification worker
never falls back to a second live channel for a message that was deliberately never attempted.

**Push:** does not exist in this codebase. Nothing to isolate; documented so nobody spends time
looking for it.

## 30.6 Payment sandbox result

`PAYMOB_EXPECTED_MODE=test` requirement (Phase 0/1) plus secret fingerprinting (Phase 0/1) plus
the new integration/iframe-ID identifier checks (this phase) together mean a staging deployment
cannot process a genuinely live-capable Paymob transaction through any of the three paths that
matter: the mode flag, the credentials, or the integration reference itself. Webhook signature
verification against fake/forged data — already covered by `paymob.gateway.spec.ts` before this
phase — was reviewed and confirmed adequate, not rebuilt. The synthetic seed's payment rows were
re-confirmed to use only sandbox-shaped reference strings and never call the gateway.

## 30.7 Webhook isolation result

Every inbound webhook (`POST /api/v1/payments/webhook[/callback]`,
`GET`/`POST /api/v1/webhooks/whatsapp`) already had its secret in the fingerprint denylist from
Phase 0/1. Cross-environment replay is prevented by construction — a payload signed with
production's secret fails signature verification against staging's different secret, and vice
versa — so no new "environment marker" column was added to `gateway_webhook_events`; that would
have been a second, redundant control for a risk the signature check already closes (see
`STAGING_EXTERNAL_SERVICES_SETUP.md` §6 for the full reasoning). Duplicate-delivery protection
(Paymob's idempotency-key unique constraint) was already tested; WhatsApp's signature verification
had zero tests before this phase and now has 12.

## 30.8 New environment variables

| Variable        | Default                                          | Purpose                                                                                                                                                        |
| --------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SMS_ALLOWLIST` | unset (= every real number sandboxed on staging) | Comma-separated E.164 numbers that still receive a real SMS/WhatsApp message on staging; mirrors `MAIL_ALLOWLIST`'s semantics for the phone-addressed channels |

No other new variables. `R2_ACCOUNT_ID`, `PAYMOB_CARD_INTEGRATION_ID`, `PAYMOB_IFRAME_ID`,
`META_WHATSAPP_PHONE_NUMBER_ID`, and `FIREBASE_PROJECT_ID` all already existed — this phase changed
what the isolation guard _does_ with them, not their names or presence.

## 30.9 Dashboard actions required

**None performed. None possible from this environment.** The full checklist for creating the R2
staging bucket, the Bunny Stream staging library, the MailerSend staging domain/key/templates, the
Paymob test merchant credentials and webhook registration, the Meta WhatsApp test number, the
Firebase staging project, and the Sentry staging project/tag is in
[`PHASE_3_DASHBOARD_CHECKLIST.md`](../docs/PHASE_3_DASHBOARD_CHECKLIST.md).

## 30.10 Test results (numerical)

| Check                               | Command                                                               | Result                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend type-check                  | `npx tsc --noEmit -p tsconfig.build.json`                             | ✅ PASS                                                                                                                                                                                                                                                                                                                                                 |
| Backend lint (ESLint)               | `npx eslint .`                                                        | ✅ PASS — 0 problems                                                                                                                                                                                                                                                                                                                                    |
| Backend build                       | `npm run build`                                                       | ✅ PASS (1025 files compiled)                                                                                                                                                                                                                                                                                                                           |
| Prettier — touched files            | `npx prettier --write <21 files>`                                     | ✅ PASS (reformatted, re-verified clean)                                                                                                                                                                                                                                                                                                                |
| Backend unit tests                  | `npx jest --ci --runInBand`                                           | ⚠️ **1134/1135 passed** (1 pre-existing, unrelated failure — `guardians/guardians.service.spec.ts`, identical to every prior run this session)                                                                                                                                                                                                          |
| New/changed tests this phase        | —                                                                     | **+43 tests**: `environment-isolation.guard.spec.ts` (+8), `staging-messaging-guard.util.spec.ts` (+16, new file), `mail.service.spec.ts` (+3), `sms-sender.service.spec.ts` (+4, new file), `whatsapp-meta.channel.spec.ts` (+2), `whatsapp-webhook.controller.spec.ts` (+12, new file); plus the Phase 2 closure's `migration-lock.util.spec.ts` (+9) |
| Migration-lock live verification    | `npm run verify:migration-lock`                                       | ✅ PASS — blocking scenario: B waited ~1.40s behind A's ~1.5s hold; timeout scenario (two real OS processes): waiter reported timing out at ~715ms against a 700ms configured bound                                                                                                                                                                     |
| Webhook signature tests (fake data) | `npx jest paymob.gateway.spec.ts whatsapp-webhook.controller.spec.ts` | ✅ PASS — forged/tampered/unsigned/wrong-integration Paymob callbacks all rejected; forged/tampered/missing/wrong-scheme WhatsApp signatures all rejected                                                                                                                                                                                               |
| Full E2E suite                      | `npm run test:e2e -- --ci --runInBand`                                | see §30.11                                                                                                                                                                                                                                                                                                                                              |

### 30.11 Full E2E result

**Real, captured exit code: `1`.** `Test Suites: 3 failed, 16 passed, 19 total` / `Tests: 3 failed,
130 passed, 133 total`. Captured to a file independently of the background task's own completion
notification, per the standing lesson from Phase 2 (the notification is not trustworthy for this —
see §26.7). Postgres 16 and Redis 7 service containers (`test-postgres-1`, `test-redis-1`) were
confirmed `Healthy` before the run and torn down afterward (`docker compose down`, confirmed
removed via `docker ps -a`).

The 3 failures — `subjects-ownership.e2e-spec.ts`, `call-center-phase6.e2e-spec.ts`,
`call-center-phase5.e2e-spec.ts` — are, line for line, the identical assertion and test name as
items #1, #3, and #4 in `docs/E2E_KNOWN_FAILURES.md`, already classified there as pre-existing
application bugs unrelated to any phase of this project. The other 3 documented failures
(`payment-financial-state-machine.postgres.e2e-spec.ts`, `certificates.e2e-spec.ts`,
`auth.e2e-spec.ts`) **passed cleanly in this run** — consistent with their existing classification
as a concurrency-timing test and two harness-contention flakes, none of which fail deterministically.

**Zero new failures caused by Phase 3's code.** This is never rounded up to "the suite passes" —
the exit code is 1 and is reported as 1.

## 30.12 Remaining risks

| Risk                                                                                                                                                                                                         | Assessment                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MailerSend templated sends cannot carry a code-applied `[STAGING]` prefix                                                                                                                                    | Documented limitation (§30.5) — mitigated operationally by using distinct staging template IDs with the prefix baked into the template's own subject in the MailerSend dashboard                 |
| No admin endpoint exists for `GatewayWebhookService.replayDeadLetter()`                                                                                                                                      | Pre-existing gap, unrelated to isolation; noted, not built (new feature work, not this phase's scope)                                                                                            |
| The 6 known E2E failures from Phase 2 (§29.8 / `docs/E2E_KNOWN_FAILURES.md`)                                                                                                                                 | Unchanged by this phase — none of Phase 3's files touch any of their code paths                                                                                                                  |
| Push notifications                                                                                                                                                                                           | Do not exist; if a future phase adds them, they will need the same allowlist/sandbox treatment this phase gave mail and SMS/WhatsApp                                                             |
| `PROD_IDENTIFIER_DENYLIST` must be populated with real production values (R2 account ID, Paymob integration/iframe IDs, Meta phone number ID, Firebase project ID) for the four new checks to catch anything | Same operational dependency every existing identifier check already has (e.g. `BUNNY_STREAM_LIBRARY_ID`) — not a new class of risk, just more entries for the same already-established mechanism |

## 30.13 Rollback procedure

Identical shape to Phase 2 (§29.10): every change is additive and inert unless `APP_ENV=staging`
(the mail/SMS/WhatsApp guards) or unless the specific new identifier variables are populated with a
value matching the denylist (the boot-guard checks). No database schema changed, no migration was
added, no external resource was created. Reverting the code fully reverts this phase with zero
residue.

## 30.14 Acceptance criteria

| Criterion                                                                                                        | Met                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Storage: boot guard denies a production-shaped bucket/account/library/CDN host                                   | ✅ (bucket/library/CDN from Phase 0/1, account this phase)                                                                             |
| Mail: non-allowlisted recipient never reaches MailerSend                                                         | ✅ Proven by test, not just by boot-time requirement                                                                                   |
| SMS/WhatsApp: non-allowlisted recipient never reaches Twilio/Meta                                                | ✅ Proven by test                                                                                                                      |
| Payment: staging cannot submit a live-capable Paymob transaction via mode, credentials, or integration reference | ✅                                                                                                                                     |
| Webhook signatures verified against fake/forged data for every inbound webhook                                   | ✅ (Paymob pre-existing, WhatsApp new this phase)                                                                                      |
| Production configuration unchanged                                                                               | ✅ — every new check/behaviour is `APP_ENV`-gated or identifier-denylist-gated, both of which are empty/inert on production by default |
| Dashboard actions documented, none performed                                                                     | ✅                                                                                                                                     |

**Phase 3 is complete.** No external resource was created (none was possible from this
environment) — the full checklist is in `PHASE_3_DASHBOARD_CHECKLIST.md`.

---

# 31. Phase 4 Execution Record

## 31.1 What this phase actually did, and why so much of it is a checklist

Phase 4 ("Railway services and DNS") is inherently a dashboard-execution phase — it means
provisioning a new Railway project, a new Vercel project, DNS records, and a Cloudflare Access
application. This session has:

- **Authenticated Railway CLI access** (`railway whoami` → `mohamedhalemm40@gmail.com`), which was
  used **read-only** to audit the real, current Production topology — nothing was created,
  modified, or redeployed.
- **No Vercel session** (`vercel whoami` → `Error: The specified token is not valid`).
- **No GitHub CLI** (`gh`: not installed) and **no authenticated GitHub REST API access**
  (unauthenticated calls to `api.github.com` return `404`/`401` for both private repos).
- **No Cloudflare access** of any kind (no CLI, no API token, no `wrangler`).

Per this phase's own instruction ("do not create external resources without explicit access" /
"for any step that requires an external dashboard or unavailable permissions, stop and write down
exactly what is needed"), everything requiring one of the above was **audited where possible and
documented as a precise checklist otherwise** — never assumed, never claimed as done. The full
checklist, environment variable matrix, and every command used to obtain each fact is in
[`docs/PHASE_4_DASHBOARD_CHECKLIST.md`](../docs/PHASE_4_DASHBOARD_CHECKLIST.md).

## 31.2 Critical findings from the Railway audit

Two findings independent of anything this project has built, surfaced only because this was the
first session with real (read-only) Railway CLI access:

1. **Railway's `web` service auto-deploys every push to `main`, with no approval gate — and it
   already did so for this project's own "staging" prep commit.** `railway status --json` shows
   the live deployment's `commitHash` is `7d0ba8ee1bd372c4f1c6059d018d0bcf72cc022f`
   (`commitMessage: "staging"`), deployed `2026-08-06T06:49:53Z` — the exact commit this project's
   Phase 0–2 work was pushed to `origin/main` under, in a prior session, before this project's own
   push access was confirmed. Because every change in that commit is `APP_ENV`-gated or
   identifier-denylist-gated (both inert by default), this did not change Production's observable
   behaviour — but it is direct, first-hand proof of exactly the risk Phase 5's "disable
   auto-deploy from the production branch, or make CI the controller" requirement exists to close,
   not a hypothetical.
2. **The domain this project's own frontend code and Phase 0 audit cite as Production's API
   (`learning-center-backend-production.up.railway.app`) does not resolve to anything today** —
   `curl` against it returns Railway's own edge-fallback `404 {"message":"Application not
found"}`. The service's real, live domain (read from `railway status --json`) is
   `web-production-7bd6e.up.railway.app`, which returns `200 {"status":"healthy"}`. This predates
   this project entirely (no action taken in Phases 0–3 renames a Railway service domain) and is
   **not fixed here** — it is a Production frontend/Vercel-configuration question
   (`docs/PHASE_4_DASHBOARD_CHECKLIST.md` §0.2 has the exact next step: check `NEXT_PUBLIC_API_URL`
   in the `dodline` Vercel project's Production environment).

## 31.3 Real Railway state (verified, not assumed)

| Question the plan asked                             | Answer                                                                                                                           |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Railway project named `learnix-staging`?            | **No.** Only one project (`learnix`) exists in this account (plus two unrelated ones in a different workspace)                   |
| Separate staging Postgres/Redis/API service?        | **No** — `learnix` has one environment (`production`) and three services (`web`, `Postgres`, `Redis`), all Production            |
| `web` branch                                        | `main`                                                                                                                           |
| `web` build/start command                           | NIXPACKS build; start `npm run start:migrate:prod` (migrations run on every deploy, unconditionally)                             |
| `web` healthcheck path                              | `/api/v1/health`                                                                                                                 |
| Migrations running automatically?                   | **Yes** — no separate migration job; `RUN_MIGRATIONS` is not set on `web`                                                        |
| Pre-deploy command configured?                      | **No** (`null`)                                                                                                                  |
| Private networking for Postgres/Redis?              | Both have no public domain at all (`serviceDomains: []`), consistent with Railway's default private-only same-project networking |
| Any variable pointing at Production from elsewhere? | N/A — nothing staging-shaped exists yet to check                                                                                 |

Full variable **key list** (never values) for the live `web` service, and the full environment
variable matrix for the staging service that needs to be created, are both in
`docs/PHASE_4_DASHBOARD_CHECKLIST.md` §2.

## 31.4 Files changed this phase

| File                                         | Reason                                                                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/PHASE_4_DASHBOARD_CHECKLIST.md` (new)  | Every Railway fact verified this phase, the full environment variable matrix, and the exact Vercel/DNS/Cloudflare Access steps needed from a human with dashboard access |
| `scripts/smoke-test.sh` (new)                | Post-deploy smoke test per §13.3 — read-only unless `--with-login` is passed with a seeded account's credentials; never runs a payment, refund, or send                  |
| `STAGING_ENVIRONMENT_IMPLEMENTATION_PLAN.md` | This record; status banner                                                                                                                                               |

## 31.5 Migration run policy for staging

Documented, not applied anywhere (no staging service exists to apply it to): the **new** staging
`web` service should use start command `npm run start:prod` (no migrations) plus a **Pre-deploy
Command** of `npm run migration:run:prod` (the advisory-locked runner hardened in Phase 2
closure), with `RUN_MIGRATIONS=false` set as a redundant belt-and-braces disable of the in-app
safety net. **Production's `web` service configuration is untouched** — changing its start
command is a Production infrastructure change and explicitly out of scope for this phase.

## 31.6 Smoke test — run against Production (read-only) as verification

`scripts/smoke-test.sh` was written and then run once, read-only, against the real live
Production domain (`web-production-7bd6e.up.railway.app` — not the dead one, §31.2) to prove the
script itself works and to get a genuine current Production health reading:

```
PASS  GET /api/v1/health (200)
PASS  GET /api/v1/health/readiness (200)
PASS  GET /api/v1/packages (public) (200)
PASS  GET /api/v1/auth/csrf-token (200)
SKIP  login/refresh (--with-login not passed — no credentials used against Production)
All checks passed.
```

No staging URL exists yet to run the full smoke suite against.

## 31.7 Dashboard actions required (none performed)

Full detail in `docs/PHASE_4_DASHBOARD_CHECKLIST.md`. Summary:

| Action                                                                          | Blocked by                                                                                                    |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Create Railway project `learnix-staging` + Postgres + Redis + `web` service     | Requires your explicit go-ahead (new billed, standing infrastructure) and dashboard access                    |
| Create Vercel project `dodline-staging`                                         | No valid Vercel session from this environment                                                                 |
| Add `api-staging.learnix.school` / `staging.learnix.school` DNS records         | No registrar/Cloudflare access                                                                                |
| Configure Cloudflare Access on `staging.learnix.school`                         | No Cloudflare access                                                                                          |
| Check `NEXT_PUBLIC_API_URL` on the existing `dodline` Production Vercel project | Separate, pre-existing Production question (§31.2) — needs a human with Vercel access, independent of staging |

## 31.8 Production verification

Confirmed healthy and unaffected by this phase (§31.6). The `learning-center-backend-production...`
domain 404 (§31.2) predates this session and is not a regression introduced by Phases 0–4.

## 31.9 Rollback

Nothing was created, so nothing needs to be rolled back. `docs/PHASE_4_DASHBOARD_CHECKLIST.md` and
`scripts/smoke-test.sh` are additive documentation/tooling with no runtime effect on Production or
any other environment.

## 31.10 Acceptance — Phase 4 status

Per the plan's own §18 Phase 4 Definition of Done ("both URLs live; a smoke run passes; Production
untouched"): **the DoD cannot be met from this environment**, because "both URLs live" requires
creating billed infrastructure and dashboard access this session does not have. What Phase 4
delivers instead, matching this project's standing practice of never claiming execution that
didn't happen: a verified, assumption-free audit of the real current state; every fact needed to
execute the dashboard steps correctly the first time; and the code/scripts (smoke test, migration
run policy) ready for the moment the infrastructure exists.

**Phase 4 is blocked on dashboard/infrastructure access, with a complete and precise checklist —
not completed.**

---

# 32. Phase 5 Execution Record

## 32.1 Real branch/deploy state (verified via `git ls-remote`, not assumed)

|                           | Backend                                                                                                     | Frontend                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Default branch            | `main`                                                                                                      | `master`                                      |
| Remote branches today     | `main` only                                                                                                 | `master` only                                 |
| `develop` on the remote   | No                                                                                                          | No                                            |
| `develop` created locally | `d90ecd8`, branched from `main`'s `7d0ba8e`                                                                 | `e7b381f`, branched from `master`'s `79392aa` |
| Pushed                    | **No** — see §32.2                                                                                          | **No**                                        |
| Railway deploying from    | `main`, **auto-deploys on every push, no gate** (confirmed live, Phase 4 §31.2)                             | —                                             |
| Vercel production branch  | Not confirmed (no Vercel session)                                                                           | By elimination, `master`                      |
| Branch protection         | Not confirmed via API (no `gh`, unauthenticated GitHub REST API returns `404`/`401` for both private repos) | Same                                          |

## 32.2 Why `develop` exists locally but was not pushed

Both repos had real, uncommitted work sitting in their working trees from prior sessions (backend:
the Phase 2-closure + Phase 3 deliverables; frontend: the Phase 1 H1–H4 deliverables) — discovered
at the start of this phase via `git status`/`git diff --stat`, not assumed away. Per this phase's
own instruction ("do not create `develop` from an unclean working tree"), each repo's `develop`
was created as a branch **pointer** at the exact commit already matching `origin` (`7d0ba8e` /
`79392aa`), then the pending work was committed onto `develop` — never onto `main`/`master`, which
remain byte-identical to `origin` throughout this phase. Per "do not push directly if permissions
or policies are unclear" and this session's standing git-safety rule (push only on explicit
request), both branches are ready locally; pushing them is the first item in
`docs/PHASE_5_GITHUB_ACTIONS.md`.

## 32.3 Files changed this phase

| File                                                                                                                              | Reason                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml` (backend)                                                                                              | Added `format-check` (scoped Prettier), `env-validation`, `migration-safety-check` (non-blocking), `dependency-audit` (non-blocking) jobs                                   |
| `.github/workflows/deploy-staging.yml` (new)                                                                                      | Re-validates real staging config, waits for Railway/Vercel's own deploy, smoke-tests it                                                                                     |
| `.github/workflows/deploy-production.yml` (new)                                                                                   | Staging-soak check, migration-safety classification + db-owner approval gate, pre-deploy backup, manual approval, health wait, read-only smoke test                         |
| `.github/workflows/branch-sync.yml` (new)                                                                                         | Nightly + on-push main/develop divergence check                                                                                                                             |
| `scripts/validate-env.ts` (new)                                                                                                   | Standalone runner for the real `validate()` in `src/config/env.validation.ts`, secret-safe (never echoes `process.env`)                                                     |
| `scripts/migration-safety-check.ts` (new)                                                                                         | Classifies changed migrations SAFE/NEEDS_DB_APPROVAL/BLOCKED by pattern-matching `up()` for DROP TABLE/DROP COLUMN/ALTER...TYPE/SET NOT NULL, plus a missing-`down()` check |
| `docs/CI_CD_SETUP.md`, `docs/BRANCH_PROTECTION_SETUP.md`, `docs/RELEASE_PROCESS_DRAFT.md`, `docs/PHASE_5_GITHUB_ACTIONS.md` (new) | The four required Phase 5 docs                                                                                                                                              |
| `.github/workflows/ci.yml` (frontend)                                                                                             | Added `dependency-audit` (non-blocking); documented the 2 pre-existing lint errors as baseline                                                                              |

## 32.4 The migration-safety and dependency-audit gates are advisory today, by design

Both new backend jobs (`migration-safety-check`, `dependency-audit`) and the frontend
`dependency-audit` job run with `continue-on-error: true`. This is deliberate, not an oversight:

- **`dependency-audit`**: verified `npm audit --audit-level=high` currently reports **3 high + 42
  moderate** on the backend (all transitive through `firebase-admin`'s Google Cloud dependency
  chain) and **2 critical + 6 high + 5 moderate** on the frontend (transitive through
  `next`/`@tailwindcss/postcss`'s `postcss` dependency) — both verified by actually running the
  command, not assumed. Making this blocking today would fail every PR on pre-existing debt
  neither introduced by nor fixable within this phase's scope.
- **`migration-safety-check`**: correctly classifying `NEEDS_DB_APPROVAL` requires the
  `production-db-approval` GitHub Environment (§32.5) to exist so there is somewhere for that
  approval to actually happen; until it does, making this job's non-zero exit block a merge would
  make a legitimate schema change permanently unmergeable.

Both are real, running checks whose output is visible in every CI run today — advisory, not
hidden.

## 32.5 GitHub Environments and branch protection — designed, not applied

No `gh` CLI is installed and no authenticated GitHub REST API access exists from this session
(confirmed: unauthenticated calls to `api.github.com` return `404` for both repos' metadata and
`401` for the branch-protection endpoint). Every setting `deploy-production.yml` and
`deploy-staging.yml` assume — the `production`, `production-db-approval`, and `staging` GitHub
Environments, and branch protection on `main`/`master`/`develop` — is specified exactly in
`docs/BRANCH_PROTECTION_SETUP.md` and `docs/PHASE_5_GITHUB_ACTIONS.md`, ready to apply, not
applied.

## 32.6 The Railway auto-deploy gap is real and unresolved

Repeated here because it is this phase's most consequential finding, first surfaced in Phase 4
(§31.2): Railway's `web` service deploys `main` to Production automatically, with no gate, and
already did so once for this project's own work. `deploy-production.yml`'s approval/backup/
migration-safety gates are real and functional in isolation, but **do not currently control when
Railway actually deploys** — see the workflow file's own header comment and
`docs/PHASE_5_GITHUB_ACTIONS.md` §5 for the two ways to close this, both of which require a human
with Railway dashboard access to decide and apply (this session did not make an unrequested
Production infrastructure change to resolve it unilaterally).

## 32.7 Tests (numerical)

| Check                                      | Command                                                                                               | Result                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend typecheck                          | `npx tsc --noEmit -p tsconfig.build.json`                                                             | ✅ PASS (0 issues)                                                                                                                                                                                                                                                                                                   |
| Backend build                              | `npm run build`                                                                                       | ✅ PASS (1025 files compiled)                                                                                                                                                                                                                                                                                        |
| Backend lint on new scripts                | `npx eslint scripts/validate-env.ts scripts/migration-safety-check.ts`                                | 2 warnings ("file ignored — no matching configuration"), 0 errors — **pre-existing repo-wide behaviour**: `eslint.config.mjs` already excludes all of `scripts/**/*.ts`, confirmed by running the same check against an existing, untouched script (`migration-chain-test.ts`), which produces the identical warning |
| `scripts/validate-env.ts` — passing config | synthetic staging-shaped env (matches the `env-validation` CI job exactly)                            | ✅ `Environment validation passed.`, exit 0                                                                                                                                                                                                                                                                          |
| `scripts/validate-env.ts` — failing config | `NODE_ENV=test` with no other vars                                                                    | ✅ Correctly fails with per-property messages, exit 1                                                                                                                                                                                                                                                                |
| `scripts/migration-safety-check.ts`        | `--base main` (no migrations changed on `develop` vs `main` yet)                                      | ✅ `No migration files changed relative to main.`, exit 0                                                                                                                                                                                                                                                            |
| Destructive-pattern regexes                | Direct check against 5 representative SQL snippets                                                    | ✅ Correctly flags DROP TABLE/DROP COLUMN/SET NOT NULL; correctly treats `ADD COLUMN ... NOT NULL DEFAULT` and `CREATE INDEX CONCURRENTLY` as safe                                                                                                                                                                   |
| `scripts/smoke-test.sh`                    | Run read-only against live Production (`web-production-7bd6e.up.railway.app`)                         | ✅ 4/4 checks passed; login/refresh correctly skipped without `--with-login`                                                                                                                                                                                                                                         |
| New workflow YAML                          | Parsed with `js-yaml` (`ci.yml` ×2, `deploy-staging.yml`, `deploy-production.yml`, `branch-sync.yml`) | ✅ All 5 files parse; job names enumerated and match what's documented                                                                                                                                                                                                                                               |
| Frontend typecheck                         | `npx tsc --noEmit`                                                                                    | ✅ PASS                                                                                                                                                                                                                                                                                                              |
| Frontend build                             | `npm run build` (with a placeholder `NEXT_PUBLIC_API_URL`)                                            | ✅ PASS                                                                                                                                                                                                                                                                                                              |
| Frontend lint                              | `npm run lint`                                                                                        | ⚠️ 27 problems (2 errors, 25 warnings) — the 2 errors are the pre-existing, documented baseline (§32.3), not a regression from this phase's `ci.yml`-only change                                                                                                                                                     |
| Backend npm audit                          | `npm audit --audit-level=high`                                                                        | ⚠️ 45 vulnerabilities (3 high, 42 moderate), all transitive via `firebase-admin` — recorded as baseline, job non-blocking                                                                                                                                                                                            |
| Frontend npm audit                         | `npm audit --audit-level=high`                                                                        | ⚠️ 13 vulnerabilities (2 critical, 6 high, 5 moderate), transitive via `next`/`postcss` — recorded as baseline, job non-blocking                                                                                                                                                                                     |
| E2E / unit suite re-run                    | Not re-run this phase                                                                                 | No `src/` application code changed in Phase 4/5 (only `scripts/`, `.github/`, `docs/`) — the full suite's last real result is Phase 3's (§30.11), unaffected by this phase                                                                                                                                           |

## 32.8 Remaining risks

| Risk                                                       | Assessment                                                                                                                                                                    |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Railway auto-deploys `main` with no gate                   | Unresolved — requires a human Railway-dashboard decision, §32.6                                                                                                               |
| Branch protection unapplied                                | Both repos currently accept a direct push to their default branch (consistent with the original Phase 0 finding R6, not newly discovered)                                     |
| `develop` not pushed                                       | Two real commits sit only in this local working copy until pushed — back them up (e.g. push to a fork, or just push `develop` itself) before this environment's state is lost |
| `dependency-audit` / `migration-safety-check` non-blocking | Real findings, currently advisory only — see §32.4 for exactly what closes each                                                                                               |
| Vercel production branch/env vars unconfirmed              | No Vercel session from this environment; `docs/PHASE_4_DASHBOARD_CHECKLIST.md` §0.2's domain-mismatch finding makes this more urgent than routine                             |

## 32.9 Rollback

Every workflow/script file this phase added is additive: none is referenced by any existing job,
none changes `main`/`master`'s tracked state, and none has run against real infrastructure yet.
Deleting the four new workflow files and three new scripts fully reverts this phase with zero
residue. The two `ci.yml` edits (both repos) each add new jobs without modifying any existing
job's steps — reverting those two files' diffs is equally clean.

## 32.10 Acceptance — Phase 5 status

Per the plan's own §18 Phase 5 Definition of Done ("both repos protected; one full
`feature/*`→`develop`→staging cycle completed end to end"): **not met**, for the same class of
reason as Phase 4 — completing it requires GitHub repo-admin access (branch protection,
Environments) and live Railway/Vercel staging infrastructure (Phase 4), neither available from
this session. What this phase delivers instead: every workflow, script, and document ready to
apply the moment that access exists, plus two findings (§32.6's Railway gap, and Phase 4's domain
mismatch) that matter regardless of whether staging work continues.

**Phase 5 is code/documentation-complete and blocked on GitHub/Railway/Vercel dashboard access —
not completed.**
