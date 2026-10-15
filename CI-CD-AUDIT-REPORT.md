# CI/CD Audit Report

Date: 2026-10-14. Scope: `learnix-back/.github/workflows/*`, `package.json` / `package-lock.json`, the
test and Docker configuration, and (first pass only, see §10) `learnix-front/.github/workflows/ci.yml`.
Nothing was committed, pushed or deployed, and no cloud / Railway / AWS resource was touched.

> **Nothing here has run on GitHub Actions.** No `gh` CLI or Actions API access was available, so no
> real run logs were read. Every conclusion comes from reproducing the job steps locally in a **clean
> export of the repository with a scrubbed environment** (no gitignored `.env*` files, which is what a
> CI runner sees) against real Postgres 16 / Redis 7 containers. All timings below are **local**
> timings, not GitHub-runner timings. §9 lists what still needs a real run.

## 1. Executive summary

| #   | Finding                                                                                                                                                                         | Severity | Status                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------- |
| 1   | `env-validation`: `Cannot find module 'tsconfig-paths/register'`. Job-level `NODE_ENV=production` made `npm ci` skip devDependencies                                            | High     | Fixed (reproduced before/after)                   |
| 2   | `build-test`: `marketplace.config.spec.ts` loads the **gitignored** `.env.test`; without it `validate()` throws at import and kills the whole jest process                      | High     | Fixed (test)                                      |
| 3   | `build-test`: `assertExecutionGuards(env, …)` read Redis from ambient `process.env`; 2 tests passed only because the dev machine had `REDIS_URL`                                | High     | Fixed (source, production behaviour identical)    |
| 4   | `e2e`: `TYPEORM_SYNCHRONIZE=true` makes every suite re-synchronize and hang forever                                                                                             | High     | Fixed                                             |
| 5   | `e2e`: the job env lacked values the gitignored `.env.test` supplies (`MARKETPLACE_ENABLED`, `REDIS_URL`, two encryption keys, Bunny token key): **179 tests / 29 suites** fail | High     | Fixed                                             |
| 6   | `e2e`: a stale obsolete snapshot file makes `jest --ci` exit 1 even when all 728 tests pass                                                                                     | High     | Fixed (stale `.snap` removed)                     |
| 7   | Prettier: the five files from the last push (`CI-CD-AUDIT-REPORT.md` + 4 `learnix-infra/docs/*.md`) fail the changed-files gate                                                 | Medium   | Fixed                                             |
| 8   | `npm audit`: **96** advisories (4 critical, 44 high, 48 moderate)                                                                                                               | High     | Fixed to 0 high/critical; 22 moderate remain (§7) |
| 9   | `dependency-audit` was `continue-on-error: true`, so the 3+ high advisories never failed anything                                                                               | High     | Fixed (blocking gate)                             |
| 10  | `deploy-aws.yml`: `trivy-action@0.33.1` does not exist; the deploy job fails at action resolution                                                                               | High     | Fixed                                             |
| 11  | `deploy-aws.yml`: production promotion gate calls the Actions API without `actions: read` → 403, the gate could never pass                                                      | High     | Fixed                                             |
| 12  | Staging deploy ran on `push` **in parallel with CI**, with no dependency on its result                                                                                          | High     | Fixed (deploy is now a job of `ci.yml`)           |
| 13  | Duplicate `gitleaks` workflow (`secret-scanning.yml` and `ci.yml` `secret-scan`)                                                                                                | Medium   | Merged (7 → 6 workflows)                          |
| 14  | `format-check` interpolated PR-controlled file names into a shell command (script injection)                                                                                    | Medium   | Fixed                                             |
| 15  | Missing `permissions`, timeouts, credential hygiene; every push+PR ran all jobs twice; runs on `main` could be cancelled                                                        | Medium   | Fixed                                             |
| 16  | Third-party actions on mutable tags                                                                                                                                             | Medium   | Fixed (SHA / digest pins)                         |
| 17  | **ESLint is effectively disabled**: `eslint.config.mjs` is commented out, so CI's lint step checks 9 non-TypeScript files                                                       | High     | **Not fixed, needs a decision (§8.1)**            |
| 18  | Frontend `ci.yml`: 18 lint errors, 1 flaky vitest test                                                                                                                          | High     | Fixed in the first pass (judgement call, §10)     |
| 19  | `e2e`: no retained output, JUnit, service logs or per-shard view when a shard failed                                                                                            | Medium   | Fixed (§2.3b)                                     |

