# Learnix API audit report

Date: 2026-10-19/20 · Backend: `learnix-back` (`main`, working tree with other sessions' uncommitted work) · Frontend: `learnix-front` (`master`)

**Status: PARTIAL.** Every defect found was fixed in source and proven by a test that fails before and passes after. The headline
production fix is **not deployed**: it needs a Terraform apply that has not been run or authorised, so
`https://api.learnix.school/api/v1/marketplace/admin/overview` still answers `Cannot GET` today. 409 of 705 routes have no
statically detectable HTTP test of a _valid_ request (they rely on unit tests plus the new authorization sweep), and external-provider
paths were not exercised. Details in §9 and §11.

---

## 1. Executive summary

|                                 |                                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Routes discovered               | **705** unique METHOD+path (with `MARKETPLACE_ENABLED=true`); 705 are on the live Express router, 0 live-but-undeclared, 0 duplicate/conflicting |
| Confirmed defects               | **6** (1 deployment/config, 3 backend runtime 5xx, 1 frontend contract, 1 frontend dead-code)                                                    |
| Fixed in source                 | 6 of 6                                                                                                                                           |
| Deployed to production          | **0** — awaiting your authorisation of the Terraform apply                                                                                       |
| Backend unit                    | 382 suites, 3259 passed, 0 failed, 7 skipped (pre-existing)                                                                                      |
| Backend e2e (full, isolated DB) | 98 suites, **765/765 passed**                                                                                                                    |
| Frontend                        | 166 files, **794/794 passed** (see flake note, §8)                                                                                               |
| Terraform offline tests         | production 10/10, staging 6/6                                                                                                                    |

The route the task opened with, `GET /api/v1/marketplace/admin/overview`, was **not a missing handler**. The controller, service and
module are correct and registered. The deployed API was started without `MARKETPLACE_ENABLED=true`, so `MarketplaceModule` is not in the
module graph at all (§5).

---

## 2. Baseline (before any change)

- Authoritative workspace: `D:\programing\lms-f+b\learnix-back` (branch `main`, `f94737d`). Other worktrees exist (`learnix-back-release` on
  `infra/ecs-task-def-skip-destroy`, two prunable worktrees `-hotfix`/`-main`, and a scratch `release` worktree); none were modified, merged or reset.
- The working tree already held another session's uncommitted work (admin-notifications inbox: `src/notifications/*`,
  `src/health/*alert*`/listener files, `src/metadata.ts`, migration `2208000000000`, matching specs; frontend notification tests). It was preserved.
- Stack: NestJS 11 / Express 5, global prefix `api/v1` (only `GET /metrics` excluded), no URI versioning, JWT cookie + Bearer auth
  (`JwtAuthGuard`/`HybridAuthGuard`) with `RolesGuard` and `FinancePermissionsGuard`, TypeORM/Postgres, BullMQ/Redis. Frontend: Next.js, axios hooks, `endpoints.ts` registry.
- Baseline test results were obtained on the unchanged tree first: unit 381 suites / 3258 passed / 7 skipped; e2e `marketplace-disabled` and
  `marketplace-admin-authz` green apart from the contention issue in §8.

---

## 3. Route inventory

Full table: **[API-ROUTE-INVENTORY.md](./API-ROUTE-INVENTORY.md)** (method, path, controller.handler, guards, roles, whether an e2e call is statically detectable).
It is generated from the running app by `test/e2e/route-inventory.e2e-spec.ts` (`ROUTE_INVENTORY_OUT=<file>`), which also asserts that every
controller route declared through Nest metadata exists on the live Express router and vice-versa, and that no two handlers share a normalised METHOD+path.

Guard distribution: 54 routes carry no guard (public catalogue, health, auth entry points, signed payment/WhatsApp webhooks, OAuth callback,
public media); 645 declare an authenticating guard; 551 enforce a role list through `RolesGuard`. Roles in use: `admin`, `teacher`, `student`, `call_center`.
Request/response schemas are not duplicated here; they are in Swagger (`/api`, non-production or `ENABLE_SWAGGER=true`).

