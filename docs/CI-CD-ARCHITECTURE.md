# CI/CD Architecture — Backend, Infrastructure and Frontend

> Authoritative description of every pipeline. Two workflows own AWS: `ci-cd.yml` (application) and
> `terraform.yml` (infrastructure). The frontend deploys through Vercel. Audit and remediation status:
> `AWS-PRODUCTION-AUDIT.md` and `AWS-PRODUCTION-IMPLEMENTATION-PLAN.md`.

Phase 5 of `STAGING_ENVIRONMENT_IMPLEMENTATION_PLAN.md`. Describes every workflow file that exists
after this phase, what each job does, and — honestly, not optimistically — what each job cannot
yet guarantee because it has never run against real GitHub Actions infrastructure or real
secrets from this session (no `gh` CLI, no GitHub Actions API access; every workflow here was
validated by local YAML parsing and, where possible, by running the underlying script locally
with the same inputs the workflow passes it — never by an actual triggered run).

## 1. Backend — `.github/workflows/ci-cd.yml` (the ONLY workflow)

> **Consolidated.** Every backend pipeline lives in one file, `ci-cd.yml`. `ci.yml`, `deploy-aws.yml`,
> `rollback-aws.yml`, `branch-sync.yml`, `deploy-production.yml` and `deploy-staging.yml` no longer exist (the
> last two were retired Railway workflows). Do not add another workflow that triggers on `push`,
> `pull_request` or `workflow_run`, or that deploys: extend `ci-cd.yml` instead.

### 1.0 Why one push used to start several runs, and the rule now

A push to `main`/`develop` started two workflow runs (`CI` and `Branch sync check`), and the AWS staging
deploy was a third, reusable workflow whose own triggers had to be kept in step with CI. Earlier revisions also
ran CI on both `push` and `pull_request` for the same commit, and deployed from separate `push` workflows
racing CI. All of that is now one run per event, with the deploy a _job_ of that run:

| Event                                    | What runs (all in one `CI/CD` run)                                                                                                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pull_request`                           | every validation job + `ci-gate`. Never deploys, never touches AWS.                                                                                                                       |
| push to `develop`                        | validation -> `ci-gate` -> `gates` -> `deploy` to **staging** (+ advisory `branch-sync`)                                                                                                  |
| push to `main`                           | validation -> `ci-gate` -> `gates` -> `deploy` to **production** (waits for the `production` environment reviewers; skipped when the push only touched docs / `learnix-infra` / markdown) |
| nightly `schedule`                       | `branch-sync` only (fails the run if `main` is ahead of `develop`)                                                                                                                        |
| `workflow_dispatch` `action=deploy`      | `gates` -> (`db-owner-approval`) -> `deploy` to the chosen environment                                                                                                                    |
| `workflow_dispatch` `action=rollback`    | `rollback` (the environment's own approvals apply)                                                                                                                                        |
| `workflow_dispatch` `action=branch-sync` | `branch-sync` only                                                                                                                                                                        |

`control` is the single place that maps an event to these paths (outputs `ci`, `deploy`, `rollback`,
`branch_sync`, `environment`, `manual`).

Job graph:

```
control -+- build-test -+- migration-chain ---+
         |              +- e2e-shard x4 -> e2e +
         +- format-check, env-validation, secret-scan,
         |  dependency-audit, workflow-lint -----+--> ci-gate -> gates -> [db-owner-approval] -> deploy
         |  (migration-safety-check: advisory)        (staging: push to develop; production: push to main or dispatch)
         +- rollback      (dispatch action=rollback)
         +- branch-sync   (push / nightly / dispatch)
