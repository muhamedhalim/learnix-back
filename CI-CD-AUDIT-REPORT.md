# CI/CD Audit Report

Date: 2026-10-14. Scope: `learnix-back/.github/workflows/*` (7 workflows) and, because the
checkout is two independent git repos, `learnix-front/.github/workflows/ci.yml`.
Nothing was committed, pushed, deployed or changed in any cloud/Railway/AWS resource.

> **Nothing here has run on GitHub Actions.** The repository is private and no `gh` CLI or API
> access was available, so no real run logs were read. Every conclusion is from reproducing the
> job steps locally in a **clean export of `HEAD` with a scrubbed environment** (no gitignored
> `.env*` files), which is what a CI runner sees. See §6 for what still needs a real run.

## 1. Executive summary

| #   | Finding                                                                                                                                                          | Severity | Status                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------- |
| 1   | `build-test`: `marketplace.config.spec.ts` loads the **gitignored** `.env.test`; without it `validate()` throws at import and kills the whole jest process        | High     | Fixed (test)                       |
| 2   | `build-test`: `assertExecutionGuards(env, …)` reads Redis from ambient `process.env` instead of the `env` argument; 2 tests only passed because the dev machine had `REDIS_URL` | High     | Fixed (source, behaviour-identical in prod) |
| 3   | `e2e`: CI sets `TYPEORM_SYNCHRONIZE=true`, which makes every suite re-synchronize and hang forever (documented in `test/global-setup-e2e.ts`)                    | High     | Fixed                              |
| 4   | `deploy-aws.yml`: `aquasecurity/trivy-action@0.33.1` — that tag does not exist (`v0.33.1` does); the deploy job fails at action resolution                        | High     | Fixed                              |
| 5   | `deploy-aws.yml`: production promotion gate calls the Actions API under `permissions: contents: read` (no `actions: read`) → 403, gate can never pass           | High     | Fixed                              |
| 6   | Frontend `ci.yml`: `npm run lint` fails with 18 errors (workflow comment claims 2); 1 vitest test flaky under load                                               | High     | Fixed (judgement call, §3.7)       |
| 7   | `format-check` interpolated PR-controlled file names into a shell command (script injection)                                                                     | Medium   | Fixed                              |
| 8   | No `permissions:` block, timeouts, or credential hygiene on most workflows; every push+PR ran all jobs twice; older runs on `main` could be cancelled           | Medium   | Fixed                              |
| 9   | Third-party actions referenced by mutable tags                                                                                                                   | Medium   | Fixed (pinned to SHAs)             |
| 10  | Redundant duplicate typecheck in `build-test`                                                                                                                    | Low      | Fixed                              |

## 2. Root-cause analysis

### 2.1 `build-test` failure involving `src/config/env.validation.ts` (findings 1 & 2)

Reproduced exactly by exporting `HEAD` to a clean directory and running `jest --ci --runInBand`:

```
D:\cic\src\config\env.validation.ts:1016  throw new Error(`Environment validation failed: …
  - DATABASE_URL: DATABASE_URL should not be empty
  - JWT_SECRET: … should not be empty
  - JWT_REFRESH_SECRET: … should not be empty
