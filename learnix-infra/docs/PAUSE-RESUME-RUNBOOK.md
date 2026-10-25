# Pause / resume runbook (cost shutdown)

Scripts: `scripts/ops/pause-env.sh`, `scripts/ops/resume-env.sh`. Run by hand in **AWS Console CloudShell**
(eu-central-1, account `486940690416`, bash >= 4, aws CLI v2, GNU date, sha256sum). One environment per run.
Staging and production share the account, so the scripts identify the environment by name (`learnix-<env>-*`), the VPC
`Name` tag and the RDS `Environment` tag. Nothing is ever deleted; there is no new AWS automation.

## Commands (these are the real interfaces)
```bash
cd learnix-back/learnix-infra/scripts/ops               # git clone, or upload both files
bash pause-env.sh  --env staging                        # DRY-RUN (default): plan only, no lock, no manifest
bash pause-env.sh  --env staging --execute              # asks: pause learnix-staging in 486940690416
bash pause-env.sh  --env staging --execute --snapshot   # also take + verify an explicit pre-pause snapshot
bash pause-env.sh  --env production --execute --confirm-owner-checks
bash pause-env.sh  --env staging --status               # read-only: services, RDS, lock, manifest, 7-day clock
bash resume-env.sh --env staging --execute              # asks: resume learnix-staging in 486940690416
```
Typed confirmations: `pause learnix-<env> in 486940690416` / `resume learnix-<env> in 486940690416`. The **root user**
must additionally type `I AM ROOT` (root is an emergency fallback only; use the operator role below).

| Flag | pause | resume | Meaning |
|---|---|---|---|
| `--execute` | x | x | Apply (default is dry-run) |
| `--status` | x | x | Read-only report |
| `--snapshot` / `--no-snapshot` | x | | Explicit RDS snapshot before stop. Default: **yes for production, no for staging** |
| `--no-mute-alarms` | x | | Do not mute alarm actions |
| `--state-dir DIR` | x | x | Local manifest directory (default `~/learnix-pause`) |
| `--state FILE` | x | x | Use this manifest (must validate) instead of auto-selection |
| `--max-age-days N` | x | x | Accept an older open manifest (default 8) |
| `--force-baseline` | | x | Resume with repo defaults (api 1, worker 1) when NO valid manifest exists; never automatic |
| `--break-lock RUN_ID` | x | x | Break an **expired** stale lock (see below) |
| `--allow-maintenance-window` | x | x | Skip the maintenance-window guard |
| `--ignore-mediaconvert`, `--ignore-queues` | x | | Skip those in-flight-work checks (only after confirming by hand) |
| `--confirm-owner-checks` | x | | Required for `--execute` on production |
| `--verify-url URL`, `--skip-smoke` | | x | Smoke-test URL (production default `https://api.learnix.school`) |
| `--timeout S` | x | x | Wait limit per step (default 900) |

Exit codes: 0 ok/dry-run; 2 refused (guard, preflight, manifest, lock); 3 non-critical step failed; 4 critical failure;
5 pause post-verify failed / resume application unhealthy; 6 alarm actions could not all be restored.
A JSON summary is printed last (resume adds `infra_recovered`, `app_healthy`, `alarms_restored`).