```

Concurrency: validation of a PR is cancelled when a newer commit arrives; pushes to `main`/`develop` queue (a
run that is already deploying is never cancelled, and a newer push replaces only a run that has not started);
manual and scheduled runs have a unique group. `deploy` and `rollback` share the lock `deploy-api-<environment>`
with `cancel-in-progress: false`, so two operations never touch the same ECS services at once and an
in-flight rollout is never cancelled.

### 1.1 Validation jobs

Triggered by `pull_request` and by pushes to `main`/`develop` (pushes to other branches are covered by their PR; see `CI-CD-AUDIT-REPORT.md`). Jobs, in the order they appear in the file:

| Job                                    | What it does                                                                                                                                                                                                                                      | New this phase? |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `build-test`                           | Typecheck, lint, build, unit tests with coverage                                                                                                                                                                                                  | No              |
| `migration-chain`                      | Runs every migration against a genuinely empty Postgres (closes finding R1)                                                                                                                                                                       | No (Phase 0)    |
| `e2e`                                  | Full E2E suite against Postgres 16 + Redis 7 service containers, split over 4 parallel shards (`e2e-shard`); `e2e` is the single aggregate check that fails unless every shard passed                                                             | No              |
| `secret-scan`                          | Gitleaks                                                                                                                                                                                                                                          | No              |
| `format-check`                         | **New.** `prettier --check` scoped to the files the event changed — not the whole repo. The file list comes from `scripts/ci/changed-files.sh` (NUL-safe, fails instead of reporting "no files" when the diff cannot be trusted). See §2 and §1.5 |
| `env-validation`                       | **New.** Runs `scripts/validate-env.ts` (calls the real `validate()` from `src/config/env.validation.ts`) against a synthetic, staging-shaped, non-secret configuration                                                                           |
| `migration-safety-check`               | **New**, `continue-on-error: true`. Runs `scripts/migration-safety-check.ts` against any migration files changed relative to `origin/main`, classifying each SAFE / NEEDS_DB_APPROVAL / BLOCKED                                                   |
| `dependency-audit`                     | **Blocking.** `npm audit --audit-level=high` (zero high/critical advisories today; remaining moderates are listed in `CI-CD-AUDIT-REPORT.md`)                                                                                                     |
| `workflow-lint`                        | **New.** `actionlint` (pinned by digest) over every workflow file: expression/context typos, bad `needs`, reusable-workflow inputs, shellcheck on `run:` scripts; then shellcheck and the tests of `scripts/ci/`                                  |
| `ci-gate`                              | `scripts/ci/ci-gate.mjs`: fails unless every required validation job above reported `success` (skipped, cancelled, missing or an empty result list all fail; the failing jobs are named). The only thing `gates`/`deploy` wait for                |
| `gates`, `db-owner-approval`, `deploy` | Release path, see 1.2                                                                                                                                                                                                                             |
| `rollback`, `branch-sync`              | Manual rollback and the nightly/push divergence check, see 1.3                                                                                                                                                                                    |

#### E2E diagnostics (what to open when `e2e` is red)

Each `e2e-shard` job runs `npm run e2e:preflight` first (Node major, `SELECT version()` on Postgres, Redis `PING`; versions only, no connection strings), then `npm run test:e2e:ci`, which keeps the **full** console output (`jest-output.log`, via `tee`), a JSON result file (`results.json`) and a JUnit file (`junit.xml`, `jest-junit`), and logs the heap used per suite (`--logHeapUsage`). jest's own exit status is taken from `PIPESTATUS` (never `tee`'s) and written to `exit-code.txt` before the step exits. After the tests, with `if: always()`, the shard publishes a result table to the run summary, collects the Postgres/Redis container logs (and groups the Postgres `ERROR` lines in the summary), masks credentials in the text files (`scripts/ci/redact.mjs`; a file that cannot be masked is deleted, not uploaded) and uploads everything under `e2e-results/` as the artifact `e2e-shard-N` (14 days).

The aggregate `e2e` job needs no `npm ci`. It downloads all shard artifacts and runs `scripts/ci/e2e-verdict.mjs --shards 4`, which passes only when **every** shard 1..4 has a parsable `results.json` with at least one suite and no failed test, suite or runtime error, **and** an `exit-code.txt` of `0`, **and** `needs.e2e-shard.result` is `success`. A missing artifact, malformed JSON, zero suites, a non-zero jest status (even with `success: true`), a cancelled or skipped matrix are all failures. The summary separates `FAILED (assertions)` from `FAILED (infrastructure)` and lists the failed suites and tests with the first lines of their (masked) error. Keep the `4` in the verdict step equal to the matrix and the `--shard=N/4` argument. Reproduce a shard locally with `npm run test:e2e:ci -- --shard=N/4` (against a disposable Postgres/Redis, never a shared dev database).

Postgres `ERROR` lines in a green shard are not necessarily failures: a migration that re-adds a constraint (`already exists`, caught by the migration itself, see `2054000000000-HardenTeacherPayoutStageOne`) and unique violations that a test provokes are logged by the server and handled by the application. A `deadlock detected` is a test-isolation race (post-commit listener vs. `resetDatabase()`), see `E2E_KNOWN_FAILURES.md`.

### 1.2 AWS release (`gates` -> `db-owner-approval` -> `deploy`)

One linux/arm64 image serves the `api`, `worker` and `migrate` task definitions. `deploy` builds it with the RDS
CA bundle, scans it (Trivy, fixable HIGH/CRITICAL fail), pushes it to ECR under the commit SHA, then runs
`learnix-infra/scripts/ecs-deploy.sh` (the only copy): each new task definition is built from the LATEST revision of
the service family (so Terraform changes to environment, secrets and sidecars ship with the release), the migrate
task runs first (must exit 0), then api + worker, with automatic rollback when a deployment fails or one of the
`DEPLOY_ALARMS` fires. The deploy refuses to start while one of those alarms is already firing. Credentials come from GitHub OIDC (`AWS_DEPLOY_ROLE_ARN`); nothing secret is
stored in the workflow. Required environment variables are listed in the comment above the `gates` job.

- **Staging**: automatic on push to `develop`, only after `ci-gate` passed, in the same run.
- **Production**: automatic on push to `main` (after `ci-gate`), or by `workflow_dispatch`
  (`action=deploy`, `environment=production`). Requires a successful push run of `ci-cd.yml` on `develop` whose
  git TREE equals the tree being deployed (a merge commit on `main` has a new SHA, so the comparison is on
  content; that run includes its staging rollout), the migration
  classifier (`BLOCKED` fails; `NEEDS_DB_APPROVAL` waits for the `production-db-approval` environment), the
  `production` environment's reviewers, and an RDS snapshot taken before migrating.
- Post-deploy verification is `ecs-deploy.sh`'s wait for steady state plus its alarm watch (automatic rollback),
  and the read-only API smoke test when the environment sets `SMOKE_FROM_RUNNER=true`.
- There is no Terraform in this workflow: see 1.4.

### 1.3 `rollback` and `branch-sync`

`rollback` (`workflow_dispatch`, `action=rollback`) re-points ECS services at earlier task-definition revisions;
database changes are not reverted. `branch-sync` (`scripts/ci/branch-sync-check.sh`) fails if `main` has a
non-merge commit whose change is not in `develop` (a hotfix that was not merged back, plan section 11; a release
merge commit alone, or a cherry-picked merge-back, is fine) and warns when `develop` drifts over 100 commits
ahead. It reads the refs that `fetch-depth: 0` already fetched and needs no credentials, so `persist-credentials:
false` stays; it fails closed when a ref or the full history is missing. On a push it is advisory
(`continue-on-error`) so that, as before the merge, it cannot turn the run red and block the production gate;
nightly and manual runs fail normally.

### 1.4 Terraform: `terraform.yml`

`learnix-infra/` lives inside this repository, and GitHub only reads `.github/workflows` at the repository root,
so the Terraform pipeline is the root workflow `terraform.yml`. It never deploys the application, and `ci-cd.yml`
never applies infrastructure: one push cannot start a duplicate deploy or apply.

| Event                                   | What runs                                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `pull_request` touching `learnix-infra` | `static` (fmt, validate, `terraform test`, tflint, checkov for all 4 roots), `deploy-script` test, **staging plan** only |
| push to `main` touching `learnix-infra` | the same static checks, then a plan of org, staging and production (read-only)                                           |
| nightly 04:00 UTC                       | drift: `plan -detailed-exitcode -lock=false` of org, staging, production (a diff fails the run so GitHub notifies)       |
| `workflow_dispatch` `target`            | plan -> conftest policies -> **apply of exactly that plan** in the `infra-<target>` environment (required reviewers)     |

Targets whose plan-role variable is empty are skipped, so the workflow is safe before an account exists. Each target
has its own lock (`terraform-<name>`), never cancelled. Values reach the shell through environment variables, never by
interpolation. Trust: the plan role trusts `main` (and, in the staging account only, pull requests); the apply role
trusts only the `infra-<env>` GitHub environment. Both are pinned to `muhamedhalim/learnix-back` in `bootstrap/`.

### 1.5 `scripts/ci/`: the logic that decides pass/fail is in tested scripts

| Script                 | Used by                              | What it guarantees                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm-ci.sh`            | every job that installs dependencies | `npm ci` (deterministic) with at most 3 attempts, only for network errors (`ECONNRESET`, `ETIMEDOUT`, registry 5xx ...); lockfile, auth, 404, integrity and engine errors fail at once. npm's own status is preserved, credentials are masked, the runner's npm log path is printed (the log itself never is). Sets `fetch-retries`, `fetch-timeout`, `--no-audit --no-fund --prefer-offline`. |
| `changed-files.sh`     | `format-check`                       | NUL-delimited changed `.ts/.tsx/.js/.jsx/.json/.md` files, no deletions; base = event base, else merge-base, else first parent, else the empty tree; fails on unknown head, shallow clone or a git error                                                                                                                                                                                       |
| `branch-sync-check.sh` | `branch-sync`                        | See 1.3                                                                                                                                                                                                                                                                                                                                                                                        |
| `ci-gate.mjs`          | `ci-gate`                            | See the job table                                                                                                                                                                                                                                                                                                                                                                              |
| `e2e-verdict.mjs`      | `e2e`                                | See "E2E diagnostics"                                                                                                                                                                                                                                                                                                                                                                          |
| `redact.mjs`           | `e2e-shard`, `e2e-verdict.mjs`       | Masks connection strings, bearer tokens, key=value secrets and known token shapes                                                                                                                                                                                                                                                                                                              |