The 54 public routes were reviewed individually. `GET /students` and `GET /students/:id` expose a sanitized projection only (no email/phone/status,
`publicSearch` restricts search); `GET /uploads/:folder/:filename` is limited to `thumbnails|profiles|resources` with traversal checks; payment and
WhatsApp webhooks are public by design and verify signatures in their handlers (not re-tested here, see §11).

---

## 4. Confirmed defects

### D1 — Marketplace routes absent in the deployed API (the reported `Cannot GET /api/v1/marketplace/admin/overview`)

- **Failure**: live `GET https://api.learnix.school/api/v1/marketplace/admin/overview` → `404 Cannot GET`. The same host returns 404 for the _public_ `GET /marketplace/courses`
  and `/marketplace/categories` while `/api/v1/health` returns 200 — i.e. the whole module, not one handler (see §6).
- **Root cause (proven)**: `AppModule` imports `MarketplaceModule` only when `isMarketplaceEnabled()` (`process.env.MARKETPLACE_ENABLED === 'true'`, default **off**).
  `.env.test` and the CI workflow set it; neither `learnix-infra/environments/production/apps.tf` nor `staging/apps.tf` did, and `extra_environment` was `{}`.
  The same cause was mis-recorded earlier as "wrong route guesses" in `learnix-infra/docs/INITIAL-AWS-DEPLOYMENT.md`.
- **Repair**: first-class Terraform variable `marketplace_enabled` (default `true`) wired to `MARKETPLACE_ENABLED` in both stacks; a boot log line states whether the module is enabled; the
  required-environment assertion in both `plan.tftest.hcl` files now includes the key; the misleading deployment note was corrected.
- **Regression tests**: `terraform test` (key must be present in the task environment); `test/e2e/marketplace-disabled.e2e-spec.ts` (flag off ⇒ 404, flag on ⇒ reachable);
  `route-inventory.e2e-spec.ts` (route must be live); `marketplace-admin-overview.e2e-spec.ts` (§5).
- **Verification**: terraform tests pass; flag-on e2e passes. **Production not changed** (needs apply — §11).

### D2 — `GET /uploads/teacher/files`, `/uploads/admin/files`, `/uploads/files/:id/usage` and the in-use check of `DELETE /uploads/files/:id` returned 500

- **Original failure**: `QueryFailedError: column lesson.video_url does not exist` (reproduced verbatim by the new e2e against the original code).
- **Root cause**: migration `2206000000000-RetireBunnyVideo` dropped `lessons.video_url`; the shared `FILE_USAGE_SELECT` SQL in `src/uploads/file-management.service.ts` still read it. Unit tests mock the repository, so none could see it.
- **Repair**: removed the stale `video_url` branch (lesson videos are `video_asset_id`, not uploaded files).
- **Regression test**: `test/e2e/uploads-file-usage.postgres.e2e-spec.ts` (list + usage against real Postgres; usage reference to a user is returned; non-owner gets 404; anonymous gets 401).
- **Result**: fails on original, 2/2 pass on the fix.

### D3 — `PATCH /health/alerts/:id`: every partial update was a 500; unknown id 500; malformed id 500

- **Root cause**: `Object.assign(rule, dto)` copied the validated DTO's omitted fields (own keys holding `undefined`) over the entity, so `rule.channels.filter` threw for any update that did not resend all fields; `findOneByOrFail` surfaced `EntityNotFoundError` as 500; `:id` had no `ParseUUIDPipe`.
- **Repair**: apply only defined fields, explicit `NotFoundException` (bilingual), `ParseUUIDPipe`.
- **Regression test**: `test/e2e/health-alert-rule-update.postgres.e2e-spec.ts` (401/403, 404 unknown, 400 malformed, partial update persists and leaves other columns untouched). Fails on original (2 failures), 3/3 pass on the fix.

### D4 — `POST /marketplace/applications` with an empty body returned 500

- **Root cause**: in `createDraft`, `...fields` was spread _after_ the defaults, so the DTO's `undefined` keys overwrote `display_name ?? ''` and `years_of_experience ?? 0`, violating NOT NULL.
- **Repair**: spread first so explicit values win.
- **Regression tests**: unit (DTO-shaped input with explicit `undefined`) and e2e in `marketplace-applications.e2e-spec.ts` (201, persisted `display_name=''`, `years_of_experience=0`). The e2e fails on the original with the NOT NULL error.

