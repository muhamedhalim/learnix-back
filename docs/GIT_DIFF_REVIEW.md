# Git Diff Review — Phase 0

> **Superseded 2026-10-15:** Bunny Stream and Bunny Storage are retired. Lesson video is S3, MediaConvert and CloudFront signed cookies, and no Bunny variable is read any more. See `docs/AWS-PRODUCTION-AUDIT.md` section 8. Mentions of Bunny below describe the old system and are kept as history.

> Closes the Phase 0 audit note requesting `git diff --stat` with a reason for every file, and proof that any regenerated file (Swagger `metadata.ts`) changed only because of regeneration, never an API change.

## 1. `git diff --stat` — backend

```
 .env.example                                       | 184 ++++++++++++++++++++-
 .github/workflows/ci.yml                           |  45 +++++
 package.json                                       |   5 +-
 src/app.service.ts                                 |   5 +-
 src/auth/auth.controller.ts                        |   5 +-
 src/common/constants.ts                            |  10 +-
 src/common/utils/cors.util.spec.ts                 |  11 ++
 src/common/utils/cors.util.ts                      |   7 +-
 src/config/env.validation.ts                       | 108 +++++++++++-
 src/health/health-error.service.ts                 |   7 +-
 src/health/health-orchestrator.service.ts          |   5 +-
 .../indicators/external-providers.indicator.ts     |  49 +++++-
 src/lessons/lessons.service.ts                     |   9 +
 src/metadata.ts                                    |   2 +-
 .../processors/parent-notification.processor.ts    |  16 ++
 src/observability/sentry.ts                        |   9 +-
 src/payments/providers/paymob/paymob.gateway.ts    |  12 +-
 src/payments/services/gateway-webhook.service.ts   |  10 ++
 .../services/payment-operations.service.ts         |  19 +++
 src/queues/queues.constants.ts                     |   9 +
 src/uploads/cleanup.service.ts                     |  10 ++
 21 files changed, 516 insertions(+), 21 deletions(-)
```

Plus 15 new files (below).

## 2. `git diff --stat` — frontend

```
 .gitignore                | 2 ++
 instrumentation-client.ts | 5 ++++-
 instrumentation.ts        | 9 ++++++++-
 3 files changed, 14 insertions(+), 2 deletions(-)
```

Plus 1 new file (`.env.example`).

---

## 3. Reason for every modified file