## What protects you
- **Recovery manifest** `<env>-<run>.manifest` (local + `s3://learnix-<env>-logs-486940690416/ops/pause/<env>/`): immutable
  header (account, env, region, cluster, db, prior desired counts, scaling targets, every alarm's prior state, canary) closed
  by a SHA-256, then an append-only journal (`INTENT`/`DONE`/`STATUS`). It is written, validated and **uploaded + size-verified
  before the first change**, and re-uploaded after every phase. Note: the logs bucket expires objects after 90 days (staging)
  / 365 days (production); a manifest is only valid for 8 days anyway.
- **Selection**: `--state`, else the **oldest** valid manifest that is not `RESUMED` (the first pause holds the true values).
  An open manifest that fails validation (checksum, schema, account/env/region, file name, expired > 8 days, future date,
  malformed lines) **refuses the run (exit 2)**. Repo defaults are used only with `--force-baseline` on a paused environment.
- **Continue after a crash/failure**: run the same pause command again; it continues the open manifest. `resume` rolls back.
- **Lock** `ops/pause/<env>/LOCK` (S3 conditional write, 2 h TTL, renewed per phase, released on exit/INT/TERM/HUP).
  A crashed run (`kill -9`) leaves it. After it **expires** and RDS/ECS are idle (not mid-transition), use
  `--break-lock RUN_ID` (RUN_ID shown by the refusal or `--status`) and type `break lock RUN_ID`.
- **Alarm actions** are muted at pause and **always** restored by resume, even when health checks fail. If a pause fails
  while tasks still run, the alarms are re-enabled automatically; if the environment is already down they stay muted and the
  script says so loudly. Each failure is reported by name.
- **Maintenance window**: both databases use Sun 02:30-03:30 UTC. Pause/resume refuse within +-60 min of it.
- **Preflight (abort, exit 2)**: services steady with one deployment; no stray tasks (e.g. migrate); RDS available, no pending
  modification, restorable time < 15 min; production: last **COMPLETED** AWS Backup job < 26 h and DR (eu-west-1) replication
  `replicating`; Valkey available; no MediaConvert job SUBMITTED/PROGRESSING (account-wide); media/ses/sms queues empty.
- **Snapshot**: `create-db-snapshot` -> `wait db-snapshot-available` -> must be `available` and encrypted, otherwise RDS is
  **not** stopped (critical failure).

## Needs the owner (no AWS API can show it)
Valkey/BullMQ delayed or active jobs; payment-gateway webhooks (EasyKash/Paymob) failing while the API is down; scheduled
live sessions or campaigns; a release/deploy in flight. Production `--execute` requires `--confirm-owner-checks`.

## Behaviour observed on staging (2026-10-25)
Pause ~8 min (explicit snapshot ~5 min, stop ~4.5 min). Resume ~8-9 min: after `start-db-instance` RDS goes
`starting -> rebooting -> configuring-enhanced-monitoring -> available`, and **restarts itself again ~2 min after first
looking available**, so resume waits for 150 s of continuous `available` before starting ECS. A stop is logged as
"DB instance stopped". RDS crash-recovery on start is normal for PostgreSQL.

## The 7-day RDS clock
RDS starts a database that stayed stopped for 7 consecutive days. The manifest records `RDS_RESTART_DEADLINE`;
`--status` prints hours left, warns under 48 h, and warns if the manifest says PAUSED but RDS is `available` with no tasks
(it restarted itself and is billing compute). Set a calendar reminder for day 5 and re-run `pause-env.sh --execute`
(continues the same manifest, re-stops RDS).

## Still billed while paused (approximate, per month)
| | Production | Staging |
|---|---|---|
| NAT gateway + Elastic IP | ~$41 | none |
| Internal ALB | ~$20 | ~$20 |
| Valkey cache.t4g.micro (cannot be stopped) | ~$13 | ~$13 |
| WAF web ACL (us-east-1) | ~$5-10 | ~$5-10 |
| RDS storage, backups, DR copy, manual snapshots | ~$4-6 | ~$3 |
| Secrets, KMS, alarms, logs, S3, Backup vaults | ~$12 | ~$8 |
| CloudFront flat-rate plan (console subscription) | **verify in Billing**; Cost Explorer showed ~$0 for 1-24 Oct | – |

### Comparing real costs before/after
Cost Explorer lags ~24 h. Capture 3 full days before and 3 after (after a 48 h wait), credits/refunds excluded, per-day
averages, grouped by SERVICE and by the active `Environment` cost-allocation tag, and by usage type (NAT hours, LoadBalancer
hours, Fargate vCPU/GB hours, RDS instance hours):
```bash
aws ce get-cost-and-usage --time-period Start=YYYY-MM-DD,End=YYYY-MM-DD --granularity DAILY --metrics UnblendedCost \
  --filter '{"Not":{"Dimensions":{"Key":"RECORD_TYPE","Values":["Credit","Refund"]}}}' \
  --group-by Type=DIMENSION,Key=SERVICE Type=TAG,Key=Environment
```

## Rules while paused
- No `terraform apply` (it re-creates scaling targets/counts) and no push to `develop`/`main` (CI deploy fails on "no running task").
- Production is **down** (`api.learnix.school` errors); the Vercel frontend stays up. Do not pause during a deploy.
- Alarms `rds-free-storage-low` and `queue-backlog` treat missing data as breaching: this is why actions are muted.

## Manual rollback if resume fails
```bash
aws rds start-db-instance --db-instance-identifier learnix-<env>-pg
aws application-autoscaling register-scalable-target --service-namespace ecs --scalable-dimension ecs:service:DesiredCount \
  --resource-id service/learnix-<env>/<svc> --min-capacity <min> --max-capacity <max>     # only if a target exists
aws ecs update-service --cluster learnix-<env> --service <svc> --desired-count <SVC line of the manifest>
aws cloudwatch enable-alarm-actions --alarm-names <ALARM_PRE ... true lines of the manifest>
```
Prior task definitions (`:1`-`:3` prod, `:3` staging) stay ACTIVE.

## Operator role (recommended; not created yet)
`ops-pause-policy-staging.json` / `ops-pause-policy-production.json` (one role per environment) and
`ops-pause-trust-policy.json` (named user + MFA) are drafts, **not applied**. Items marked `VerifyNeeded` /
`VerifyResourceLevel` in the Sids are unresolved: whether `kms:CreateGrant`/`DescribeKey` is required for the snapshot, and
whether `application-autoscaling:RegisterScalableTarget` supports resource-level scoping (it needs
`iam:CreateServiceLinkedRole` if `AWSServiceRoleForApplicationAutoScaling_ECSService` does not exist; today it does not).
Validate every action with `aws iam simulate-principal-policy` and a staging run through the role before production.
