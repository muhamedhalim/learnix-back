# Release Process (Draft)

Phase 5 of `STAGING_ENVIRONMENT_IMPLEMENTATION_PLAN.md`. Marked **draft** because it has not yet
been exercised end to end — Phase 9 (Production promotion workflow) is what runs this process for
real the first time and finalises it as `docs/RELEASE_PROCESS.md`. Written now so Phase 5's CI/CD
scaffolding has a process to serve.

## 1. Day-to-day flow

```
feature/<name>  →  PR  →  develop  →  (auto) staging deploy  →  smoke  →  UAT
                                                                    │
                                                                    ▼
                                                    PR develop → main (this is the release)
                                                                    │
                                                        approval + backup + migration gate
                                                                    │
                                                                    ▼
                                                              main → Production
                                                                    │
                                                          tag vX.Y.Z + changelog entry
```

1. Branch `feature/<name>` off `develop`.
2. Open a PR into `develop`. `ci-cd.yml`'s validation jobs (`ci-gate`) must pass (§ `CI_CD_SETUP.md` §1.1) before merge —
   enforced by `develop`'s branch protection (§ `BRANCH_PROTECTION_SETUP.md` §3.2).
3. Merging to `develop` pushes it; the same `ci-cd.yml` run validates it again, then its `deploy` job
   rolls it out to AWS staging (Vercel deploys the frontend on its own).
4. Manually exercise the change on staging (UAT). Let it soak — the plan's own promotion rule
   (§11) is at least 24h with no new Sentry issues before proposing a release.
5. When ready to release: open a PR `develop` → `main`, titled `Release vX.Y.Z`. This PR is the
   release; do not bundle it with more feature work.
6. Production is a manual dispatch of `ci-cd.yml` (`action=deploy`, `environment=production`). Its `gates`
   job requires a successful push run of `ci-cd.yml` on `develop` for the exact commit being promoted —
   if staging was never actually deployed at this SHA, the production deploy refuses to proceed.
7. Migration safety classification runs; anything above SAFE needs the `production-db-approval`
   Environment's reviewers, in addition to the release PR's own required review.
8. Merge with a **merge commit**, not squash — squashing collapses `develop`'s history into a
   single commit on `main`, which permanently diverges the two branches' histories and makes every
   future `main`/`develop` diff misleading (this is why the `branch-sync` job compares by commit
   ancestry, not by content).
9. The `production` GitHub Environment's required reviewers approve the `deploy` job of that
   dispatch. It snapshots the database, migrates, rolls out with automatic rollback, and runs a **read-only** smoke test.
10. Tag `vX.Y.Z`. Append an entry to `CHANGELOG.md` (not yet created — Phase 9 scope) summarising
    the release from Conventional-Commit-style PR titles merged since the last tag.

## 2. Hotfix flow

1. Branch `hotfix/<name>` off `main` (not `develop` — a hotfix fixes what's live right now).
2. PR into `main`, same approval/backup/migration gates as a normal release.
3. Tag `vX.Y.Z+1`.
4. **Immediately** open a second PR merging `main` back into `develop` in the same sitting —
   the `branch-sync` job fails the next night if this is skipped, but don't wait for it to fail; do it
   as part of the hotfix itself.

## 3. Rollback

Full detail and measured drill times belong in `docs/ROLLBACK_RUNBOOK.md` (Phase 8 — not written
yet; that phase's job is to actually perform each drill on staging and record real numbers, not
to theorise them). Until then, the plan's own §17 rollback table and its "conditions that forbid a
direct rollback" list (destructive migration ran, money moved, webhooks were acknowledged, secrets
rotated, a new enum value was written, storage keys changed shape) are the operative reference:
**if a customer, a teacher, or the ledger has observed the new state, roll forward, don't roll
back.**

## 4. What this draft does not yet cover

- No `CHANGELOG.md` exists yet (Phase 9).
- No release has ever actually run through this process — every step above is designed, not
  proven. Phase 9's job is to run `THROTTLE.AUTH`'s restoration (finding R5) as the very first
  release through this exact pipeline and record what actually happens at each step, promoting
  this file to `RELEASE_PROCESS.md` once it has.
- The Production approval gate does not yet control Railway's actual deploy timing (§ `CI_CD_SETUP.md`
  §5) — until that's resolved, step 9 above is real (backup, health check, smoke test all
  genuinely run and gate the workflow) but Railway itself may have already deployed the merge
  commit before the workflow even starts, per Phase 4's finding.