| File                                                            | Δ       | Reason                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.env.example`                                                  | +184    | Documents `APP_ENV`, the isolation guard's 9 input variables, the 5 feature flags, the login-throttle overrides, and ~25 previously-undocumented variables (finding A-07). No behaviour change — this file is never read by running code.                                                                                                                                                   |
| `.github/workflows/ci.yml`                                      | +45     | New `migration-chain` job: runs `npm run test:migrations` against a fresh `postgres:16` service container on every push/PR. Closes the audit requirement that a PR must fail if the migration chain fails to create the database, fails any migration, or leaves migrations pending.                                                                                                        |
| `package.json`                                                  | +5/-1   | Adds `test:migrations`, `verify:seed-interconnection`, `fingerprint:secrets`, `seed:staging` scripts. Removes `seed` (finding A-19 — pointed at `dist/database/seed.js`, which does not exist).                                                                                                                                                                                             |
| `src/app.service.ts`                                            | +4/-1   | `GET /` banner's `environment` field: `NODE_ENV` → `APP_ENV` label (finding #5 in `docs/NODE_ENV_AUDIT.md`). No route, request shape, or response schema changed — only the _value_ of one already-existing string field, and only when `APP_ENV` differs from `NODE_ENV` (i.e. only on staging; production output is byte-identical since `APP_ENV` is unset there).                       |
| `src/auth/auth.controller.ts`                                   | +2/-1   | Swaps `THROTTLE.LOGIN_TESTSPRITE_TEMPORARY` (150/min) for `LOGIN_THROTTLE` (resolves to `THROTTLE.AUTH`, 5/5min, on production). Fixes the code's own "restore before next production deploy" comment.                                                                                                                                                                                      |
| `src/common/constants.ts`                                       | +6/-4   | Removes the `LOGIN_TESTSPRITE_TEMPORARY` tier, replaced with a comment pointing at the new resolver. No other tier changed.                                                                                                                                                                                                                                                                 |
| `src/common/utils/cors.util.spec.ts`                            | +11     | New regression test proving the non-production CORS fallback never contains the production origin (finding A-17).                                                                                                                                                                                                                                                                           |
| `src/common/utils/cors.util.ts`                                 | +5/-2   | Removes `https://learnix.school` from the non-production fallback origin list (finding A-17). Production is unaffected: production always requires `CORS_ORIGINS` and throws if it's missing (`cors.util.ts:19`), so this fallback is never reached there.                                                                                                                                  |
| `src/config/env.validation.ts`                                  | +101/-7 | Declares `APP_ENV` + 9 isolation-guard input variables (all `@IsOptional()`); resolves `APP_ENV` first via `resolveAppEnv`; invokes `assertEnvironmentIsolation` at the end of `validate()`; makes the "Paymob must be live in production" rule identity-aware so staging can legitimately use `test` mode without weakening the production rule.                                           |
| `src/health/health-error.service.ts`                            | +5/-2   | Error-group fingerprint/label `environment` field: `NODE_ENV` → `APP_ENV` (finding #15).                                                                                                                                                                                                                                                                                                    |
| `src/health/health-orchestrator.service.ts`                     | +3/-2   | Admin health-dashboard `environment` field: `NODE_ENV` → `APP_ENV` (finding #16).                                                                                                                                                                                                                                                                                                           |
| `src/health/indicators/external-providers.indicator.ts`         | +43/-6  | Three fixes: (1) extracts `shouldWarnOnEnvironmentMismatch()` as a pure, independently-tested function; (2) the frontend-URL mismatch warning now keys on `APP_ENV`, fixing a confirmed bug where it fired on every staging health check (finding #18); (3) same fix for the Paymob-endpoint check (finding #20); (4) Sentry health-metadata `environment` field → `APP_ENV` (finding #21). |
| `src/lessons/lessons.service.ts`                                | +9      | `ENABLE_FILE_CLEANUP` flag guards the 30-minute expired-upload-session cleanup cron (destructive — deletes Bunny Stream videos). Default-on; production unaffected.                                                                                                                                                                                                                         |
| `src/metadata.ts`                                               | +1/-1   | **Regenerated by `nest build`, not hand-edited.** See §4 below — proven to reflect a pre-existing, untouched source comment.                                                                                                                                                                                                                                                                |
| `src/notifications/processors/parent-notification.processor.ts` | +16     | `ENABLE_NOTIFICATIONS` flag guards the single `process()` entry point (covers both deliver and redeliver). Default-on; production unaffected.                                                                                                                                                                                                                                               |
| `src/observability/sentry.ts`                                   | +7/-2   | Sentry `environment` tag: `NODE_ENV` → `APP_ENV` (finding #31 — the highest-value fix in the audit; previously every staging error would have been tagged `production`).                                                                                                                                                                                                                    |
| `src/payments/providers/paymob/paymob.gateway.ts`               | +11/-1  | The live-mode fallback (used only when `PAYMOB_EXPECTED_MODE` is unset) now checks `APP_ENV === production` instead of `NODE_ENV === production` (finding #32). Defence-in-depth only — the isolation guard already requires this variable to be set explicitly on both production and staging before this constructor ever runs.                                                           |
| `src/payments/services/gateway-webhook.service.ts`              | +10     | `ENABLE_WEBHOOK_REPLAY` flag guards the per-minute stale-webhook recovery cron (financial). Default-on; production unaffected.                                                                                                                                                                                                                                                              |
| `src/payments/services/payment-operations.service.ts`           | +19     | `ENABLE_PAYMENT_RECONCILIATION` flag guards both the per-minute maintenance sweep and the 30-minute gateway-attempt reconciliation (financial). Default-on; production unaffected.                                                                                                                                                                                                          |
| `src/queues/queues.constants.ts`                                | +9      | `ENABLE_BACKGROUND_JOBS` master switch added to `areQueuesEnabled()`, ahead of the existing test-only override. Default-on; production unaffected.                                                                                                                                                                                                                                          |
| `src/uploads/cleanup.service.ts`                                | +10     | `ENABLE_FILE_CLEANUP` flag guards the weekly orphan-file-deletion cron (destructive). Default-on; production unaffected.                                                                                                                                                                                                                                                                    |

## 4. New files and their purpose

| File                                                         | Purpose                                                                                                                                        |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `STAGING_ENVIRONMENT_IMPLEMENTATION_PLAN.md`                 | The approved plan + Phase 0 execution record                                                                                                   |
| `docs/ENVIRONMENT_INVENTORY.md`                              | Full subsystem audit, 21 findings                                                                                                              |
| `docs/SECRET_ROTATION_CHECKLIST.md`                          | Per-secret rotation procedure (dashboard steps only, no code)                                                                                  |
| `docs/SECRETS_REPORT.md`                                     | Per-secret table: name, location, service, rotation need, fingerprint                                                                          |
| `docs/CRON_AUDIT.md`                                         | All 11 cron jobs: function, cadence, impact, flag decision                                                                                     |
| `docs/NODE_ENV_AUDIT.md`                                     | Every `NODE_ENV` reference in both repos, classified BEHAVIOUR vs IDENTITY                                                                     |
| `docs/GIT_DIFF_REVIEW.md`                                    | This file                                                                                                                                      |
| `scripts/migration-chain-test.ts`                            | Empty-database migration-chain harness (also wired into CI)                                                                                    |
| `scripts/verify-seed-interconnection.ts`                     | Proves the synthetic seed's foreign-key graph resolves end to end                                                                              |
| `scripts/fingerprint-secrets.ts`                             | Computes SHA-256 fingerprints for `docs/SECRETS_REPORT.md`, never prints a value                                                               |
| `src/config/app-env.ts`                                      | `APP_ENV` resolution, derived from `NODE_ENV` when absent                                                                                      |
| `src/config/app-env.spec.ts`                                 | Direct unit coverage for `resolveAppEnv`/`resolveAppEnvLabel`                                                                                  |
| `src/config/environment-isolation.guard.ts`                  | The fail-fast cross-environment guard                                                                                                          |
| `src/config/environment-isolation.guard.spec.ts`             | 60 tests across all 4 rule classes                                                                                                             |
| `src/config/feature-flags.ts`                                | The 5 default-on scheduled-work flags                                                                                                          |
| `src/config/feature-flags.spec.ts`                           | 26 tests, including the "near-miss value leaves it enabled" property                                                                           |
| `src/common/throttle/login-throttle.ts`                      | Login rate-limit resolution by deployment identity                                                                                             |
| `src/common/throttle/login-throttle.spec.ts`                 | 20 tests, including the regression guard for the 150/min defect                                                                                |
| `src/database/seed-staging.ts`                               | The synthetic staging seed                                                                                                                     |
| `src/database/seed-staging.spec.ts`                          | 19 guard tests                                                                                                                                 |
| `src/bootstrap-isolation.integration.spec.ts`                | 6 tests proving `NestFactory.create()` — including the literal production `AppModule` — never returns an application on an isolation violation |
| `src/health/indicators/external-providers.indicator.spec.ts` | Regression test reproducing and fixing the staging health-check false-positive                                                                 |
| `dodline/.env.example`                                       | Frontend variable template (none existed before)                                                                                               |

---

## 5. Proof that `src/metadata.ts` changed only by regeneration

**Claim to verify:** the sole line changed in `src/metadata.ts` — an added `"delete": { summary: "Soft delete a book" }` entry in the generated Swagger model metadata — reflects pre-existing source code, not an API change introduced this session.

**Evidence:**

1. **The diff.**

   ```
   git diff --word-diff=porcelain src/metadata.ts
   + "delete": { summary: "Soft delete a book" },
   ```

   One addition, nothing removed, nothing else touched.

2. **Where the text comes from.** `@nestjs/swagger`'s build-time plugin derives `summary` values from a controller method's leading JSDoc comment. The exact string `"Soft delete a book"` is the JSDoc comment on the real, already-existing controller method:

   ```
   src/books/controllers/admin-books.controller.ts:121:   * Soft delete a book
   ```

3. **That controller was never touched this session.**

   ```
   git status --porcelain -- src/books/
   ```

   returns **no output** — zero modifications anywhere under `src/books/`, this session or otherwise pending.

4. **`metadata.ts` is a build artifact, not hand-maintained.** It is regenerated every time `nest build` runs (`nixpacks.toml:8`, `package.json`'s `build` script). `npm run build` was run repeatedly during this session (§25.6 of the plan) to verify the backend compiles after each code change — one of those runs regenerated this file from current source, and it picked up a JSDoc comment its previous committed version was simply stale on.

**Conclusion:** the change is the Swagger plugin catching up to a pre-existing comment on a file this session never edited. It is not, and could not be, an API behaviour change originating from this work.