### D5 — Admin books "Restore" button always failed (frontend/backend method mismatch)

- **Failure**: `useRestoreBook` sent `PATCH /admin/books/:id/restore`; the backend defines `POST` (`AdminBooksController.restore`), so the click returned 404 `Cannot PATCH`.
- **Repair**: hook now uses `post`.
- **Regression test**: `hooks/api/useAdminContent.test.tsx` (MSW handler registered for POST only). Fails on the old `patch`, passes on the fix.

### D6 — Dead frontend hook calling a non-existent route

`useAdminSubject` requested `GET /admin/subjects/:id`, which the backend does not define (only PUT/DELETE exist). No component used it; removed.

---

## 5. Marketplace admin overview — root-cause analysis and evidence

Request path traced end to end: `app/[locale]/admin/marketplace/page.tsx` → `useAdminOverview()` (`hooks/api/useAdminMarketplace.ts`, `endpoints.marketplace.adminOverview = "/marketplace/admin/overview"`) →
axios base `…/api/v1` → Express router → `JwtAuthGuard` → `RolesGuard('admin')` → `AdminOverviewController.getOverview` → `MarketplaceOverviewService.getOverview()` → five TypeORM count/min queries → JSON.

| Candidate cause                                           | Finding                                                                                                                                           |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing controller/handler                                | No — `AdminOverviewController` exists, `@Controller('marketplace/admin/overview')`, `@Get()`                                                      |
| Wrong method/path                                         | No — frontend and backend agree (`GET`, same path)                                                                                                |
| Controller omitted from module / module not imported      | No — in `MarketplaceAdminModule.controllers`; module imported by `MarketplaceModule`                                                              |
| Global prefix / versioning                                | No — `api/v1`, no versioning; all other routes resolve                                                                                            |
| Route precedence                                          | No — `route-inventory` finds no shape conflicts                                                                                                   |
| Guards/middleware                                         | No — guards return 401/403, they cannot produce `Cannot GET`                                                                                      |
| Frontend wrong URL/instance                               | No — URL correct; response shape matches field-for-field (`applications/courses/reportedReviews/refunds/payouts` × `{count, oldestWaitingSince}`) |
| **Feature flag removes the module in the deployed build** | **Yes** — the only differentiator between passing tests and the live 404                                                                          |

Evidence: (a) live probes of public and admin marketplace routes all 404 while `/health` is 200; (b) `marketplace-disabled.e2e-spec.ts` reproduces exactly that set of 404s with the flag off and a reachable route with it on; (c) the infra repository contains no `MARKETPLACE_ENABLED` for either environment; (d) after the fix `route-inventory` reports `GET /api/v1/marketplace/admin/overview` live.

Business-outcome verification (`test/e2e/marketplace-admin-overview.e2e-spec.ts`, HTTP against the full app + Postgres): anonymous → 401; student and teacher → 403; empty platform → five queues `{count:0, oldestWaitingSince:null}` with `Cache-Control: no-store`;
a real application drafted (count stays 0), submitted (count 1, `oldestWaitingSince` ≈ now, other four queues untouched) and rejected through the admin API (count back to 0). A mutation that empties the open-application statuses turns the test red (expected 1, received 0).

The page itself surfaces failures through `DataState` (no fallback data).

---

## 6. Live production observation (read-only, unauthenticated, 2026-10-19 21:01 UTC)

| Request                                       | Result                                    |
| --------------------------------------------- | ----------------------------------------- |
| `GET /api/v1/marketplace/admin/overview`      | 404 `Cannot GET`                          |
| `GET /api/v1/marketplace/courses` (public)    | 404 `Cannot GET`                          |
| `GET /api/v1/marketplace/categories` (public) | 404 `Cannot GET`                          |
| `GET /api/v1/health`                          | 200                                       |
| `GET /api/v1/auth/me`                         | 404 (not a route; profile is `/users/me`) |

No authenticated requests were made against production and no credentials were used.

---

## 7. Frontend ↔ backend contract

