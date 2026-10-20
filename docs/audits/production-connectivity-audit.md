# Production Connectivity Audit: learnix.school → backend

**Date:** 2026-10-18. **Mode:** read-only investigation. Nothing was changed in code, AWS, DNS, Vercel, GitHub or any database.
**Auditor workstation:** has the AWS CLI 2.37 (profile `learnix-staging`, **no credentials loaded**), Terraform, the Vercel CLI (**not logged in**), and a GitHub token (read-only REST calls only). The AWS MCP server also failed to connect (no credentials).

---

## 1. Executive summary

**learnix.school cannot reach a backend because there is no production backend.**

- The frontend on Vercel is healthy. It was built from the latest `master` commit (`f2a6c71`), and it calls exactly the URL it was designed for: `https://api.learnix.school/api/v1`.
- `api.learnix.school` is proxied by Cloudflare to an origin that does not complete a TLS handshake. Every request, including the CORS preflight, gets **Cloudflare HTTP 525 (SSL handshake failed)**.
- Browsers report this as a **CORS error**. That is misleading: the 525 response simply carries no CORS headers. The backend's CORS code is never reached.
- **No production environment exists on AWS.** The only AWS environment is staging (account `4869…0416`, eu-central-1), reachable only through `https://dz8egx08r1ti9.cloudfront.net` and only from one allowlisted operator IP. There is no production AWS account, no production Terraform state, no production GitHub environment and no production deploy variables.
- The "successful" CI/CD run on `main` (run `39111799968`, commit `a8b8e06`, 2026-10-18 08:31 UTC) **deployed nothing**. That commit added only one blank line to `learnix-infra/bootstrap/main.tf`, so the pipeline classified the push as "no app change" (`deploy=false`) and skipped the promotion gates and the rollout. The run still finished green. In the same push, Terraform's "Plan (production)" job also passed while printing "The plan role variable for production is not set: skipped."

**Confirmed root cause:** `api.learnix.school` has no working origin (Cloudflare returns 525), and no AWS production backend has been provisioned to replace it. The successful pipeline was a no-op, so it neither revealed nor fixed this.

---

## 2. Production architecture as found

| Layer                             | Designed (code / IaC)                                                                                                                                                                                                                              | Actually deployed                                                                                                                                                       | Evidence                                                               |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Frontend                          | Next.js 16.2 / React 19.2, Node ≥ 24 (`learnix-front/package.json`), Vercel project `dodlin…`                                                                                                                                                      | Vercel **Production** deployment of `f2a6c71` (state `success`, 2026-10-16 12:16 UTC)                                                                                   | GitHub Deployments API; `x-vercel-cache: HIT`, `Age: 168753` on `/`    |
| Frontend DNS                      | apex + www on Cloudflare (`dina`/`max.ns.cloudflare.com`)                                                                                                                                                                                          | apex and www are Cloudflare-proxied to Vercel; www returns 307 to the apex                                                                                              | `nslookup`, curl                                                       |
| API base URL                      | `NEXT_PUBLIC_API_URL`, inlined at build time, normalized to `<origin>/api/v1` (`app/[locale]/hooks/axios.config.ts:10-27`)                                                                                                                         | Live bundle contains `"https://api.learnix.school"` → `https://api.learnix.school/api/v1`                                                                               | grep over the 26 JS chunks served at `/`                               |
| API DNS/TLS                       | Prod Terraform: ACM cert + CloudFront for `api.learnix.school`, DNS-only records in Cloudflare (`environments/production/edge.tf`, `certificate_enabled=false` by default)                                                                         | `api.learnix.school` is **Cloudflare-proxied** (Cloudflare IPs, edge cert CN=learnix.school / \*.learnix.school, Google Trust Services). The origin fails TLS → **525** | curl, openssl                                                          |
| AWS edge / ALB / ECS / RDS (prod) | `learnix-infra/environments/production/*`                                                                                                                                                                                                          | **Does not exist.** No `backend.hcl` or `terraform.tfvars`, no state, no account (`org/organization.tf` never applied), no plan role                                    | Terraform CI log; local files; `docs/INITIAL-AWS-DEPLOYMENT.md`        |
| AWS staging                       | CloudFront `E1BTQT8D6RRQQ3` → VPC origin → internal ALB `learnix-staging-alb` → ECS `learnix-staging/api` (Fargate ARM64, port 3000) → RDS PG16 `learnix-staging-pg` + Valkey                                                                      | Exists per the 2026-10-13 report (task def `learnix-staging-api:3`, image `ae719a9-r1`). From this workstation: **403 from CloudFront/WAF** on every path               | curl; WAF allowlists one /32 that is not this workstation's current IP |
| Backend app                       | NestJS, `setGlobalPrefix('api/v1')` (except `GET /metrics`), listens on `0.0.0.0:${PORT‖3000}`, `EXPOSE 3000`, health at `/api/v1/health` (liveness) and `/api/v1/health/readiness` (`src/main.ts:226,270-272`, `src/health/health.controller.ts`) | Not running in any production environment                                                                                                                               | —                                                                      |
| CORS                              | Exact-origin credentialed allowlist from `CORS_ORIGINS` (`src/common/utils/cors.util.ts`). Prod Terraform sets it to `https://learnix.school` + `cors_extra_origins` (`environments/production/edge.tf:5-8`, `apps.tf:48-50`)                      | Never reached                                                                                                                                                           | —                                                                      |
| Legacy                            | Railway (`learnix / production` GitHub deployments, last one 2026-09-12, `bef7e10`)                                                                                                                                                                | Railway prod has been FAILED since 2026-08-13 (earlier audit). By your instruction, Railway was not inspected                                                           | GitHub Deployments API                                                 |