## 2. Root causes

### 2.1 `env-validation` and `tsconfig-paths/register` (finding 1)

The job declared `NODE_ENV: production` at **job level** so the validator would run with production
semantics. That variable is also seen by `npm ci`, which then omits devDependencies. `ts-node` and
`tsconfig-paths` are devDependencies, so the validation step died before it started.

Reproduced in a clean directory:

```
NODE_ENV=production npm ci            # "added 749 packages" (dev omitted)
NODE_ENV=production … npx ts-node -r tsconfig-paths/register scripts/validate-env.ts
Error: Cannot find module 'tsconfig-paths/register'      rc=1
```

(`NODE_ENV=production npm ci --dry-run` on the lockfile removes 637 packages.)

**Fix:** `NODE_ENV: production` is no longer set at job level. `npm ci` runs normally, and
`NODE_ENV=production` is set **on the two validation steps only**, so the validator still runs under
exactly the production semantics (strict env validation and the environment-isolation guard were not
touched and no bypass flag was added). The command is now one npm script, `npm run validate:env`
(also used by the negative controls). After the fix: `Environment validation passed.` and all three
negative controls reject with the expected rule (`STAGING_PRODUCTION_DATABASE_HOST`,
`STAGING_DATABASE_NAME_NOT_MARKED`, `JWT_SECRET must be longer`). The Dockerfile already uses
`npm ci --include=dev` for its build stage, so it was never affected.

### 2.2 `build-test` crash involving `src/config/env.validation.ts` (findings 2 and 3)

`env.validation.ts` is **correct**. The trigger was `src/config/marketplace.config.spec.ts`, which
loaded the gitignored `.env.test` to satisfy `ConfigModule.forRoot({ validate })` at import time. In CI
the file does not exist, `validate()` throws outside any test, and jest dies with an uncaught error.
Fixing that exposed `prelaunch-reset.ts`: `assertExecutionGuards(env, …)` validated the `env` it was
given everywhere except the two Redis checks, which read ambient `process.env`.

- `marketplace.config.spec.ts`: sets/restores three explicit synthetic values (`DATABASE_URL`,
  `JWT_SECRET`, `JWT_REFRESH_SECRET`) in `beforeAll`/`afterAll`.
- `prelaunch-reset.ts`: the Redis checks use the `env` argument. The only production caller passes
  `process.env`, so production behaviour is unchanged. New regression test: it rejects a production
  env without Redis even when ambient `REDIS_URL` is set.

### 2.3 `e2e` (findings 4, 5, 6)

1. **Hang.** With `TYPEORM_SYNCHRONIZE=true` every suite re-synchronizes and loops on
   `operator does not exist: …meeting_status_enum = …_enum_old`. `test/global-setup-e2e.ts` builds the
   schema once and documents that the suites must run with synchronize **off**. CI had `true` → now
   `'false'`.