`bash scripts/ci/run-tests.sh` runs their tests (throwaway git repositories, a fake `npm`, `node --test`); the
`workflow-lint` job runs them and shellchecks the scripts on every change. A retry wrapper cannot confirm that the
GitHub-hosted runners' connectivity is fixed: it bounds the damage of a transient failure, and a persistent one still
fails with the attempt count and the npm log path.

## 2. Why `prettier --check .` is not a blanket CI gate

`npm run lint` already includes `prettier --check .` across the whole repository. Running that
in CI today would fail on every PR regardless of content: the repository has a large pre-existing
baseline of unformatted files from before this check existed (~315 files, per the plan's own
`Prettier formatting practice` note carried over from earlier phases). Per this phase's explicit
instruction ("don't let the Prettier gate fail because of 300 outdated files without a phased
approach — gate only modified files, record separate debt, or fix the baseline in a separate PR"),
`format-check` diffs against the event's base (PR base tip, or the push's previous tip) and only checks files
the current change actually touches. `npm run format:changed` applies the same scope locally (`--write` fixes them). The baseline itself is unaddressed — recorded as debt, not hidden, and not fixed in this
phase (a repo-wide reformat is its own separate, reviewable PR, not bundled into staging
infrastructure work).

## 3. Frontend — `dodline/.github/workflows/ci.yml` (modified this phase)