```

- `env.validation.ts` is **correct**. The `env-validation` CI job (the actual staging-shaped
  validation) passes with CI's exact values.
- The trigger is `src/config/marketplace.config.spec.ts` › _AppModule marketplace registration_.
  `require('../app.module')` runs `ConfigModule.forRoot({ validate })` at decoration time, so the
  full env contract must hold. The spec satisfied it by calling `dotenv.config()` on `.env.test`,
  which is in `.gitignore`. Locally the file exists, in CI it does not, and the throw happens
  outside any test so jest dies with an uncaught error (no per-test report).
- Fixing that exposed a second masked failure in `prelaunch-reset.spec.ts` (2 tests):
  `assertExecutionGuards(env, …)` validates the `env` it is passed everywhere **except** the two
  Redis checks, which read ambient `process.env` via `processEnvReader()`. Tests passed locally
  only because the developer's environment had `REDIS_URL`.

**Fixes**

- `marketplace.config.spec.ts`: sets/restores three explicit, synthetic, non-secret values
  (`DATABASE_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`) in `beforeAll`/`afterAll`. No validation
  rule was relaxed and no bypass flag (`SKIP_ENV_VALIDATION` etc.) was introduced.
- `prelaunch-reset.ts`: Redis checks now use `recordReader(env)`. The only production caller
  (`prelaunch-reset.ts:736`) passes `process.env`, so production behaviour is byte-for-byte
  unchanged; the function is now pure and testable. A regression test proves it rejects a
  production env lacking Redis even when ambient `process.env.REDIS_URL` is set.

### 2.2 `e2e` hang (finding 3)

Reproduced against `postgres:16` + `redis:7`: with `TYPEORM_SYNCHRONIZE=true` the app boot
re-synchronizes and loops on
`operator does not exist: scheduled_lesson_sessions_meeting_status_enum = …_enum_old`
("Unable to connect to the database. Retrying…") forever. `test/global-setup-e2e.ts` documents
this and says the suites must run with synchronize **off** (the global setup builds the schema once;
the working local `.env.test` has `false`). CI had `true`, so the job could only end at the runner
default timeout (6 h). Changed to `'false'` with an explanatory comment.

### 2.3 Deploy pipeline (findings 4 & 5)

- Trivy tag: `GET /repos/aquasecurity/trivy-action/git/ref/tags/0.33.1` → 404; `v0.33.1` →
  `b6643a29…`. Pinned to that SHA.
- Gate permissions: once any `permissions:` block exists, unlisted scopes are `none`.
  `gh api repos/…/actions/workflows/deploy-aws.yml/runs` needs `actions: read`, so the
  "production needs a green staging deploy of this SHA" step could never succeed. Added
  `actions: read` to the `gates` job only (job-scoped, not workflow-wide). Same correction made in
  the retired `deploy-production.yml` `check-staging-smoke` job, which had no permissions block at
  all.

These two were found by static analysis + public API lookup. They have **not** been exercised by
a real run (see §6).

## 3. Changes made

### 3.1 `ci.yml` (backend)

- `permissions: contents: read` workflow-wide; `gitleaks` job additionally gets `pull-requests: read`.
- `push` limited to `main`/`develop` (feature branches are covered by their PR; before, every PR
  commit ran all 8 jobs twice). Concurrency group keyed on PR number; `cancel-in-progress` only for
  non-`main`/`develop` refs so every commit on a long-lived branch keeps its own verdict.
- `timeout-minutes` on every job; `persist-credentials: false` on every checkout.
- `build-test`: removed the standalone `tsc --noEmit` step — `npm run build` already starts with
  the identical `tsc --noEmit -p tsconfig.build.json` (≈1 min saved). The check is still run, in the
  renamed step "Typecheck & build". Coverage artifact gets `retention-days: 7`.
- `e2e`: `TYPEORM_SYNCHRONIZE: 'false'` (see 2.2).
- `format-check`: file names are no longer interpolated into the script. List is NUL-delimited on
  disk and passed with `xargs -0`; tested locally with a file named `x; touch PWNED.ts`.
- `env-validation`: **kept strict**, plus a new step with three negative controls (production DB
  host, unmarked staging DB name, short JWT secret). It fails if validation still passes or fails
  for a different rule — so the job can no longer be vacuously green. Verified locally.
- `gitleaks-action` pinned to a SHA.

### 3.2 `deploy-aws.yml`

Trivy tag fix; `actions: read` on `gates`; `timeout-minutes`; `persist-credentials: false`; all
third-party actions pinned to SHAs; repository `vars.*` moved from shell-source interpolation
(`--network '${{ vars.TASK_NETWORK }}'` etc.) into `env:` + quoted variables; explicit
`DB_INSTANCE_ID` presence check before the production snapshot. Triggers, concurrency, gates,
Trivy `HIGH,CRITICAL` fail policy, immutable SHA tag, OIDC role assumption and rollback logic are
unchanged.

### 3.3 `rollback-aws.yml`

Same concurrency group as the deploy (a rollback can no longer interleave with a deploy of the same
environment), `timeout-minutes`, pinned AWS action, `persist-credentials: false`, and the input
validation now also validates the **keys** (they become the `--services` argument), rejects `{}`.
The new `jq` expression is not executed locally (`jq` not installed) — see §6.

### 3.4 `branch-sync.yml`, `secret-scanning.yml`, retired `deploy-staging.yml` / `deploy-production.yml`

Least-privilege `permissions`, timeouts/concurrency where missing, pinned gitleaks. Retired
workflows remain `workflow_dispatch`-only and otherwise untouched.

### 3.5 Source/test changes

`src/database/prelaunch-reset.ts`, `src/database/prelaunch-reset.spec.ts`,
`src/config/marketplace.config.spec.ts`. These three files were also run through Prettier because
the `format-check` gate (which checks changed files) would otherwise reject the change;
`prelaunch-reset.ts` was already non-conforming at `HEAD`. `docs/CI_CD_SETUP.md`: one sentence
updated for the new triggers.

### 3.6 Docker

`Dockerfile`/`.dockerignore` reviewed; no change needed. Built locally with
`docker build --pull=false` (linux/amd64): success. CI builds linux/arm64 — see §6.

### 3.7 Frontend (`learnix-front`, separate repo)

- `ci.yml`: same hardening as 3.1 (permissions, triggers, concurrency, timeouts, credentials,
  gitleaks pin, artifact retention).
- `eslint.config.mjs`: **judgement call — please review.** `npm run lint` had 18 errors, all from
  three React-Compiler diagnostics (`react-hooks/set-state-in-effect` ×13, `react-hooks/refs` ×4,
  `react-hooks/immutability` ×1). Fixing them means rewriting effects/refs in 13 components that
  have no UI tests, which risks behaviour. Those three rules are now `warn` (still reported;
  every other rule, including `rules-of-hooks` and `exhaustive-deps`, remains an error). Sites to
  refactor before restoring `error`:
  `courses/[id]/page.tsx:424`, `search/page.tsx:71`, `shop/lessons/[id]/page.tsx:46`,
  `CertificateRenderer.tsx:176`, `InstructorApplicationForm.tsx:101`,
  `CallCenterEmployeeDetailsDialog.tsx:62`, `admin/gamification/page.tsx:51`,
  `useAwsVideoUpload.ts:137,138,155,156`, `instructor/profile/page.tsx:85`,
  `student/lessons/[id]/page.tsx:69`, `student/redeem/page.tsx:62`,
  `teacher/integrations/page.tsx:58`, `LessonInspector.tsx:176,285,289`.
  If you would rather keep CI red until these are fixed, revert that one hunk.
- `test/setup.ts`: RTL `asyncUtilTimeout` 1 s → 5 s. `admin/books/page.test.tsx` failed once under
  load and passed alone; the assertion still fails if the UI never settles.

## 4. Verification actually performed (local)

| Check                                                                                | Result                                                                    |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Backend `env-validation` job values → `scripts/validate-env.ts`                      | Pass                                                                      |
| New negative controls (3 cases)                                                      | All reject with the expected rule                                         |
| Backend `eslint .`, `tsc -p tsconfig.build.json`, `npm run build` (dev machine)      | Clean                                                                     |
| Backend unit tests on **clean `HEAD` export, no `.env*`** — before fix               | **Crash** (uncaught `Environment validation failed`)                      |
| Same, after fix #1 only                                                              | 2 failed (`prelaunch-reset`)                                              |
| Same, after both fixes (`jest --ci --runInBand --coverage`)                          | **371 suites passed, 1 skipped; 3110 tests passed, 7 skipped, 0 failed**  |
| Backend `migration-chain` job vs Postgres 16                                         | 150/150 applied, none pending                                             |
| Backend `e2e` job vs Postgres 16 + Redis 7, no `.env.test`, `SYNCHRONIZE=true`       | **Hangs** (reproduced)                                                    |
| Backend `e2e` job, `SYNCHRONIZE=false`                                               | E2E_RESULT_PLACEHOLDER                                                    |
| `docker build` of the production Dockerfile                                          | Success                                                                   |
| Prettier on changed `.ts` files; `tsc` after changes                                 | Clean                                                                     |
| All 8 workflow files parse (`js-yaml`)                                               | OK                                                                        |
| Frontend `eslint .` / `tsc --noEmit` / `vitest run --coverage` / `next build`        | 0 errors (49 warnings) / clean / 163 files, 779 tests pass / success      |

## 5. Security review notes

- Secrets: no secret values are echoed anywhere; validation errors name variables, not values.
  Real staging/production secrets are used only by the retired Railway workflows (inside the
  `staging` environment) and OIDC role assumption in `deploy-aws.yml`. No production secrets are
  used in tests; the new test values are synthetic.
- Least privilege: workflow-level `contents: read`; `id-token: write` only on the two AWS jobs;
  `actions: read` only on the two promotion-gate jobs; `persist-credentials: false` everywhere a
  later `git push` is not needed (not on `branch-sync.yml`, which runs `git fetch`).
- Supply chain: third-party actions pinned to SHAs (`gitleaks-action`, `aws-actions/*`,
  `docker/*`, `trivy-action`); first-party `actions/*` stay on major tags.
- Injection: repository `vars` no longer expanded into shell source in the deploy workflows;
  PR-controlled file names no longer reach a shell.
- Not changed on purpose: production/staging environment validation, isolation guard, migration
  safety gating, Trivy fail policy, deploy gating logic, concurrency of deploys
  (`cancel-in-progress: false`).

## 6. Residual risks and steps needing GitHub / external access

1. **Nothing was run on GitHub Actions.** Push the branch and confirm each CI job is green; in
   particular the three-case negative-control step, the `format-check` step on a PR, and the
   `e2e` job (the hang fix was proven against local Docker, not a hosted runner).
2. **Staging deploy is not gated on CI.** `deploy-aws.yml` runs on `push` to `develop` concurrently
   with CI, with no dependency on its result. Recommended: trigger via `workflow_run` on CI success,
   or poll the CI check for the SHA in `gates`. Not done — it changes the deployment trigger and
   cannot be validated without GitHub.
3. **`ubuntu-24.04-arm` runner** is required by the deploy job; availability depends on the plan
   (private-repo arm runners are not generally free). The image was only built for amd64 locally.
4. **`rollback-aws.yml` `jq` filter** was reviewed but not executed (no `jq` locally).
5. **Branch protection** (`docs/BRANCH_PROTECTION_SETUP.md`) requires the jobs by name; no job names
   were changed, but the required-check list must still include the same eight names. Because `push`
   no longer runs on feature branches, required checks come from the `pull_request` run only.
6. **Required reviewers / environments** (`staging`, `production`, `production-db-approval`) and the
   `vars.*` listed in `deploy-aws.yml` can only be verified in GitHub settings.
7. **Duplicate gitleaks**: `ci.yml` `secret-scan` and `secret-scanning.yml` both scan PRs. Kept
   (removing a scanner is a security-control change); consider consolidating.
8. **Non-blocking jobs remain `continue-on-error`**: `dependency-audit`, `migration-safety-check`
   (documented in-file; baseline of high-severity advisories unchanged).
9. **No Dependabot config**: SHA-pinned actions will not update themselves. Add
   `.github/dependabot.yml` (`github-actions` ecosystem) in both repos.
10. **`src/metadata.ts`** is a tracked file regenerated by every `nest build`; the committed copy is
    stale (it lacks `teacher-dashboard.dto`), so every local build dirties the tree. I reverted my
    build's rewrite; consider regenerating-and-committing or gitignoring it.
11. **Retired Railway workflows** (`deploy-staging.yml`, `deploy-production.yml`) still exist
    until Phase 8; only least-privilege permissions were added.
12. **Frontend lint warnings** (§3.7) remain debt until the 18 sites are refactored.
13. Repo layout: `D:\programing\lms-f+b` is **not** a git repo; `learnix-back` and `learnix-front`
    are separate repos, so the changes must be reviewed/committed in each.
14. Pre-existing, unrelated uncommitted changes in `learnix-back` (`learnix-infra/bootstrap/main.tf`,
    `scripts/docker-entrypoint.sh`, new `learnix-infra/docs/*`) were left untouched.