### Connection path (failure point marked)

```mermaid
flowchart LR
  B[Browser] -->|HTTPS 200| CFW[Cloudflare proxy<br/>learnix.school]
  CFW --> V[Vercel Production<br/>f2a6c71 ✅]
  V -->|JS bundle<br/>NEXT_PUBLIC_API_URL=https://api.learnix.school| B
  B -->|XHR /api/v1/marketplace/categories<br/>+ OPTIONS preflight| CFA[Cloudflare proxy<br/>api.learnix.school]
  CFA -.->|TLS handshake FAILS<br/>HTTP 525 ❌| OLD[(Unknown / dead origin<br/>probably legacy Railway)]
  CFA -. not wired .-> AWSP[AWS production<br/>CloudFront → ALB → ECS → RDS<br/>❌ NOT PROVISIONED]
  subgraph AWS staging, acct 4869…0416, eu-central-1
    CFS[CloudFront dz8egx08r1ti9<br/>WAF IP allowlist] --> ALB[internal ALB] --> ECS[ECS api :3000] --> RDS[(RDS PG16)]
  end
  style CFA fill:#fdd,stroke:#c00
  style OLD fill:#fdd,stroke:#c00
  style AWSP fill:#fdd,stroke:#c00
```

---

## 3. Evidence matrix