| Job                | What it does                                                       | New this phase?                                             |
| ------------------ | ------------------------------------------------------------------ | ----------------------------------------------------------- |
| `build`            | Lint, typecheck, unit tests with coverage, `next build`            | No (build step's env var was parameterised in Phase 1 — H4) |
| `secret-scan`      | Gitleaks                                                           | No                                                          |
| `dependency-audit` | **New**, `continue-on-error: true`. `npm audit --audit-level=high` |

**Known, pre-existing, verified baseline** (not fixed this phase — out of scope, app feature code):
`npm run lint` currently reports **2 real errors** (not warnings — these fail the `build` job's
exit code today, independent of any staging change), both the same rule
(`react-hooks`'s set-state-in-effect check):

- `app/[locale]/Components/Certificates/CertificateRenderer.tsx:176`
- `app/[locale]/student/redeem/page.tsx:54`

Documented in a comment directly above the `Lint` step in `ci.yml` so a red run on this exact step
is recognised as this known baseline, not mistaken for a regression introduced by whatever change
triggered the run.

## 4. Staging environment variables and production-safe fallbacks in CI

The frontend build step's `NEXT_PUBLIC_API_URL` reads a repository/environment variable
(`vars.NEXT_PUBLIC_API_URL_CI`) before falling back to today's Production literal (Phase 1, finding
H4) — a future staging-specific CI configuration can set that variable to the staging API without
any code change, and an unset variable reproduces exactly today's behaviour. The same
fallback-to-current-literal pattern was applied to `NEXT_PUBLIC_SITE_URL` and the Sentry
`environment` tag in Phase 1 (§30 of the plan) — every one of these is additive and inert until a
value is explicitly set.

## 5. GitHub settings that cannot be read from the repository

Nothing below is verified: the audit had no GitHub access. Each must be created by a repository admin.

| Setting                               | Value                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Environments                          | `staging`, `production` (required reviewers), `production-db-approval` (DB owners), `infra-staging`, `infra-production`, `infra-management` (required reviewers). Restrict deployment branches: `develop`/`main` only                                                                                                                         |
| Variables of `staging` / `production` | `AWS_REGION` (eu-central-1), `AWS_DEPLOY_ROLE_ARN`, `ECR_REPOSITORY_URL`, `ECS_CLUSTER`, `ECS_SERVICES`, `MIGRATE_FAMILY`, `TASK_NETWORK`, `DEPLOY_ALARMS`, `API_URL`, `SMOKE_FROM_RUNNER`; production also `DB_INSTANCE_ID`                                                                                                                  |
| Repository variables (Terraform)      | `AWS_REGION`, `STAGING_PLAN_ROLE_ARN`, `STAGING_APPLY_ROLE_ARN`, `STAGING_TF_STATE_BUCKET`, `STAGING_TF_STATE_KMS_KEY_ARN`, `STAGING_TFVARS_JSON`, the same with `PRODUCTION_`, and for `org/`: `AWS_PLAN_ROLE_ARN`, `AWS_APPLY_ROLE_ARN`, `TF_STATE_BUCKET`, `TF_STATE_KMS_KEY_ARN`, `ORG_TFVARS_JSON`. All are outputs or non-secret values |
| Branch protection (`main`, `develop`) | Require PRs and the checks `CI gate` and `E2E tests (Postgres + Redis)`; see `BRANCH_PROTECTION_SETUP.md`. Terraform static checks are required for changes under `learnix-infra`                                                                                                                                                             |
| AWS side                              | OIDC provider and roles from `learnix-infra/bootstrap` with `github_repository = muhamedhalim/learnix-back`; the per-environment deploy roles from `modules/deploy-role`                                                                                                                                                                      |
| Other automation on the same branches | Railway's GitHub integration (retired) must be disconnected; Vercel's Git integration deploys the frontend (intended, a separate target)                                                                                                                                                                                                      |

### Why one push used to start several deployments, and how it is prevented now

1. Separate workflows reacted to the same `push` (CI, a deploy workflow, a secret-scan workflow): merged into
   `ci-cd.yml` (commits `c9807a9`, `cbb3686`).
2. A push that changed only docs or `learnix-infra` rebuilt and redeployed an identical image: `control` computes
   `app_changed` and skips the deploy; `terraform.yml` handles the infra change.
3. Infra and application pipelines are separate workflows with separate locks and disjoint triggers.
4. Remaining outside this repository (verify in the Railway dashboard): a Railway GitHub integration that still builds `main`.

## 6. What is not yet true, stated plainly

- No workflow in this document has been executed by real GitHub Actions from this session — no
  `gh` CLI, no authenticated Actions API access. Every claim above is "this is what the YAML says
  and locally reproduces," not "this has been observed to pass in CI."
- `migration-safety-check` is `continue-on-error: true` and therefore currently cannot be made a
  _required_ status check in branch protection (§ `BRANCH_PROTECTION_SETUP.md` §3.1's own caveat) — a
  required check that can never fail is not a gate. `dependency-audit` is blocking and may be required.
- The Railway deploy workflows were deleted (Railway production has been down since 2026-08-13 and AWS is
  deployed by `ci-cd.yml`), so the Phase 4/5 concern about Railway's own auto-deploy no longer applies to AWS.
