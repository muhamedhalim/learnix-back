# NODE_ENV Full Usage Audit — Learnix

> Closes the Phase 0 audit note: *"Perform a full project search. Show all instances of NODE_ENV being used. For each instance: is NODE_ENV correct, or should APP_ENV be used? Do not leave any environment-specific logic that relies on NODE_ENV if the intention is to differentiate between Production and Staging."*

**Method.** Every non-test reference to `NODE_ENV` in both repositories was located and classified into exactly one of two categories:

- **BEHAVIOUR (NODE_ENV is correct)** — the code is deciding whether a *security or robustness protection* is active (Redis required, CSP on, stack traces hidden, cookies Secure, etc.). Staging must have every one of these exactly as production does — staging runs `NODE_ENV=production` for this reason — so `NODE_ENV` is the right signal and nothing changes.
- **IDENTITY (should be APP_ENV)** — the code is *labelling* which deployment this is (a log field, a Sentry tag, a health-payload field, a same-vs-different-environment comparison for a warning). Because staging deliberately sets `NODE_ENV=production`, every one of these was either mislabelling staging as production, or — in one confirmed case — actively producing a false alarm on staging.

Test-only reads (`*.spec.ts` fixtures, `test/.env.test`) are excluded: manipulating `process.env['NODE_ENV']` inside a test to exercise a behaviour switch is exactly what those switches are for.

---

## 1. Backend — classified