| #   | Stage                 | In code                                 | Deployed                                                                                                                                      | Test result                                                                                                                 | Evidence                                                                                                             | User impact                               |
| --- | --------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 1   | Frontend DNS          | Cloudflare zone                         | apex/www → Cloudflare anycast                                                                                                                 | ✅ resolves                                                                                                                 | `nslookup @1.1.1.1`                                                                                                  | none                                      |
| 2   | Frontend HTTPS        | Vercel                                  | `200` (apex), www `307`→apex                                                                                                                  | ✅                                                                                                                          | curl; `x-vercel-id: fra1::…`, `x-matched-path: /en`                                                                  | none                                      |
| 3   | Frontend build/commit | `master` = `f2a6c71`                    | Vercel Production `f2a6c71`, success                                                                                                          | ✅ latest commit                                                                                                            | GitHub Deployments API                                                                                               | none                                      |
| 4   | API URL in bundle     | `NEXT_PUBLIC_API_URL`                   | `https://api.learnix.school` (+`/api/v1`)                                                                                                     | ✅ correct by design. No localhost, staging or Railway URL found (the only `localhost` string is axios's internal fallback) | chunk grep                                                                                                           | none by itself                            |
| 5   | API DNS               | not in Cloudflare-managed Terraform yet | proxied A/AAAA (Cloudflare IPs); origin hidden                                                                                                | ⚠️ resolves, but to Cloudflare                                                                                              | `nslookup`, DoH (no CNAME visible)                                                                                   | —                                         |
| 6   | API TLS (edge)        | ACM on CloudFront (prod, unbuilt)       | Cloudflare Universal SSL `*.learnix.school`, valid to 2026-11-25                                                                              | ✅ edge OK                                                                                                                  | openssl                                                                                                              | —                                         |
| 7   | API origin            | AWS prod                                | **525** on `/`, `/health`, `/api/v1/health`, `/api/v1/health/readiness`, `/api/v1/marketplace/categories`, `/api/v1/auth/csrf-token`, OPTIONS | ❌ **failure point**                                                                                                        | curl (CF-RAY ids in the test log below)                                                                              | **all data, login and registration fail** |
| 8   | CORS                  | allowlist `https://learnix.school`      | not reached (the 525 has no ACAO)                                                                                                             | ❌ symptom only                                                                                                             | browser console: "No 'Access-Control-Allow-Origin' header" on `api.learnix.school/api/v1/marketplace/categories`     | the console shows a misleading CORS error |
| 9   | UI                    | —                                       | Marketplace shows "Network error. Please check your internet connection." for Featured and Recently added                                     | ❌                                                                                                                          | in-app browser `get_page_text`                                                                                       | the site looks broken                     |
| 10  | AWS prod LB/ECS/RDS   | Terraform prod                          | none                                                                                                                                          | ❌ absent                                                                                                                   | Terraform CI "Plan (production)": role var unset → skipped; no prod GitHub env/vars                                  | —                                         |
| 11  | AWS staging           | Terraform staging                       | CloudFront 403 from here                                                                                                                      | ⚠️ not verifiable from this IP                                                                                              | curl `X-Cache: Error from cloudfront`; current IP not in `allowed_ipv4_cidrs`                                        | none (staging)                            |
| 12  | Backend CI/CD         | push to main deploys prod               | run green, **deploy skipped**                                                                                                                 | ❌ verification gap                                                                                                         | run 39111799968 jobs: "Promotion gates" and "Build, migrate and roll out (AWS)" = skipped, "CI gate" `deploy: false` | false sense of a deployment               |

---

## 4. Live test log (2026-10-18, from this workstation)

| Test                                                                                                 | Result                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `GET https://learnix.school/`                                                                        | 200, Cloudflare → Vercel, prerender cached                                                                                              |
| `GET https://www.learnix.school/`                                                                    | 307 → `https://learnix.school/`                                                                                                         |
| `GET https://api.learnix.school/{,health,api/health,api/v1/health,api/v1/health/readiness}`          | **525** `Server: cloudflare`                                                                                                            |
| `GET https://api.learnix.school/api/v1/marketplace/categories` with `Origin: https://learnix.school` | **525**, no `Access-Control-*` headers                                                                                                  |
| `OPTIONS https://api.learnix.school/api/v1/auth/csrf-token` (POST, `content-type,x-csrf-token`)      | **525**, no `Access-Control-*` headers                                                                                                  |
| `https://api-staging.learnix.school/health`, `https://staging.learnix.school/`                       | 525 (stale Cloudflare records for the Railway era)                                                                                      |
| `https://dz8egx08r1ti9.cloudfront.net/{,health,api/v1/health,api/v1/health/readiness}` + preflight   | 403 CloudFront (WAF allowlist; expected from a non-allowlisted IP)                                                                      |
| In-app browser on `https://learnix.school/en/marketplace`                                            | console: CORS-blocked XHR to `api.learnix.school/api/v1/marketplace/categories` + `net::ERR_FAILED`; the UI shows network-error states  |
| CAA at apex                                                                                          | issuers: comodoca, digicert, letsencrypt, pki.goog, sectigo, ssl.com. **No `amazon.com`**, so ACM cannot issue for `api.learnix.school` |
| `aws sts get-caller-identity`                                                                        | NoCredentials                                                                                                                           |
| `vercel env ls production`                                                                           | not logged in                                                                                                                           |

Not done (would need authorization or credentials): login, registration, payment or any write; the AWS console/APIs; the Vercel dashboard; Cloudflare's dashboard (which would reveal the proxied origin of `api.learnix.school`).

---

## 5. CI/CD verification

**Backend (`muhamedhalim/learnix-back`, workflow `ci-cd.yml`)**

- Trigger: push to `main` at `a8b8e06` ("up"). Diff vs the previous `main` (`9181ab6`): one blank line in `learnix-infra/bootstrap/main.tf`.
- `control` → `app_changed=false` because `learnix-infra/*` is excluded (`ci-cd.yml:85-91`), so `deploy=false`. The `gates`, `db-owner-approval` and `deploy` jobs were skipped, and the run concluded **success**.
- Even if it had deployed, the `production` target is unconfigured: GitHub returns 404 for `environments/production/variables`, and the repo has no repository-level vars. The deploy job's "Refuse an unconfigured environment" step (`ci-cd.yml:~819`) would have failed it. That guard is good, but it never ran.
- The "Check main/develop divergence" job **failed** (`main` has 1 commit that `develop` lacks) without failing the run.
- Smoke test: `scripts/smoke-test.sh` runs only when `vars.SMOKE_FROM_RUNNER == 'true'`. Staging sets it to `false` because of the WAF, so no deploy has a post-deploy check today.
- `terraform.yml` reported success, but "Plan (production)" printed "The plan role variable for production is not set: skipped." and Apply was skipped.
- No CI/CD run on `develop` (staging) appears in the run history. The image that staging runs (`ae719a9-r1`) was deployed by hand on 2026-10-13, so staging is also behind `main` (`9181ab6` includes the EasyKash migration).

**Frontend (`muhamedhalim/leanix-front`)**

- Vercel's Git integration deploys `master` to Production regardless of GitHub Actions (Production `f2a6c71` succeeded).
- GitHub CI has failed on every push since 2026-09-03. The jobs fail with **no failing step**, which is consistent with the Actions billing rejection recorded on 2026-10-16 (probable, not re-verified). Vercel does not wait for CI.
- Nothing checks that the frontend build and the backend it points at are compatible or reachable.

---

## 6. Issues (prioritized)

| ID      | Category                 | Status        | Finding                                                                                                                                                              | Resource                                                                         | Severity                            |
| ------- | ------------------------ | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------- |
| **C-1** | DNS/TLS + Backend absent | **Confirmed** | `api.learnix.school` is Cloudflare-proxied to an origin that fails TLS (525). No AWS production backend exists to point it at                                        | Cloudflare record `api`; `learnix-infra/environments/production` (never applied) | **Critical**, site has zero backend |
| **C-2** | CI/CD verification gap   | **Confirmed** | A green `main` run can deploy nothing: infra-only pushes skip the deploy, the run stays green, and nothing reports "production not deployed"                         | `.github/workflows/ci-cd.yml` `control`, `ci-gate`                               | High                                |
| C-3     | CI/CD verification gap   | Confirmed     | Terraform production plan "succeeds" while skipped (role var unset)                                                                                                  | `.github/workflows/terraform.yml`                                                | Medium                              |
| C-4     | CI/CD verification gap   | Confirmed     | No post-deploy smoke test runs anywhere (`SMOKE_FROM_RUNNER=false`); the frontend has no reachability check                                                          | `ci-cd.yml:904-908`; Vercel                                                      | High                                |
| C-5     | DNS/TLS                  | Confirmed     | Apex CAA excludes `amazon.com`, which blocks the ACM cert for `api.learnix.school` when production is built                                                          | Cloudflare CAA records                                                           | High (blocks the fix)               |
| C-6     | CORS (symptom)           | Confirmed     | The browser reports CORS, but the cause is the 525. **Do not loosen CORS**                                                                                           | —                                                                                | Info                                |
| C-7     | DNS hygiene              | Confirmed     | `api-staging`, `staging` (and per the 10-13 audit a wildcard) still proxy to dead origins (525)                                                                      | Cloudflare records                                                               | Low                                 |
| C-8     | Release process          | Confirmed     | `main` is 1 commit ahead of `develop`; the branch-sync check fails silently                                                                                          | git                                                                              | Low                                 |
| H-1     | DNS                      | Probable      | The 525 origin is the decommissioned Railway backend (matches the 2026-10-13 finding and the Railway GitHub deployments)                                             | Cloudflare dashboard needed                                                      | —                                   |
| H-2     | Vercel env               | Probable      | Vercel Production sets `NEXT_PUBLIC_API_URL=https://api.learnix.school`. Inferred from the bundle, which also matches the CI default; not confirmed in the dashboard | Vercel project settings                                                          | —                                   |
| H-3     | Staging runtime          | Unverified    | Staging ECS/ALB/RDS are healthy _now_ (last verified 2026-10-13)                                                                                                     | AWS console / allowlisted IP                                                     | —                                   |
| H-4     | Frontend CI              | Probable      | Frontend CI failures are billing rejections, not code failures                                                                                                       | GitHub Billing                                                                   | —                                   |

**Not the cause (checked):** a wrong or stale API URL, localhost/staging URLs in the bundle, a route-prefix mismatch (the frontend sends `/api/v1`, matching `setGlobalPrefix('api/v1')`), the backend CORS allowlist (prod Terraform derives `https://learnix.school`; www redirects to the apex, so it needs no entry), a stale Vercel deployment, and the bind address and port (`0.0.0.0:3000` = `EXPOSE 3000` = Terraform `PORT=3000`). Service workers present (`firebase-messaging-sw.js`, `push-sw.js`) are push-only and cannot explain a 525.

---

## 7. Remediation plan (awaiting approval; nothing below has been done)

There is no small fix that makes production work today, because the production backend does not exist. You have to choose one option:

- **Option 1 (target state): build AWS production.** This follows `docs/phase6-production.md` / `phase7-launch.md`. It takes days, needs a new AWS account and provider approvals (SES, SMS), and its cost has already been estimated.
- **Option 2 (interim): point production at the existing AWS staging stack.** Not recommended. It would serve the public site from a single-AZ staging DB and test payment keys, and it needs the WAF and CORS opened to `learnix.school`. Use it only as an explicit, time-boxed decision.
- **Option 3 (honesty fix, minutes): stop advertising a dead API.** Show a maintenance or coming-soon state on `learnix.school` until Option 1 lands. You can combine it with Option 1.

### Phase A: fix the root cause (Option 1)

| Step                                                                                                                                                                                                                                                                     | Resource                         | Test                                                                                        | Rollback                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| A1 Create the production account (`org` apply) + bootstrap state/OIDC                                                                                                                                                                                                    | `learnix-infra/org`, `bootstrap` | `aws sts get-caller-identity` under the prod profile                                        | Account stays empty; close it                                           |
| A2 Fill `environments/production/backend.hcl` + `terraform.tfvars` (`domain_name=learnix.school`, `dns_provider=cloudflare`, `certificate_enabled=false`), then plan → apply                                                                                             | `environments/production`        | plan shows only intended resources; ECS `runningCount == desiredCount`; ALB targets healthy | `terraform destroy` (no data yet)                                       |
| A3 Cloudflare: add CAA `0 issue "amazon.com"`, then set `certificate_enabled=true` and add the ACM validation CNAME (DNS-only)                                                                                                                                           | Cloudflare                       | ACM `ISSUED`                                                                                | Remove the CAA/CNAME                                                    |
| A4 Set `certificate_validated=true` and apply. **Replace** the proxied `api` record with the DNS-only CNAME from `terraform output cloudflare_dns_records`. Keep the old record's value noted for rollback                                                               | Cloudflare `api`                 | `curl -I https://api.learnix.school/api/v1/health` = 200 with an Amazon cert                | Restore the noted record (the site returns to its current broken state) |
| A5 Create the GitHub env `production` (reviewers) + vars (`AWS_DEPLOY_ROLE_ARN`, `ECR_REPOSITORY_URL`, `ECS_CLUSTER`, `ECS_SERVICES`, `MIGRATE_FAMILY`, `TASK_NETWORK`, `AWS_REGION`, `API_URL`, `DEPLOY_ALARMS`, `SMOKE_FROM_RUNNER=true`) + infra plan/apply role vars | GitHub settings                  | `workflow_dispatch deploy production` runs migrate + rollout                                | `rollback` action with the previous task-def ARNs                       |
| A6 Supply `PAYMOB_BASE_URL` / EasyKash secrets and the remaining operator secrets for prod                                                                                                                                                                               | Secrets Manager                  | API boots (env validation passes)                                                           | Revert the secret version                                               |

### Phase B: frontend ↔ backend

- Confirm Vercel Production `NEXT_PUBLIC_API_URL=https://api.learnix.school` (no rebuild needed if already set; otherwise redeploy).
- Tests: the preflight from `Origin: https://learnix.school` returns `Access-Control-Allow-Origin: https://learnix.school` and `Access-Control-Allow-Credentials: true`; `/api/v1/marketplace/categories` returns 200 JSON; the marketplace shows no "Network error"; the console has no CORS errors.
- Rollback: Vercel "Promote" of the previous deployment.

### Phase C: database, auth, critical APIs

- `/api/v1/health/readiness` = 200 (DB + Redis). Check the migrate task's exit 0 and that its migration count matches the code (150+).
- With an account you create and authorize: `GET /auth/csrf-token` → login → cookie attributes (`Secure`, `HttpOnly`, `SameSite`) → `GET` a profile → logout. Check the CloudWatch logs for `CORS BLOCKED` warnings.
- No payments until the gateway is in live mode and approved.

### Phase D: CI/CD verification

- `ci-cd.yml`: when `deploy=false` on `main`/`develop`, write an explicit "NOT DEPLOYED: no app change" summary line. Optionally add a scheduled read-only production smoke job that fails loudly.
- Set `SMOKE_FROM_RUNNER=true` for production (it has no IP-allowlist WAF) and make a smoke failure trigger the rollback.
- `terraform.yml`: make a skipped plan for a configured environment a failure (or at least a warning annotation), not a silent success.
- Frontend: add a post-deploy check (Vercel deployment-success webhook or GitHub Action) that fetches `https://api.learnix.school/api/v1/health` and greps the build for the expected API origin.
- Fix GitHub Actions billing so frontend CI runs at all.
- Regression tests: unit tests for the routing script (infra-only push ⇒ summary says not deployed), plus `scripts/smoke-test.sh` against prod.

### Phase E: production re-test and stability

- Rerun section 4's test table. Watch the 24-hour ALB 5xx, unhealthy-targets and application-errors alarms. Check that ECS has no restarts and RDS CPU/connections are nominal.
- Clean up dead Cloudflare records (`api-staging`, `staging`, wildcard) only after confirming nothing uses them.

### Post-fix smoke tests (pass criteria)

1. `curl -sI https://api.learnix.school/api/v1/health` → 200, cert from Amazon.
2. `curl -s https://api.learnix.school/api/v1/health/readiness` → 200, DB and Redis ok.
3. Preflight from `https://learnix.school` → 204/200 with the exact-origin ACAO + credentials.
4. `curl -s https://api.learnix.school/api/v1/marketplace/categories` → 200 JSON.
5. Browser: marketplace loads data; zero console CORS or network errors.
6. Login/logout with an authorized test account.

---

## 8. Missing permissions or data

| Needed                                                                          | For                                                                                        |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| AWS credentials (staging profile, and a future prod account)                    | ECS/ALB/RDS/CloudWatch verification. The AWS MCP and CLI both reported no credentials      |
| An allowlisted IP for the staging WAF, or a temporary rule for the auditor's IP | Staging health/CORS tests                                                                  |
| Vercel login or token                                                           | Confirm the Production env vars, the domain assignment and the build logs                  |
| Cloudflare dashboard (read)                                                     | The actual origin target of `api.learnix.school` (confirms H-1) and the full record export |
| A test account + explicit authorization                                         | The login journey (Phase C)                                                                |
| Decision: Option 1 / 2 / 3                                                      | Starting remediation                                                                       |