2. **Missing environment.** `test/setup-e2e.ts` loads the gitignored `.env.test`, which supplies
   `MARKETPLACE_ENABLED=true`, `E2E_DISABLE_BACKGROUND_WORKERS`, `REDIS_URL`, and two AES keys. CI had
   none of them, so with the first fix alone a CI-equivalent run gave **179 failed / 549 passed**
   (marketplace routes returned 404 because the module was not registered; Redis-backed services
   disabled themselves). A fifth gap (`BUNNY_STREAM_TOKEN_KEY`, free-preview signed URLs) surfaced on
   the re-run. All are now declared in the job `env:` with **synthetic, non-secret values** (the keys
   only encrypt fixture rows in the job's disposable Postgres).
3. **Obsolete snapshot.** `test/e2e/__snapshots__/student-progress-report.postgres.e2e-spec.ts.snap`
   belonged to a test that no longer calls `toMatchSnapshot` (it now asserts explicitly, including the
   repository order). Jest counts an obsolete snapshot as a failure, so `jest --ci` exited **1** with
   `91 passed, 91 total`. The stale file was removed; the suite now exits 0.

### 2.3b `e2e` aggregate check (`SHARD_RESULT=failure`) and diagnostics

The aggregate `e2e` job was already correct: it fails unless `needs.e2e-shard.result` is `success`, so
a failed, cancelled or skipped shard can never read as a pass. `SHARD_RESULT=failure` was the
_symptom_ of the three shard failures in §2.3, not a fault of the aggregate. **No GitHub Actions logs
were available**, so the failing test names of the original red run are not known and are not
guessed here; what is proven is that the three causes above reproduce locally and that, once fixed, all
four shards pass.

What was added so the next red run explains itself (jest's own output only, nothing inferred):

| Addition                                                                        | Why                                                                                                                         |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `scripts/e2e-preflight.ts` (`npm run e2e:preflight`)                            | Node major, `SELECT version()`, Redis `PING` before jest; names the broken service, prints versions only                    |
| `npm run test:e2e:ci`                                                           | `--ci --logHeapUsage`, `results.json` (jest JSON) and `junit.xml` (`jest-junit` 17, devDependency)                          |
| Full console log kept with `tee`, `PIPESTATUS[0]` re-raised                     | Output survives a failure and the step still fails with jest's exit code (verified: exit 3 stays 3)                         |
| `scripts/e2e-summary.ts`                                                        | Per-shard table in the run summary (failed suite and test names verbatim); exit 1 on a failed, missing or unreadable result |
| `Collect service logs`, `Upload E2E results` (both `if: always()`)              | Postgres/Redis container logs + the three files above → artifact `e2e-shard-N`, 14 days                                     |
| Aggregate `e2e`: download `e2e-shard-*`, per-shard table, then the verdict step | One page shows every shard; the verdict step is unchanged and still fails unless all passed                                 |

No `|| true` / `continue-on-error` was added: the reporting steps use `if: always()` (and
`--report-only` for the table) while the failing step has already failed the job.
Artifacts contain only `jest-output.log`, `results.json`, `junit.xml`, `containers.txt` and the
service logs of the job's own disposable containers; no repository secret is in scope of that job and
the synthetic values were confirmed absent from the three jest files.

**Not changed, on evidence.** Shard count, `timeout-minutes: 60`, `maxWorkers: 1` and
`workerIdleMemoryLimit: 1536MB` stay: local shard times were 7 to 12 min (§5) and the peak heap was
1121 MB, so there is no evidence for a change. No retries were added. Database isolation is unchanged:
each shard has its own Postgres/Redis service containers, the schema is built once per shard in
`global-setup-e2e.ts`, and `resetDatabase()` truncates between tests. The `--logHeapUsage` figures will
show on the first real run whether a shard approaches the 1.5 GB recycle limit.

### 2.4 Prettier, five files (finding 7)

`format-check` runs `prettier --check` on the files the push changed. The last commit (`ci-cd`)
changed 18 files, and exactly five were unformatted: `CI-CD-AUDIT-REPORT.md`,
`learnix-infra/docs/AWS-COST-ESTIMATE.md`, `INITIAL-AWS-DEPLOYMENT.md`, `VERCEL-AWS-DNS-CUTOVER.md`
and `VERCEL-ENVIRONMENT-MATRIX.md`. They were reformatted with the repo's own `.prettierrc` (Markdown
whitespace/table alignment only). Whole-repo `prettier --check .` still reports ~670 files that
predate the gate; that baseline is deliberately out of scope (see the comment in `ci.yml`), and
nothing auto-commits or auto-pushes.

To stop this recurring, `npm run format:changed` (`scripts/format-changed.ts`) checks (or with
`-- --write` fixes) exactly the files a branch changed (commits since the merge-base, plus
uncommitted and untracked work), with git invoked without a shell.

### 2.5 `npm audit` (findings 8, 9)

See §7 for the full account. Short version: 96 advisories → 0 high/critical, using `npm audit fix`
(no `--force`) plus six reviewed `overrides`, and the audit job is now blocking.

### 2.6 Deploy pipeline (findings 10 to 13)

- Trivy: `…/git/ref/tags/0.33.1` → 404; `v0.33.1` → `b6643a29…`. Pinned to that SHA.
- Gate permissions: once any `permissions:` block exists, unlisted scopes are `none`. Listing workflow
  runs needs `actions: read`; added on the `gates` job only (and on the retired
  `deploy-production.yml` gate, which had no block at all).
- Redundant runs: `deploy-aws.yml` triggered on `push` to `develop` alongside CI, so staging deployed
  whatever the CI result. It is now a **reusable workflow** (`workflow_call`) invoked by the
  `deploy-staging` job in `ci.yml`, which `needs` every required check. The manual
  `workflow_dispatch` path (staging or production) is unchanged. The production gate previously
  looked for a successful `deploy-aws.yml` run with `event=push` for the SHA; since that no longer
  exists, it now looks for a successful `ci.yml` run on `branch=develop`, `event=push` for the same SHA
  (that run only succeeds if the staging rollout job succeeded).

## 3. Files modified, deleted, merged

Backend repo (`learnix-back`), uncommitted:

| File                                                                   | Change                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`                                             | Stage ordering, sharded e2e + aggregate check, env-validation fix, blocking audit, `workflow-lint`, `deploy-staging` job, e2e env (§2.3)                                                                                  |
| `.github/workflows/deploy-aws.yml`                                     | `workflow_call` + dispatch only (no `push`), production gate queries `ci.yml`, header comment                                                                                                                             |
| `.github/workflows/deploy-production.yml`                              | shellcheck SC2046 quoting fix (retired workflow, manual only)                                                                                                                                                             |
| `.github/workflows/secret-scanning.yml`                                | **Deleted (merged into `ci.yml` `secret-scan`)**, §4                                                                                                                                                                      |
| `.github/dependabot.yml`                                               | **New**: weekly npm + github-actions update PRs (they run the full CI)                                                                                                                                                    |
| `package.json`                                                         | 6 `overrides` (§7), jest `transform`/`transformIgnorePatterns` for the ESM-only `sanitize-html` tree, scripts `validate:env`, `format:changed`, `test:e2e:ci`, `e2e:preflight`, `e2e:summary`, devDependency `jest-junit` |
| `package-lock.json`                                                    | Regenerated by `npm audit fix` + overrides (165 version changes, 41 added, 42 removed; no major bump of a direct dependency)                                                                                              |
| `test/jest-e2e.json`                                                   | Same jest ESM transform (the e2e app imports `sanitize-html` too); Prettier-formatted                                                                                                                                     |
| `test/e2e/__snapshots__/student-progress-report…snap`                  | **Deleted** (obsolete)                                                                                                                                                                                                    |
| `scripts/e2e-preflight.ts`, `scripts/e2e-summary.ts`, `.gitignore`     | **New** E2E diagnostics (§2.3b); `/e2e-results` ignored                                                                                                                                                                   |
| `scripts/format-changed.ts`                                            | **New** (§2.4)                                                                                                                                                                                                            |
| `docs/CI-CD-ARCHITECTURE.md`, `docs/BRANCH_PROTECTION_SETUP.md`        | Job table and required-check guidance                                                                                                                                                                                     |
| `CI-CD-AUDIT-REPORT.md`, 4× `learnix-infra/docs/*.md`                  | Prettier formatting (report rewritten)                                                                                                                                                                                    |
| Earlier in this audit (already in commit `429a382`, kept and verified) | `marketplace.config.spec.ts`, `prelaunch-reset.ts` / `.spec.ts`, `rollback-aws.yml`, `branch-sync.yml`, `deploy-staging.yml`, permissions/timeouts/SHA pins, `format-check` injection fix, `TYPEORM_SYNCHRONIZE`          |

Not touched: `src/config/env.validation.ts`, the isolation guard, Terraform / `learnix-infra`
infrastructure, Dockerfile, deployment scripts, application source (apart from `prelaunch-reset.ts`).

## 4. Workflows before and after

| Backend workflows                             | Before                                                                        | After                                                                                               |
| --------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Count                                         | **7**                                                                         | **6**                                                                                               |
| `ci.yml`                                      | primary                                                                       | primary; now also owns the staging deploy trigger                                                   |
| `deploy-aws.yml`                              | own `push` trigger (raced CI)                                                 | reusable + manual dispatch only, **no push trigger**                                                |
| `secret-scanning.yml`                         | duplicate of `ci.yml` `secret-scan` (same pinned action, PR + push to `main`) | **removed**: `secret-scan` covers PRs and pushes to `main`/`develop`                                |
| `rollback-aws.yml`                            | manual                                                                        | kept: manual, shares the deploy concurrency group                                                   |
| `branch-sync.yml`                             | nightly cron + push                                                           | kept: a different purpose (main/develop divergence), needs its own `schedule` trigger               |
| `deploy-staging.yml`, `deploy-production.yml` | retired Railway workflows, `workflow_dispatch` only                           | kept until AWS migration Phase 8 (`phase8-decommission.md`); the production runbook references them |

No `workflow_run` trigger exists. A feature-branch commit now runs CI once (via its pull request)
instead of twice (push + PR); runs on `main`/`develop` are never cancelled.

## 5. Final pipeline structure and timings

Stages in `ci.yml` (jobs in the same stage run in parallel):

1. **Fast gates** (no dependencies): `build-test` (checkout, Node 24 + npm cache, `npm ci`, ESLint,
   typecheck + build, unit tests with coverage), `format-check`, `env-validation` (+ negative controls),
   `secret-scan`, `dependency-audit`, `workflow-lint`, `migration-safety-check` (informational).
2. **Heavy gates**, only after `build-test` passes: `migration-chain`, `e2e-shard` ×4 → `e2e` aggregate.
3. **Deploy**: `deploy-staging`, only for `push` to `develop`, only if every required job succeeded.

Local timings (single developer machine, warm caches; GitHub runners will differ):

| Job / step                                  | Local time                                   | Timeout in `ci.yml` |
| ------------------------------------------- | -------------------------------------------- | ------------------- |
| `npm ci`                                    | ~16 s                                        |                     |
| ESLint (`npx eslint .`, see §8.1)           | ~1 s                                         |                     |
| `tsc --noEmit` + `nest build --builder swc` | 29 s (typecheck alone 7 s)                   | `build-test` 30 min |
| Unit tests, coverage, `--runInBand`         | 195 s (371 suites, 3110 tests)               |                     |
| `format-check`                              | seconds                                      | 10 min              |
| `env-validation` + 3 negative controls      | seconds (4 `ts-node` runs)                   | 10 min              |
| `migration-chain` (150 migrations)          | 29 s                                         | 20 min              |
| E2E, all 91 suites on one worker            | 2263 s (37.7 min) → ~10 min per shard of ~23 | 60 min per shard    |
| E2E per shard, `test:e2e:ci` (§6)           | 579 s / 719 s / 461 s / 419 s                | 60 min per shard    |
| `dependency-audit`, `secret-scan`           | seconds                                      | 10 min              |
| `workflow-lint` (actionlint)                | seconds                                      | 5 min               |
| Docker build of the production image        | 97 s (amd64)                                 | n/a (deploy job)    |

Concurrency: `ci-<workflow>-<PR number or ref>`, `cancel-in-progress` for pull requests and feature
refs, **never** for `main`/`develop`. Deploys use `deploy-api-<environment>` with
`cancel-in-progress: false`, and `rollback-aws.yml` shares that group, so a production rollout can
never be cancelled mid-flight or interleaved with a rollback.

Permissions: workflow-level `contents: read`; `id-token: write` only on the AWS deploy/rollback jobs
(and on the `deploy-staging` caller, since a reusable workflow cannot exceed its caller);
`actions: read` only where the promotion gate lists runs; `persist-credentials: false` on every
checkout that does not push.

## 6. Verification results (local)

| Check                                                                                                     | Result                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `env-validation`, old flow (`NODE_ENV=production npm ci`)                                                 | **Reproduced**: `Cannot find module 'tsconfig-paths/register'`                                                                                                                                                                                                                                                                       |
| `env-validation`, new flow, synthetic staging values, `NODE_ENV=production`                               | `Environment validation passed.`                                                                                                                                                                                                                                                                                                     |
| Negative controls (production DB host, unmarked DB name, short JWT secret)                                | All 3 rejected with the expected rule                                                                                                                                                                                                                                                                                                |
| Prettier on changed files (`npm run format:changed`, 11 files)                                            | Clean (was 5 failing files)                                                                                                                                                                                                                                                                                                          |
| Prettier, whole repo                                                                                      | ~670 pre-existing non-conforming files, **not gated** (unchanged baseline)                                                                                                                                                                                                                                                           |
| ESLint `npx eslint .`                                                                                     | 0 errors, but it only lints 9 non-TS files (§8.1)                                                                                                                                                                                                                                                                                    |
| `tsc --noEmit -p tsconfig.json`; `npm run build`                                                          | 0 errors; build success (1635 files)                                                                                                                                                                                                                                                                                                 |
| Unit tests, clean export, no `.env*`, remediated dependencies (`test:cov --ci --runInBand`)               | **371 suites passed, 1 skipped; 3110 tests passed, 7 skipped, 0 failed**                                                                                                                                                                                                                                                             |
| E2E, CI-equivalent env (no `.env.test`, `SYNCHRONIZE=false`), before the env fix                          | 179 failed / 549 passed (29 suites)                                                                                                                                                                                                                                                                                                  |
| E2E, after the env fix, remediated dependencies, all suites                                               | **91 suites / 728 tests passed**; exit code 1 only because of the obsolete snapshot                                                                                                                                                                                                                                                  |
| E2E suite that owned the obsolete snapshot, after removing it                                             | 3/3 passed, exit code 0 (the full 91-suite run was not repeated end to end after this one-file change)                                                                                                                                                                                                                               |
| `migration-chain` against empty Postgres 16                                                               | 150/150 applied, none pending                                                                                                                                                                                                                                                                                                        |
| `npm audit`                                                                                               | 96 (4 critical, 44 high, 48 moderate) → **22 moderate, 0 high, 0 critical**                                                                                                                                                                                                                                                          |
| `docker build` of the production image, then `require('sanitize-html')` / `uuid` inside it                | Build success; sanitizer strips `onerror` / `javascript:` as expected                                                                                                                                                                                                                                                                |
| `actionlint` (pinned image, shellcheck on) over all 6 workflows                                           | 0 findings (it found a missing `workflow_call` trigger and a SC2046 warning along the way, both fixed)                                                                                                                                                                                                                               |
| `rollback-aws.yml` jq validation, real `jq 1.7.1`                                                         | valid map accepted; `{}`, bad key, bad ARN, array, `; curl` suffix all rejected; `keys \| join(",")` gives `api,worker`                                                                                                                                                                                                              |
| E2E, each shard with the CI command (`test:e2e:ci --shard=i/4`, CI env, disposable Postgres 16 + Redis 7) | **Shard 1: 23 suites, 196/196 (exit 0, 588 s). Shard 2: 23 suites, 229/229 (720 s). Shard 3: 23 suites, 153/153 (462 s). Shard 4: 22 suites, 150/150 (421 s).** Total 91 suites, 728 tests, 0 failed. Peak heap per shard 1121 / 704 / 576 / 848 MB                                                                                  |
| E2E diagnostics: preflight, JUnit, JSON, log, summary                                                     | Preflight passes on healthy services and fails with `ECONNREFUSED` / `Connection is closed` on dead ports (exit 1); `junit.xml` and `results.json` produced; `e2e-summary` aggregates all four shards and exits 1 for a failed, a missing and an unreadable result (negative controls used throw-away JSON, not reported as results) |
| `tee` wrapper keeps the failure                                                                           | A failing command (exit 3) still exits 3 through `tee` + `PIPESTATUS`                                                                                                                                                                                                                                                                |
| Axios and `@grpc/grpc-js`                                                                                 | `axios` 1.20.0 (direct, via `@nestjs/axios`, `twilio`), `@grpc/grpc-js` 1.14.6 (via `@nestjs/terminus`, `google-gax`): neither appears in `npm audit`                                                                                                                                                                                |
| `npm audit` after adding `jest-junit`                                                                     | unchanged: 22 moderate, 0 high, 0 critical                                                                                                                                                                                                                                                                                           |
| `sharding`: `jest --listTests --shard=i/4`                                                                | 23 / 23 / 23 / 22 suites (91)                                                                                                                                                                                                                                                                                                        |

## 7. Vulnerabilities

### 7.1 Fixed (96 → 22)

- **Critical (4), all transitive and fixed by lockfile updates within existing ranges:** `handlebars`
  (4.7.9 → 4.7.10), `piscina` (4.9.3 → 4.9.4), `proxy-addr` (2.0.7 → 2.0.8), `@xhmikosr/decompress`
  (10.2.1 → 10.2.2; dev tooling under `@swc/cli`).
- **High, direct dependencies:** `@nestjs/platform-express` (11.1.28 → 11.2.7) and `multer`
  (2.2.0 → 2.4.0), `axios` (1.18.1 → 1.20.0), `compression` (1.8.1 → 1.8.2), `sharp` (0.35.3 → 0.35.5),
  `@nestjs/swagger` via `js-yaml`, `jest` (30.2.0 → 30.5.2, whole `@jest/*` family),
  `ts-loader` (via `micromatch`/`braces`, which no longer appear in the tree).
- **High, transitive:** `@fastify/busboy`, `@grpc/grpc-js`, `brace-expansion`, `browserslist`,
  `fast-uri`, `http-cache-semantics`, `nanoid`, `postcss`, `source-map-js`, `minimatch`.
- **Moderate:** `sanitize-html` 2.17.1 → 2.18.0 (three XSS-bypass advisories, notably
  `GHSA-g8qq-57p8-ggw5` and `GHSA-vccv-cmxp-4j9h`; the fix needs ≥ 2.17.7), `qs`, `@humanfs/node`, and
  the `uuid` / `file-type` / `js-yaml` / `sprintf-js` families (below).

All of these are semver-compatible bumps; no `npm audit fix --force`, no major upgrade of a direct
dependency. `--force` was reviewed and rejected: it proposes downgrading `jest`/`ts-jest` to 25/27
and `exceljs` to 3.4.0, which would break the project.

### 7.2 Overrides added (each verified and tested)

| Override                                        | Why                                                                                                            |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `readdir-glob › brace-expansion` 2.1.2 → 2.1.7  | The existing pin was itself inside the vulnerable range (`>=2.0.0 <2.1.7`)                                     |
| `uuid` → 11.1.1                                 | `exceljs`, `google-gax`, `gaxios`, `teeny-request`, `hyperid` pulled `uuid` 8/9; they only use `v4()`          |
| `file-type` → 21.3.4                            | `@xhmikosr/*` (dev tooling under `@swc/cli`) pulled `file-type` 20.5.0 (ASF loop, ZIP decompression bomb)      |
| `@nestjs/swagger › js-yaml` → 5.4.3             | `@nestjs/swagger` pins `js-yaml` 5.3.0 exactly, which is vulnerable                                            |
| `@istanbuljs/load-nyc-config › js-yaml` → 4.3.2 | Drops `js-yaml` 3 → `argparse` 1 → `sprintf-js`, which has **no patched release** (dev-only, coverage tooling) |

### 7.3 A regression the audit fix caused, and its fix

`sanitize-html` ≥ 2.17.7 depends on `htmlparser2` 12 (ESM-only). Native `require()` works on the
project's Node 24 (checked, including inside the built Docker image), but **jest** cannot load ESM
without `--experimental-vm-modules`: 11 unit suites and the bootstrap/e2e suites failed. The fix is
local: a second ts-jest transform (`allowJs`, `module: commonjs`) applied **only** to
`node_modules/sanitize-html/node_modules/**`, in both `package.json` (unit) and `test/jest-e2e.json`
(e2e). Result: 371/371 unit suites and 91/91 e2e suites pass.

### 7.4 Remaining (22 moderate, 0 high, 0 critical)

All in one production chain, `@sentry/node` 8.55.2 → `@opentelemetry/*` 1.x:

| Advisory                                                                                 | Severity (CVSS) | Path                                                                        |
| ---------------------------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------- |
| `GHSA-8988-4f7v-96qf` OpenTelemetry Core: unbounded memory in W3C Baggage                | moderate (5.3)  | `@sentry/node` → `@opentelemetry/core` <2.8.0 and the packages that wrap it |
| `GHSA-qqmp-wf37-98f9` `instrumentation-*` expose DB username as `db.user` span attribute | moderate (5.8)  | `@sentry/node` → `@opentelemetry/instrumentation-{pg,mysql,…}`              |

**Why not fixed:** the only fix is `@sentry/node` 11 (three majors). I upgraded it in a copy: v11 no
longer accepts `sendDefaultPii` (replaced by `dataCollection`), and `src/observability/sentry.ts`
relies on `sendDefaultPii: false`, `skipOpenTelemetrySetup` and a scrubbing `beforeSend` for its
privacy and ADOT-coexistence guarantees. Changing PII-handling semantics blind, to clear two
moderate advisories, is not a safe CI fix, so `@sentry/node` stays at 8.x.
**Plan:** migrate `initSentry()` to Sentry 11 with a test proving no request bodies, headers or
usernames are emitted, in its own change. **Mitigation today:** on AWS the ADOT agent owns tracing and
Sentry runs with `skipOpenTelemetrySetup: true` / `tracesSampleRate: 0`, so the OTel code paths are not
active there.

`dependency-audit` runs `npm audit --audit-level=high`, blocking: any new high or critical advisory
fails the run. Moderates are listed in the job output but do not fail it.

## 8. Findings that need a decision

### 8.1 ESLint is disabled (finding 17) — not changed

`eslint.config.mjs` has had its entire strict ruleset commented out since 2026-07-09 and exports only
an `ignores` list. `npx eslint .` therefore lints just 9 stray `.js/.mjs/.cjs` files and always
passes: **the CI "Lint" step does not check any TypeScript**. I did not re-enable it, because that is
a project decision and the numbers are large:

- the commented-out strict type-checked ruleset, if restored, reports **10,807 errors** in `src`
  (1,972 `no-restricted-syntax`, 1,311 `curly`, 864 `consistent-type-assertions`, …); many are
  auto-fixable;
- even a minimal `eslint:recommended` + `typescript-eslint/recommended` baseline reports **135
  errors** (48 `no-unused-vars`, 37 `no-undef`, 28 `no-explicit-any`, 19 `no-require-imports`).

Recommendation: restore a small baseline first (fix the 135), then re-enable rules in phases with
`--fix` for the mechanical ones. Typechecking (`tsc`) is real and still gates every PR.

### 8.2 `migration-safety-check` stays `continue-on-error`

Unchanged and documented in-file: making it blocking needs the DB-owner second-approval path first,
otherwise a legitimate destructive migration could never merge. The production `gates` job still
classifies migrations and requires `production-db-approval` for destructive ones.

## 9. Needs GitHub Actions or external access

1. **Nothing was run on GitHub Actions.** Push a branch and confirm every job is green. In
   particular: `workflow-lint` (pulls the actionlint image), the sharded `e2e` and its aggregate
   check, the `env-validation` negative controls, and `dependency-audit` against the live advisory DB
   (the count can have changed by then).
2. **`deploy-staging` (reusable-workflow call) is unverified on GitHub.** `actionlint` validates the
   call, inputs and permissions statically, but the first push to `develop` is the real test, ideally
   with `staging` environment protections watched. The production gate's new query (`ci.yml`,
   `branch=develop`, `event=push`) must be proven by a real staging→production dispatch.
3. **Branch protection** must require the job names in `docs/BRANCH_PROTECTION_SETUP.md`: add
   `dependency-audit` and `workflow-lint`; require `e2e` (the aggregate), **not** the four
   `E2E shard n/4` jobs. Because `push` no longer runs on feature branches, required checks come from
   the `pull_request` run.
4. **`ubuntu-24.04-arm` runner** for the deploy job depends on the plan; the image was only built for
   amd64 locally.
5. **Environments and variables** (`staging`, `production`, `production-db-approval`, the `vars.*`
   in `deploy-aws.yml`) can only be verified in GitHub settings.
6. **Dependabot** must be enabled for the repository for `.github/dependabot.yml` to take effect.
7. **E2E artifacts and summaries** (`upload-artifact` / `download-artifact` of `e2e-shard-N`, the
   `$GITHUB_STEP_SUMMARY` tables, `docker logs` of the service containers on the hosted runner) were
   exercised only as far as their scripts go locally; the first real run confirms them, including
   what the aggregate job does when a shard uploaded nothing (it reports "no result files" and still
   fails on `needs.e2e-shard.result`).
8. **Hosted-runner timing**: the shard count (4) and timeouts (60 min per shard) are estimates from
   local timings; the first real run should confirm them.

## 10. Frontend (`learnix-front`, separate repo, first pass only)

This request targeted the backend; the frontend was handled earlier in this audit and is unchanged
now: `ci.yml` hardening (permissions, concurrency, timeouts, credentials, pins), `test/setup.ts`
raising RTL `asyncUtilTimeout` to 5 s for a load-sensitive test, and **a judgement call to review**:
three React-Compiler lint rules (`react-hooks/set-state-in-effect`, `refs`, `immutability`) were
downgraded from `error` to `warn` in `eslint.config.mjs` (18 sites, listed in the file's comment).
Results then: `eslint` 0 errors, `tsc` clean, 779 vitest tests passing, `next build` success.

## 11. Residual risks

- **Not deployed, not run on GitHub** (§9); production was not touched.
- **Flaky e2e under load:** `omr.e2e-spec.ts` once failed with `ECONNRESET` while the machine was
  busy, then passed twice; watch it on the first hosted runs before adding any retry.
- `src/metadata.ts` is a tracked file regenerated by every `nest build`; the committed copy is stale
  (every local build dirties the tree).
- Whole-repo Prettier baseline (~670 files) and the disabled ESLint ruleset (§8.1) are accepted debt.
- `learnix-back` and `learnix-front` are separate git repos and the parent folder is not a repo:
  review/commit each separately.
- After pulling these changes run `npm ci` (the lockfile changed substantially).
- Temporary artifacts of this audit were created outside the repo (clean exports, containers, logs on
  `D:\`) and are cleaned up as the last step.