- `endpoints.ts`: **566** entries resolved against the live inventory → 563 matched; the 3 unmatched are generic `…/${id}/${action}` builders whose every actual action value (`review|approve|reject|cancel|request-information`, `process-gateway|complete`, `approve|pay|reject|cancel`) is a real POST route.
- Static extraction of **448** distinct (HTTP method, endpoint) pairs from hook call sites → 440 matched. Of the 8 mismatches: 3 are the builders above, 3 are extraction artefacts (verified by reading the hooks: `DELETE /teacher/books` is `byId(id)`, `PATCH /admin/finance/refunds` is `${manualMethods}/${id}`, `DELETE …/curriculum` does not exist), and 2 were real (D5, D6).
- Not covered: dynamic URLs assembled outside `endpoints.ts`, response-shape parsing for every page, pagination/filter parameter names per screen, and per-component loading/empty/error states (only the overview page and the changed hook were inspected).

---

## 8. Test commands and actual results

Isolation note: a shared `lms_e2e` Postgres on port 55432 was being used concurrently by other sessions' jest runs (their `TRUNCATE`s deleted my users mid-test, producing intermittent `user_sessions` FK 500s in `marketplace-disabled`; 2 of 3 runs failed, then 9/9 passed on a private database). All e2e results below used a private disposable Postgres 16 (port 55433) and Redis 7 (56380). I turned on `log_statement` on the shared DB to diagnose this and reverted it.

| Command                                          | Result                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| `jest` (backend unit, `--silent`) before changes | 381 suites passed, 3258 passed, 7 skipped                                    |
| `jest` (backend unit) after changes              | 382 suites, **3259 passed, 0 failed**, 7 skipped                             |
| `jest --config ./test/jest-e2e.json` (full)      | **98 suites, 765 tests passed, 0 failed** (includes 5 new suites)            |
| `route-authorization-sweep.e2e-spec.ts`          | 4/4; first run found D2–D4 (3 failures in mode C); green after fixes         |
| `tsc --noEmit -p tsconfig.build.json`            | exit 0                                                                       |
| `eslint` on every changed/added backend file     | no findings                                                                  |
| `terraform test` production / staging            | 10/10, 6/6; `terraform fmt -check` clean                                     |
| `vitest run` (frontend)                          | 794/794 with `--poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3` |
| `tsc --noEmit` (frontend)                        | exit 0                                                                       |

Frontend flake: with default parallelism, two consecutive full runs each failed **one different** test (`admin/call-center/page.test.tsx`, then `Components/UI/ImageDropzone.test.tsx`); both pass alone (2×6/6 and 3×7/7) and the whole suite passes with limited forks. Classified as a load-sensitive timing flake on this workstation, not a regression.

Baseline vs new: no baseline failure existed in the unit/e2e/frontend suites other than the contention and load flakes above; there are no new regressions.

---

## 9. Coverage statistics (from the inventory, not a sample)

| Measure                                                                      | Count                                                                                                        |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Unique METHOD+path discovered                                                | **705**                                                                                                      |
| Registered on the live router (declared = live)                              | **705**                                                                                                      |
| Anonymous probe → 401 verified (routes with an authenticating guard)         | **645** (all passed)                                                                                         |
| Wrong-role probe → 403 verified (routes with a role list)                    | **551** (all passed)                                                                                         |
| In-role request with empty body + unknown id, no 5xx (route × role requests) | **738** (3 defects found, all fixed; all passed after)                                                       |
| Routes with a statically detectable valid-request e2e call                   | **296** (lower bound)                                                                                        |
| Routes with a verified business outcome in this audit                        | **3 groups**: marketplace overview, upload usage listing, health-alert update (+ application draft creation) |
| Routes with no detectable valid-request test                                 | **409** — covered by unit tests and the sweep only (list: `docs/audits` inventory, column "E2E ref = no")    |
| Confirmed defects fixed / remaining                                          | **6 / 0** in source (production deployment of D1 pending)                                                    |

"Verified" for the sweep means the guard/role/5xx behaviour was observed over HTTP; it does **not** mean the business function of the 409 routes was verified.

---

## 10. Security and authorization findings