| # | File:line | What it gates | Verdict | Action |
|---|---|---|---|---|
| 1 | `app.module.ts:115` | Cache module refuses in-memory fallback | **BEHAVIOUR** | none |
| 2 | `app.module.ts:204` | Throttler storage requires Redis | **BEHAVIOUR** | none |
| 3 | `app.module.ts:257` | Refuses `TYPEORM_SYNCHRONIZE=true` | **BEHAVIOUR** — must stay absolute on every deployed environment | none |
| 4 | `app.module.ts:360` | Disables `ThrottlerGuard` under Jest | **BEHAVIOUR**, scoped to `test` only | none |
| 5 | `app.service.ts:33` | `GET /` banner `environment` field | **IDENTITY** | **FIXED** → `APP_ENV` |
| 6 | `auth.service.ts:614` | Withholds password-reset token from the HTTP response | **BEHAVIOUR** — staging must not leak this either | none |
| 7 | `analytics/distributed-single-flight.service.ts:55` | Redis reconnect strategy (retry forever vs. fail fast) | **BEHAVIOUR** — "is this a real deployed environment with a reliable Redis" is true for staging too | none |
| 8 | `config/public-url.util.ts:99,108` | Production-only public-HTTPS-origin validation | **BEHAVIOUR** | none |
| 9 | `common/utils/cors.util.ts:19` | `CORS_ORIGINS` required | **BEHAVIOUR** | none |
| 10 | `common/utils/cors.util.ts:22` | **Non-production fallback origin list contains `https://learnix.school`** | **IDENTITY-adjacent** — this is dead code on any correctly-configured deployment (production always sets `CORS_ORIGINS`), but a `staging`/`development` boot that forgets to set it would silently trust the production frontend. Finding A-17. | **FIXED** → fallback no longer names the production origin |
| 11 | `common/filters/http-exception.filter.ts:82,167` | Hides stack traces / internals from error responses | **BEHAVIOUR** — staging must not leak these either | none |
| 12 | `common/utils/cookie-security.util.ts:21` | `Secure`/`SameSite=None`/`Partitioned` cookie flags | **BEHAVIOUR** | none |
| 13 | `idempotency/idempotency.service.ts:94` | Redis reconnect strategy | **BEHAVIOUR** (same reasoning as #7) | none |
| 14 | `health/health-collector-coordinator.service.ts:96,157` | Redis retry strategy + coordination-unavailable fallback | **BEHAVIOUR** | none |
| 15 | `health/health-error.service.ts:43` | `environment` field folded into the error-group fingerprint hash, and stored per error | **IDENTITY** — a staging error and a production error with an identical message must NOT collapse into the same error group, and the stored label must say which is which | **FIXED** → `APP_ENV` |
| 16 | `health/health-orchestrator.service.ts:175` | `environment` field in the admin health dashboard payload | **IDENTITY** | **FIXED** → `APP_ENV` |
| 17 | `health/indicators/storage.indicator.ts:70` | Object storage required | **BEHAVIOUR** | none |
| 18 | `health/indicators/external-providers.indicator.ts:91-98` | Warns when the configured `FRONTEND_URL` doesn't look like a production URL | **IDENTITY — confirmed live bug for staging.** `environmentForUrl()` classifies any host containing `staging` as `'sandbox'`. Staging's real `FRONTEND_URL` (`https://staging.learnix.school`) would trip this on **every single health check**, producing a permanent false-positive warning: *"Production is configured with a localhost, sandbox, staging, or test frontend URL."* | **FIXED** → gated on `APP_ENV === production` |
| 19 | `health/indicators/external-providers.indicator.ts:107-108` | Cookie-secret-or-fallback health check | **BEHAVIOUR** — staging must also have an explicit `COOKIE_SECRET` | none |
| 20 | `health/indicators/external-providers.indicator.ts:263-269` | Same production-vs-lower-environment warning, for the Paymob endpoint | **IDENTITY** — same class of bug as #18. Not currently observed to false-positive (Paymob's URL is a fixed allowlisted host with no "staging" substring), but the check is wrong in principle and would misfire the moment a different provider's sandbox subdomain contains an environment word. | **FIXED** → gated on `APP_ENV === production` |
| 21 | `health/indicators/external-providers.indicator.ts:507` | Sentry health-check metadata `environment` field | **IDENTITY** | **FIXED** → `APP_ENV` |
| 22 | `health/indicators/redis.indicator.ts:32` | Redis required | **BEHAVIOUR** | none |
| 23 | `health/indicators/queue.indicator.ts:97,107` | BullMQ required | **BEHAVIOUR** | none |
| 24 | `queues/queues.module.ts:59` | BullMQ requires Redis | **BEHAVIOUR** | none |
| 25 | `queues/queues.constants.ts:151` | E2E-only worker suppression, explicitly scoped to `NODE_ENV=test` | **BEHAVIOUR**, test-only | none |
| 26 | `storage/storage.service.ts:392,415,429,445` | Object-storage production guards | **BEHAVIOUR** | none |
| 27 | `media/media.service.ts:127,169` | Public-media-URL production validation | **BEHAVIOUR** | none |
| 28 | `main.ts:73` | Default log verbosity | **BEHAVIOUR** — staging wants the same quiet default | none |
| 29 | `main.ts:79` | Runs pending migrations before the module tree builds | **BEHAVIOUR** — staging wants the same deploy-lifecycle safety net | none |
| 30 | `main.ts:102` (`isProd`) | Drives CSP, and (together with `ENABLE_SWAGGER`) Swagger visibility | **BEHAVIOUR** — staging wants CSP on; Swagger is already overridden independently via `ENABLE_SWAGGER`, not by weakening this flag | none |
| 31 | `observability/sentry.ts:31` | **Sentry SDK `environment` tag for every captured error and trace** | **IDENTITY — the most consequential instance in the audit.** Every staging error would be tagged `production` in Sentry, exactly the failure mode the plan's Finding A-20 predicted: staging noise buries real production alerts, or worse, a staging-only error gets triaged as a production incident. | **FIXED** → `APP_ENV` |
| 32 | `payments/providers/paymob/paymob.gateway.ts:63` | Defaults live-mode on when `PAYMOB_EXPECTED_MODE` is unset | **IDENTITY, defence-in-depth.** The isolation guard already refuses to boot a staging deployment with `PAYMOB_API_KEY` set and `PAYMOB_EXPECTED_MODE` unset (`STAGING_PAYMENT_MODE_NOT_TEST`), so this fallback is unreachable in a correctly-configured staging deployment. It was still keyed on the wrong signal: if the guard were ever bypassed, a staging box with `NODE_ENV=production` and no explicit mode would default to **live**. | **FIXED** → defaults live only when `APP_ENV` resolves to production |

**Result: 32 instances found. 7 required a code change (all now IDENTITY-classified); 25 were already correct BEHAVIOUR uses of `NODE_ENV` and are unchanged.**

---

## 2. Frontend — classified

| # | File:line | What it gates | Verdict | Action |
|---|---|---|---|---|
| 1 | `instrumentation.ts:13` | Server/edge Sentry `environment` tag | **IDENTITY — confirmed live bug.** Next.js sets `NODE_ENV=production` for **every** `next build` output, regardless of which Vercel environment (Preview, or a dedicated staging project) serves it. There is no `NODE_ENV=staging` in Next.js at all. Every staging error would be tagged `production` in Sentry — frontend mirror of backend finding #31. | **FIXED** → `NEXT_PUBLIC_APP_ENV` (server component; falls back to `NODE_ENV`) |
| 2 | `instrumentation-client.ts:17` | Browser Sentry `environment` tag | Same as above, browser side | **FIXED** → `NEXT_PUBLIC_APP_ENV` |
| 3 | `app/[locale]/hooks/axios.config.ts:36` | `Secure` flag on the non-sensitive `user`/`auth_method` cookie | **BEHAVIOUR** — coincidentally correct today: any deployed build (`next build`, including staging) has `NODE_ENV=production`, and every deployed build is served over HTTPS, so `secure:true` is the right value on both staging and production. Left as-is; noted here so a future reader doesn't mistake it for another instance of the Sentry bug. | none |
| 4 | `Components/monitoring/WebVitals.tsx:20` | Console-only debug logging | **BEHAVIOUR** — this is genuinely "local `next dev`" vs. "any deployed build," which is exactly what `NODE_ENV` distinguishes | none |

**Result: 4 instances found. 2 required a code change; 2 were already correct.**

---

## 3. Summary

| | Backend | Frontend | Total |
|---|---|---|---|
| Instances found | 32 | 4 | 36 |
| Correct as `NODE_ENV` (behaviour) | 25 | 2 | 27 |
| Changed to `APP_ENV` (identity) | 7 | 2 | 9 |

**No instance was left ambiguous.** Every `NODE_ENV` reference in both repositories now has an explicit, written justification for why it is (or is not) the correct signal, and every place that was actually differentiating "which environment is this" — as opposed to "should this protection be on" — now reads `APP_ENV`.

The Sentry tag fix (backend #31, frontend #1–2) is the highest-value result of this pass: without it, standing up staging would have made every staging exception look like a production incident from day one. The `external-providers.indicator.ts` fix (#18) is the second: it removes a health-check false-positive that would have fired on literally every health check staging ever ran.
