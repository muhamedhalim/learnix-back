# CI/CD Setup — Backend and Frontend

Phase 5 of `STAGING_ENVIRONMENT_IMPLEMENTATION_PLAN.md`. Describes every workflow file that exists
after this phase, what each job does, and — honestly, not optimistically — what each job cannot
yet guarantee because it has never run against real GitHub Actions infrastructure or real
secrets from this session (no `gh` CLI, no GitHub Actions API access; every workflow here was
validated by local YAML parsing and, where possible, by running the underlying script locally
with the same inputs the workflow passes it — never by an actual triggered run).

## 1. Backend — `learning-center-backend/.github/workflows/`

### 1.1 `ci.yml` (modified this phase)

Triggers on every push and pull request, unchanged. Jobs, in the order they appear in the file:

| Job                      | What it does                                                                                                                                                                                    | New this phase? |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `build-test`             | Typecheck, lint, build, unit tests with coverage                                                                                                                                                | No              |
| `migration-chain`        | Runs every migration against a genuinely empty Postgres (closes finding R1)                                                                                                                     | No (Phase 0)    |
| `e2e`                    | Full E2E suite against Postgres 16 + Redis 7 service containers                                                                                                                                 | No              |
| `secret-scan`            | Gitleaks                                                                                                                                                                                        | No              |
| `format-check`           | **New.** `prettier --check` scoped to files changed since the merge-base only — not the whole repo. See §2 for why                                                                              |
| `env-validation`         | **New.** Runs `scripts/validate-env.ts` (calls the real `validate()` from `src/config/env.validation.ts`) against a synthetic, staging-shaped, non-secret configuration                         |
| `migration-safety-check` | **New**, `continue-on-error: true`. Runs `scripts/migration-safety-check.ts` against any migration files changed relative to `origin/main`, classifying each SAFE / NEEDS_DB_APPROVAL / BLOCKED |
| `dependency-audit`       | **New**, `continue-on-error: true`. `npm audit --audit-level=high`                                                                                                                              |

### 1.2 `deploy-staging.yml` (new)

Triggers on push to `develop`. **Does not itself deploy anything** — see the file's own header
comment: Railway's git integration, once a staging `web` service exists and is pointed at
`develop`, deploys independently of this workflow (confirmed behaviour for the existing
Production service — Phase 4 §31.2). This workflow instead re-validates the real staging
configuration (via the `staging` GitHub Environment's secrets, not CI's synthetic ones), waits for
the deploy to land, and smoke-tests it.

### 1.3 `deploy-production.yml` (new)

Triggers on push to `main`. Implements every gate the plan's §12.3 asks for — staging-soak check,
migration-safety classification with a separate database-owner approval environment for anything
above SAFE, a pre-deploy backup with an uploaded artifact, a manual-approval `production`
GitHub Environment, a health-check wait, and a read-only smoke test. **Read the file's own header
comment before treating this as a working deploy gate**: Railway currently deploys `main` to
Production automatically and independently of this workflow (Phase 4 §31.2/§0.1) — this workflow
provides the backup, migration-safety, and audit-trail value regardless, but does not yet control
_when_ Railway actually deploys. Closing that requires a Railway dashboard change this session
was not authorised to make against live Production.

### 1.4 `branch-sync.yml` (new)

Nightly + on every push to `main`/`develop` + manual dispatch. Fails if `main` has any commit not
in `develop` (a hotfix that wasn't merged back — plan §11). Warns, without failing, if `develop`
drifts more than 100 commits ahead of `main` without a release.

## 2. Why `prettier --check .` is not a blanket CI gate

`npm run lint` already includes `prettier --check .` across the whole repository. Running that
in CI today would fail on every PR regardless of content: the repository has a large pre-existing
baseline of unformatted files from before this check existed (~315 files, per the plan's own
`Prettier formatting practice` note carried over from earlier phases). Per this phase's explicit
instruction ("don't let the Prettier gate fail because of 300 outdated files without a phased
approach — gate only modified files, record separate debt, or fix the baseline in a separate PR"),
`format-check` diffs against the merge-base and only checks files the current change actually
touches. The baseline itself is unaddressed — recorded as debt, not hidden, and not fixed in this
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

## 5. What is not yet true, stated plainly

- No workflow in this document has been executed by real GitHub Actions from this session — no
  `gh` CLI, no authenticated Actions API access. Every claim above is "this is what the YAML says
  and locally reproduces," not "this has been observed to pass in CI."
- `dependency-audit` and `migration-safety-check` are both `continue-on-error: true` and therefore
  currently cannot be made _required_ status checks in branch protection (§ `BRANCH_PROTECTION_SETUP.md`
  §3.1's own caveat) — a required check that can never fail is not a gate.
- `deploy-production.yml`'s approval gate does not yet control Railway's actual deploy timing
  (§1.3). This is the single most important open item from Phase 4/5 and is repeated in the final
  report rather than buried here.
