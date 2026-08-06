# Phase 5 — GitHub Actions Required From You

Phase 5 of `STAGING_ENVIRONMENT_IMPLEMENTATION_PLAN.md`. This is the action checklist — what to
actually click/run, in order — complementing `docs/CI_CD_SETUP.md` (what the workflows do) and
`docs/BRANCH_PROTECTION_SETUP.md` (what each setting should be). Nothing below was performed this
session: no `gh` CLI is installed, and this session's only confirmed GitHub permission is git
push (via `git push --dry-run`, not the repo-admin scope branch protection and Environments need.

## 1. Push the `develop` branches

Both were created and committed locally this session, not pushed:

```bash
# learning-center-backend
git push origin develop     # pushes commit d90ecd8, branched from main's 7d0ba8e

# dodline
git push origin develop     # pushes commit e7b381f, branched from master's 79392aa
```

Review the two commits first if you want (`git show d90ecd8` / `git show e7b381f` from each repo)
— they contain the Phase 2-closure/Phase 3 work (backend) and Phase 1 work (frontend) that were
sitting uncommitted in each working tree from prior sessions.

## 2. Branch protection (both repos)

GitHub → repo → Settings → Branches → Add rule. Exact settings in
`docs/BRANCH_PROTECTION_SETUP.md` §3.1 (production branch: `main` backend / `master` frontend) and
§3.2 (`develop`, both repos). Do this **after** step 1, since the required-status-checks picker
only lists jobs that have actually run at least once on that branch.

## 3. GitHub Environments (backend repo only — the frontend has no equivalent workflow)

Settings → Environments → New environment, three times: `production`, `production-db-approval`,
`staging`. Required reviewers and purpose for each in `docs/BRANCH_PROTECTION_SETUP.md` §3.3.

## 4. Secrets and variables

Once the Railway/Vercel staging infrastructure exists (Phase 4 — currently blocked on dashboard
access), populate the `staging` GitHub Environment with the secrets `deploy-staging.yml` reads:
`STAGING_DATABASE_URL`, `STAGING_REDIS_URL`, `STAGING_JWT_SECRET`, `STAGING_JWT_REFRESH_SECRET`,
`STAGING_COOKIE_SECRET`, and the variables `STAGING_FRONTEND_URL`, `STAGING_BACKEND_URL`,
`STAGING_MAIL_ALLOWLIST`. For `production`, populate `PRODUCTION_DATABASE_URL` (secret) and
`PRODUCTION_BACKEND_URL` (variable — see `docs/PHASE_4_DASHBOARD_CHECKLIST.md` §0.2 for why this
needs a fresh check, not copying the domain this repo has historically assumed). For the frontend
build, optionally set the repository variable `NEXT_PUBLIC_API_URL_CI` once a staging CI build is
wanted — it falls back to today's Production literal when unset, so this is optional, not required.

## 5. Close the Railway/Vercel auto-deploy gap

The single highest-priority action from Phases 4–5, repeated here because it is easy to lose in a
long checklist: **Railway currently deploys `main` to Production on every push, with no approval
gate, confirmed live during Phase 4.** `deploy-production.yml`'s approval/backup/migration gates
do not control that. Pick one, in the Railway dashboard, for the existing `web` service (not a
new one — this is Production):

- Disable the service's git-integration auto-deploy, and instead have `deploy-production.yml`'s
  `deploy` job call `railway up`/`railway redeploy` (with a Railway API token stored as a GitHub
  secret) once its gates pass; or
- Leave auto-deploy on, but treat `deploy-production.yml` as an audit/backup/notification layer
  only — accurate to what it does today — and rely on branch protection (§2) to make sure nothing
  reaches `main` without review, which is the actual point at which an unreviewed change could
  still slip through today.

Either is a legitimate choice; what matters is that it's a deliberate one, not a gap nobody
decided about. This session did not make this change itself — it is a live Production
infrastructure change, explicitly out of scope for this session to perform unrequested.

## 6. Verify

Once steps 1–3 are done, the Phase 5 verification checks from the plan's §18 Phase 5 acceptance
criteria become testable for real:

```bash
# Direct push to main should be rejected:
git checkout main && git commit --allow-empty -m "test" && git push origin main
# expected: rejected by branch protection

# A PR with a failing required check should show as blocked in the GitHub UI,
# not merge even if manually attempted.
```

Revert/delete any test artefacts these produce — they are not meant to be kept.
