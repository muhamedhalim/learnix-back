# Production deploy version audit — 2026-10-20

Symptom: the CI/CD run for `main` was green, but `api.learnix.school` still served the previous backend.

## Evidence (read-only, 2026-10-20 ~17:10 UTC)

| What                                                                | Value                                                                                                                                                                                                          |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intended release                                                    | `main` = `fa1455b` (merge of PR #20), tree `14b2c84ccb34da535e7f4111053f86c2488a282f` (same tree as `a9bdeed`)                                                                                                 |
| Serving production                                                  | `cf91a611e412f00aa347d494b1d75d05b7dbd381`, image digest `sha256:6f9273940e583aff30c8c042abeafddc7ff034eca62398db5ac4de62df88c614`                                                                             |
| ECS (cluster `learnix-production`, acct 486940690416, eu-central-1) | `api` → `learnix-production-api:3`, `worker` → `learnix-production-worker:3`; 1/1 each, single PRIMARY deployment COMPLETED 2026-10-19 15:2x UTC; every running task on the digest above                       |
| ECR `learnix-production/api`                                        | tags `f348d26…`, `b97cc15…`, `cf91a61…` only — no image for `a9bdeed` or `fa1455b` was ever built or pushed                                                                                                    |
| Routing                                                             | `api.learnix.school` → CloudFront `ENLOUWTVYKRG7` → internal ALB `learnix-production-alb` → 1 healthy target. Health responses `Cache-Control: private, no-store`, `X-Cache: Miss`. Routing/caching is correct |
| Gap                                                                 | 19 commits, 38 `src` files, 3 new migrations (`2082…`, `2083…`, `2208…`) between `cf91a61` and `fa1455b`                                                                                                       |

## Root cause

The new code was never built or deployed; the production domain correctly serves what ECS runs.

1. Run 39456264420 (push `a9bdeed`, tree `14b2c84`) **failed** in `Promotion gates`: no successful staging
   deploy of that tree. `develop` is still at `9181ab6` (26 commits behind `main`), and staging still runs the
   bootstrap image `ae719a9-r1`.
2. PR #20 ("Merge main into develop") was opened with **base `main`**, not `develop`. Its merge `fa1455b` has the
   same tree as `a9bdeed`, so `develop` was not updated and staging was not deployed.
3. Run 39458723787 (push `fa1455b`) was **green with `deploy` skipped**: the `control` job compared the push with
   its `before` (`a9bdeed`), found no file difference, set `app_changed=false`, and routed no deploy. The
   pipeline treated "identical to the previous commit" as "already deployed", even though the previous
   commit's deploy had failed.
4. Even with the gates passing, CI cannot deploy production: there is no `production` GitHub environment (no
   variables), and `launch.tfvars` has `app_repositories = {}`, so the OIDC role
   `learnix-production-gha-deploy-api` does not exist. Every production release so far was a manual workstation
   deploy (`cf91a61` on 2026-10-19).

A latent second false-success was found in `ecs-deploy.sh`: it waited only for the PRIMARY deployment to reach
COMPLETED. An ECS circuit-breaker rollback creates a new PRIMARY on the old revision that also reaches COMPLETED,
so a rolled-back deploy would have been reported as deployed.

## Fix (branch `fix/deploy-verification`)

- `ci-cd.yml` `control`: the "nothing in the image changed" skip now diffs against the commit the environment
  last received (newest successful GitHub deployment of `staging`/`production`, `scripts/ci/deploy-baseline.mjs`,
  7 tests). No record or API error means deploy, never a silent skip.
- `ecs-deploy.sh`: requires PRIMARY = the new revision, COMPLETED and the only deployment left; requires the tag
  to exist in ECR; requires every RUNNING task to be on the new revision and ECR digest; with `--verify-url`,
  requires 10 consecutive `GET /api/v1/health/version` responses through the public domain to report the commit.
  Any failure rolls api + worker back. 8 new fake-AWS cases, 21/21 pass.
- `ci-cd.yml` `deploy`: production requires `API_URL` and `DB_INSTANCE_ID` and always passes `--verify-url`; the run
  summary records commit, tree, image and digest.
- `GET /api/v1/health/version` → `{"commit": "<sha>"}`: public, commit id only (hex-validated, otherwise `null`).

## To release `main` to production (each step needs owner approval)

1. Merge `fix/deploy-verification` into `main` via PR. Then fast-forward `develop` to `main` with a PR whose
   **base is `develop`**. Pushing to develop deploys staging through CI, which satisfies the production tree gate.
2. Production CI path: set `app_repositories = { api = "muhamedhalim/learnix-back" }`, then plan and apply
   production Terraform to create `learnix-production-gha-deploy-api`. Create the `production` GitHub environment
   with required reviewers and a main-only branch policy, and set its variables from `terraform output`
   (`AWS_REGION`, `AWS_DEPLOY_ROLE_ARN`, `ECR_REPOSITORY_URL`, `ECS_CLUSTER`, `ECS_SERVICES=api,worker`,
   `MIGRATE_FAMILY`, `TASK_NETWORK`, `DEPLOY_ALARMS`, `API_URL=https://api.learnix.school`,
   `DB_INSTANCE_ID`). Then `workflow_dispatch` `deploy`/`production`.
   _Or_, as for `cf91a61`: a workstation deploy of the same commit with `ecs-deploy.sh --verify-url
https://api.learnix.school`, after staging is green.
3. Verify: `curl https://api.learnix.school/api/v1/health/version` returns the release commit, and
   `aws ecs describe-tasks` shows every api/worker task on the new revision and digest.
