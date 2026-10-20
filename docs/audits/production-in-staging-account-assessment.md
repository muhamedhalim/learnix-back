# Can production live in AWS account 4869…0416? Assessment

**Date:** 2026-10-18. **Status: assessment only.** The only AWS calls made were read-only (`sts get-caller-identity`, `list-*`, `describe-*`) using the existing local profile `learnix-staging`. Nothing was created, changed or applied; no DNS touched.

## 1. Verdict

**Account `486940690416` is the staging account**, so it is not a second, fresh account. Putting production in it is **technically possible but not safe "as the Terraform plan is written"**, and it contradicts the plan's own isolation model. **Recommendation: create a separate production account** (free; no cost penalty) and keep this one as staging. If you still prefer a single account, the steps and extra risks are in section 5.

## 2. Evidence that it is staging (live, read-only, 2026-10-18)

| Check                                                    | Result                                                                                                                                                                                                                                               |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sts get-caller-identity` with profile `learnix-staging` | account `4869…0416`, IAM user `learnix-terraform`                                                                                                                                                                                                    |
| Repo documents                                           | `learnix-infra/docs/INITIAL-AWS-DEPLOYMENT.md` and `AWS-COST-ESTIMATE.md` name this account as the staging account; the 2026-10-16 GitHub `staging` environment variables point at it                                                                |
| ECS                                                      | one cluster, `learnix-staging`                                                                                                                                                                                                                       |
| RDS                                                      | `learnix-staging-pg`, db.t4g.micro, single-AZ, available                                                                                                                                                                                             |
| VPCs                                                     | `learnix-staging` 10.10.0.0/16, plus the unused default VPC 172.31.0.0/16                                                                                                                                                                            |
| S3                                                       | `learnix-staging-{files,logs,tfstate,video-output,video-source}-4869…0416`                                                                                                                                                                           |
| Secrets Manager                                          | `learnix/staging/*` (core, valkey, paymob, meta-whatsapp, meetings, vapid, cloudfront-signing) and the RDS-managed master secret                                                                                                                     |
| CloudFront                                               | `E1BTQT8D6RRQQ3` / `dz8egx08r1ti9.cloudfront.net`, no custom alias                                                                                                                                                                                   |
| IAM                                                      | OIDC provider for GitHub **already exists**; roles `learnix-gha-plan`, `learnix-gha-apply`, `learnix-staging-gha-deploy-api` and the staging task roles; one IAM user (`learnix-terraform`) with **one active static access key created 2026-10-13** |
| SES                                                      | no identities; **sandbox** (`ProductionAccessEnabled=false`, 200/day)                                                                                                                                                                                |
| Budgets / NAT                                            | no budgets; no NAT gateway (staging uses public IPs)                                                                                                                                                                                                 |
| Profile `learnix-production`                             | does not exist on this workstation                                                                                                                                                                                                                   |

## 3. Collisions and conflicts if production is applied here

| #   | Item                                                            | Evidence                                                                                                                                                                | Effect                                                                                                                                                                                             |
| --- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Fixed IAM role names `learnix-gha-plan` and `learnix-gha-apply` | `bootstrap/main.tf:229,379` (no environment in the name); both roles already exist, owned by the **staging bootstrap state**                                            | A second bootstrap run **fails with EntityAlreadyExists**. Renaming them in code makes the next staging bootstrap plan **replace the staging roles** and breaks the staging CI variables and trust |
| 2   | GitHub OIDC provider                                            | `create_oidc_provider` default true; one per account (exists)                                                                                                           | Must be `false` for a production bootstrap                                                                                                                                                         |
| 3   | Apply-role trust is `environment:infra-<env>`                   | `bootstrap/main.tf:290`                                                                                                                                                 | Staging and production would need two apply roles with distinct names (see 1)                                                                                                                      |
| 4   | Bootstrap workspace                                             | `bootstrap/.terraform` is initialised against the staging state bucket                                                                                                  | Already handled by the isolated-copy rule in plan v2                                                                                                                                               |
| 5   | Resource names                                                  | Everything else is prefixed `learnix-<env>` / `learnix/<env>/…` (state bucket, KMS alias, VPC `10.20.0.0/16` vs `10.10.0.0/16`, ECS, RDS, ALB, secrets, SG, log groups) | **No collision** (checked in `bootstrap`, `environments/*`, `modules/*`)                                                                                                                           |
| 6   | SES                                                             | staging has no domain identity (`domain_name` unset); production creates `learnix.school`                                                                               | No collision, but SES **production access is per account**: granting it for production also lifts the sandbox for staging. Staging's only guard would be the app-level `MAIL_ALLOWLIST`            |
| 7   | Account-wide settings                                           | Application Signals discovery, Container Insights, service quotas (Fargate vCPUs, EIPs, VPCs, CloudFront), budgets                                                      | Shared; production load can exhaust staging's quota headroom and the reverse                                                                                                                       |
| 8   | Application Signals / RUM / GuardDuty                           | already enabled for staging                                                                                                                                             | Fine, shared                                                                                                                                                                                       |

## 4. Risks of a single account (ranked)

1. **IAM blast radius (high).** The apply role and the `learnix-terraform` user are account-wide admin. A staging mistake, a leaked key (a static key exists today) or a compromised staging pipeline reaches production data, secrets and the encryption keys. Plan v2's acceptance check "no IAM user or key in the production account" cannot hold here without removing staging's current access path.
2. **Public-repo Terraform plans (medium).** The staging plan role trusts pull requests and has `ReadOnlyAccess` on the whole account (it lists, and reads S3 objects without KMS). Production data in KMS-encrypted buckets/secrets would remain protected by its own key policy, but logs, resource names and the unencrypted ALB-log bucket would be in reach. Not verified end to end.
3. **Wrong-target applies (medium).** Neither stack sets `allowed_account_ids`, and both use the same credentials, so a mistyped directory or backend is production-impacting rather than staging-only.
4. **Shared SES sandbox (medium)**, shared quotas (low-medium), one budget needing tag filters (low).
5. **Rollback is harder (medium).** "Close the account" is no longer a rollback; teardown means selective destroys beside live staging.
6. **Staging changes required.** Fixing collisions 1–3 means editing the bootstrap module that staging's state owns: this contradicts the earlier instruction not to modify the existing staging account.

## 5. If you still want one account: isolation plan

Gated like the rest of Phase A, none executed:

1. **Code change (repo only):** bootstrap gets environment-qualified role names (`learnix-production-gha-plan/apply`), `create_oidc_provider=false` for production, and a `moved`/import-safe path so the **staging roles keep their current names** (do not rename staging).
2. Add `allowed_account_ids` to both environments' providers, and a CI/local guard before every command.
3. Separate state bucket and key (already `learnix-production-tfstate-…`).
4. Replace the static `learnix-terraform` key with short-lived access (IAM Identity Center or role + MFA); delete the key (needed anyway at J4).
5. Restrict the staging plan role (PR-triggered) with an explicit deny on `learnix-production-*`/`learnix/production/*` resources.
6. Account-level budget plus the cost-allocation tag `Environment` filter; Service Quotas check for Fargate vCPU and EIPs.
7. Agree that SES production access will make staging mail depend on the app allowlist only.
8. Everything else follows plan v2 unchanged.

## 6. Costs

|                                                         | Separate account (recommended)                                                        | Same account                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Production infrastructure (L1, from `LAUNCH-SIZING.md`) | ≈ $182–215/mo                                                                         | same                                                                                                  |
| Staging (already running)                               | ≈ $78–100/mo (repo estimate)                                                          | same                                                                                                  |
| Account fee                                             | $0                                                                                    | $0                                                                                                    |
| Support plan                                            | Business/Developer plans are billed per account [UNV]; none is assumed in either case | one plan covers both                                                                                  |
| Extra work                                              | account creation (console, ~30 min), second bootstrap, second set of budgets          | code change + review + staging-role safeguards                                                        |
| **Net monthly difference**                              | **≈ $0**                                                                              | **≈ $0** (a shared account saves nothing: each environment already has its own VPC, NAT, RDS, Valkey) |

Isolation costs nothing in AWS spend, so the single-account option saves only a console session and costs more engineering and risk.

## 7. Recommendation and what I need

- **Create a new standalone account for production** (new root email, new MFA, no keys) and give me its ID; this account stays staging. This matches decision D1 and the plan unchanged.
- If you instead decide "same account", say so explicitly and I will prepare the section 5 code change as a proposal for your review, before any AWS action.
- Either way, B2 (short-lived access) is needed, and the existing `learnix-terraform` static key should be retired (staging step, separate approval).
