# Branch Protection Setup — Backend and Frontend

Phase 5 of `STAGING_ENVIRONMENT_IMPLEMENTATION_PLAN.md`. **Nothing in this document has been
applied** — GitHub branch protection is a repository Settings/API action, and this session has
no `gh` CLI (not installed) and no authenticated GitHub REST API access (unauthenticated calls to
`api.github.com` return `404`/`401` for both repos, confirmed during Phase 4/5 — both repos are
private). Git **push** access was separately confirmed working (via `git push --dry-run`), which
is how the `develop` branches described below were created — but push access and repo-admin
API/Settings access are different permissions, and this session was not given the latter.

## 1. Real, current state (verified via `git ls-remote`, not assumed)

|                                         | Backend (`learnix-back`)                                                                                                                                                                                                                                    | Frontend (`leanix-front`)                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Default branch                          | `main`                                                                                                                                                                                                                                                      | `master`                                                                                               |
| Remote branches that exist today        | **`main` only**                                                                                                                                                                                                                                             | **`master` only**                                                                                      |
| `develop` on the remote                 | **No**                                                                                                                                                                                                                                                      | **No**                                                                                                 |
| `develop` created locally this session  | Yes, from `main`'s current tip `7d0ba8e`, with the pending Phase 2-closure/Phase 3 work committed on top (`d90ecd8`)                                                                                                                                        | Yes, from `master`'s current tip `79392aa`, with the pending Phase 1 work committed on top (`e7b381f`) |
| `develop` pushed to the remote          | **No** — see §2                                                                                                                                                                                                                                             |
| Branch protection on the default branch | **Unknown from here** — GitHub's branch-protection API requires authentication this session doesn't have. The original Phase 0 audit found no protection (risk R6); nothing observed this session contradicts that, but it was not re-confirmed via the API |
| Railway deploying from                  | `main`, confirmed live (Phase 4 §31.3) — **and it auto-deploys on every push, with no gate**                                                                                                                                                                |
| Vercel deploying from                   | Could not confirm (no Vercel session) — by elimination, must be `master`, since no other branch exists                                                                                                                                                      |

## 2. Why `develop` was not pushed

Per this phase's own instruction ("Do not push directly if permissions or policies are unclear"):
push access was independently confirmed working via a dry run, but pushing a new branch is still
a change visible to every collaborator on a real, shared GitHub repository. Rather than assume
that's welcome, both `develop` branches are ready locally with their SHAs recorded here — push them
yourself, or tell this session to, once you've reviewed the two commits
(`d90ecd8` backend, `e7b381f` frontend):

```bash
git push origin develop   # from learning-center-backend
git push origin develop   # from dodline
```

## 3. Required branch protection settings

Configure via GitHub → repo → Settings → Branches → Add rule, for **both** repos.

### 3.1 Production branch (`main` backend / `master` frontend)

| Setting                                          | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Require a pull request before merging            | On                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Required approvals                               | 1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Dismiss stale approvals on new commits           | On                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Require status checks to pass before merging     | On — select every validation job from `ci-cd.yml` (`build-test`/`build`, `migration-chain`, `e2e`, `secret-scan`, `format-check`, `env-validation`, `dependency-audit`, `workflow-lint`; `e2e` is the aggregate of the four `e2e-shard` jobs — require `e2e`, not the shards; `migration-safety-check` is still `continue-on-error`, §5 of `CI-CD-ARCHITECTURE.md` — do not require it until that flag is removed, or it will block merges without ever being able to fail visibly)                                                                  |
| Require branches to be up to date before merging | On                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Require conversation resolution before merging   | On                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Require linear history                           | On (this project merges `develop`→`main` with a merge commit per the plan's §11 — "linear history" here means no merge commits _within_ a PR's own branch, not banning the release merge commit itself; GitHub's linear-history option only blocks merge commits being the final merge strategy, so pair it with restricting the merge button to "Squash and merge" for feature PRs and use the API/CLI for the actual release merge commit, or accept ordinary merge commits and skip this option — team preference, not a correctness requirement) |
| Do not allow bypassing the above settings        | On (no admin override)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Restrict who can push                            | Optional — at minimum, block direct pushes for everyone (the PR requirement above already does this)                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Allow force pushes                               | **Off**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Allow deletions                                  | **Off**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### 3.2 Staging integration branch (`develop`, both repos)

| Setting                                       | Value                                                                                                                                         |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Require a pull request before merging         | On                                                                                                                                            |
| Required approvals                            | 0–1 (team size — the plan leaves this to you; a solo/small team can reasonably skip mandatory review on `develop` while keeping it on `main`) |
| Require status checks to pass before merging  | On — same job list as §3.1                                                                                                                    |
| Require branches to be up to date             | On                                                                                                                                            |
| Do not allow bypassing (CI cannot be skipped) | On                                                                                                                                            |
| Allow force pushes                            | **Off**                                                                                                                                       |
| Allow deletions                               | **Off**                                                                                                                                       |

### 3.3 GitHub Environments (for the approval/db-approval gates in `ci-cd.yml`)

Settings → Environments → New environment, twice:

| Environment name         | Required reviewers                                     | Used by                                                                                                                               |
| ------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `production`             | The people authorised to approve a Production release  | `ci-cd.yml`'s `deploy` job (production dispatch) — the single manual-approval gate                                                    |
| `production-db-approval` | The database-owners group (may overlap with the above) | `ci-cd.yml`'s `db-owner-approval` job — only runs when `scripts/migration-safety-check.ts` classifies a migration `NEEDS_DB_APPROVAL` |
| `staging`                | None needed (or a lighter-weight set)                  | `ci-cd.yml`'s `deploy` job on push to `develop` — holds the staging AWS variables (see `docs/CI-CD-ARCHITECTURE.md`)                  |

## 4. What this does NOT change

Per this phase's explicit constraints: **nothing in Railway or Vercel's own auto-deploy
configuration was touched.** §31.2 of the plan (Phase 4) already found that Railway currently
deploys `main` on every push with zero gate — GitHub branch protection alone does not close that
gap, because Railway's git integration is a separate system that doesn't consult GitHub's PR/
approval state. See the header comment of the since-deleted `deploy-production.yml` for exactly what closing that gap
would require (disabling Railway's auto-deploy, or switching it to be triggered by this workflow
instead) — that is a Railway dashboard action for a human to make, not something this session
performed unrequested against live Production infrastructure.