- Authentication is enforced on every route that declares an authenticating guard (645/645 anonymous probes → 401).
- Role enforcement held on all 551 role-listed routes (wrong role → 403). No guard was weakened, removed or bypassed to obtain any result.
- Object-level checks verified for `GET/DELETE /uploads/files/:id…` (uploader or admin only; others get 404, no existence leak).
- No handler returned 5xx for malformed input after the fixes; D2–D4 were availability/correctness defects, not data exposures.
- Not tested: payment and WhatsApp webhook signature verification, rate-limit thresholds, tenant isolation beyond existing suites, CSRF (the e2e app factory omits `CsrfGuard`, as designed; `csrf.e2e-spec` covers it separately).
- Finance routes were exercised only with an admin holding all finance permissions in the sweep; per-permission matrices rely on the existing `marketplace-admin-authz` and finance specs (green).

---

## 11. Blocked / unverified, remaining risks, recommended follow-up

1. **Deploy D1 (requires your approval).** `terraform apply` for the production and staging stacks will roll the api/worker/migrate task definitions with `MARKETPLACE_ENABLED=true`. Before applying: confirm the marketplace migrations are in the production schema (the launch log shows 152 migrations ran), and note that enabling the module also registers its queues/crons in the worker and exposes its payment/payout routes — confirm the marketplace is launch-ready. The new default is `true`; set `marketplace_enabled = false` in tfvars to keep it off. After deploy, an authenticated admin request to `/marketplace/admin/overview` is the verification step; I did not have, and did not use, production credentials.
2. **Payments/webhooks/providers** (EasyKash, SES/SMS, Meeting providers, S3/MediaConvert): not exercised against real or sandbox providers; existing doubles only.
3. **409 routes** lack a statically detectable valid-request HTTP test, concentrated in `teacher/lessons` (31), `teacher/exams` (16), `admin/finance` (14), `marketplace/admin` (13), `teacher/certificates` (13), `teacher/packages` (12), `marketplace/instructor` (11). Recommended next wave: workflow e2e per group, then a mode-D sweep that uses real seeded ids so handlers get past the 404 before malformed-body validation.
4. The shared `lms_e2e` database (port 55432) is not safe for concurrent sessions; consider per-session ports via env or a lock.
5. Untracked `private-uploads/health-checks/*`, `private-uploads/marketplace/`, `private-uploads/omr-sheets/` are artefacts of local e2e runs (mine and another session's); they should be git-ignored or cleaned.
6. Frontend suite has load-sensitive timing tests (`call-center`, `ImageDropzone`); consider raising their timeouts or capping forks in CI.

---

## 12. Files changed and purpose

Backend (`learnix-back`)

- `learnix-infra/environments/{production,staging}/{apps.tf,variables.tf,tests/plan.tftest.hcl}` — D1: `marketplace_enabled` variable, env var, test assertion.
- `learnix-infra/docs/INITIAL-AWS-DEPLOYMENT.md` — corrected the mis-diagnosed 404 note.
- `src/main.ts` — boot log of marketplace enabled/disabled state.
- `src/uploads/file-management.service.ts` — D2.
- `src/health/health-alert.service.ts`, `src/health/health.controller.ts` — D3 (other session's unrelated `audience: 'technical'` hunk in the service was left as is).
- `src/marketplace/instructors/instructor-application.service.ts` (+ `.spec.ts`) — D4.
- `test/e2e/route-inventory.e2e-spec.ts`, `route-authorization-sweep.e2e-spec.ts`, `marketplace-admin-overview.e2e-spec.ts`, `uploads-file-usage.postgres.e2e-spec.ts`, `health-alert-rule-update.postgres.e2e-spec.ts` (new); `marketplace-applications.e2e-spec.ts` (+1 case).
- `docs/audits/API-AUDIT-REPORT.md`, `docs/audits/API-ROUTE-INVENTORY.md` — this report and the inventory.

Frontend (`learnix-front`)

- `app/[locale]/hooks/api/useAdminContent.ts` (+ new `useAdminContent.test.tsx`) — D5.
- `app/[locale]/hooks/api/useAdminSubjects.ts` — D6.

Nothing was committed, pushed, deployed or applied.
