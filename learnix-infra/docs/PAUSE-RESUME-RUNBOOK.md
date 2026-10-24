# Pause / resume runbook (cost shutdown)

Scripts: `scripts/ops/pause-env.sh`, `scripts/ops/resume-env.sh`. Run by hand in **AWS Console CloudShell**
(region eu-central-1, account `486940690416`). Staging and production share that account, so the scripts decide the
environment by name (`learnix-<env>-*`), VPC `Name` tag and the RDS `Environment` tag, and ask you to type
`pause learnix-<env> in 486940690416` before changing anything. Nothing is ever deleted.

## Run it
```bash
git clone <repo-url> && cd <repo>/learnix-back/learnix-infra/scripts/ops   # or upload the two files
bash pause-env.sh  --env staging                 # dry-run: prints the plan only
bash pause-env.sh  --env staging --execute       # asks for the typed confirmation
bash pause-env.sh  --env staging --status        # read-only
bash resume-env.sh --env staging --execute
```
State is written to `~/learnix-pause/<env>-<time>.state` (CloudShell keeps `$HOME`) and copied to
`s3://learnix-<env>-logs-486940690416/ops/pause/`. A JSON summary is printed last. Exit codes: 0 ok/dry-run,
2 refused, 3 non-critical failure, 4 critical failure, 5 verification failed.

## What pause does / does not do
Does: mute `learnix-<env>-*` alarm actions, stop the canary if RUNNING, clamp App Auto Scaling targets (if any) to 0/0,
ECS desired count 0 (api, then worker), stop RDS (production first takes manual snapshot `pre-pause-<time>`).
Does not: Valkey, NAT gateway, ALBs, CloudFront, WAF, secrets, KMS, S3, AWS Backup, DNS, IAM, Terraform.

## Still billed while paused (approximate, per month)
| | Production | Staging |
|---|---|---|
| NAT gateway + Elastic IP | ~$41 | – (none) |
| Internal ALB | ~$20 | ~$20 |
| Valkey cache.t4g.micro (cannot be stopped) | ~$13 | ~$13 |
| WAF web ACL (us-east-1) | ~$5-10 | ~$5-10 |
| RDS storage, backups, eu-west-1 backup copy | ~$4-6 | ~$3 |
| Secrets, KMS, alarms, logs, S3, Backup vaults | ~$12 | ~$8 |
| CloudFront flat-rate plan (console subscription) | **~$200 if subscribed - verify in Billing** | – |

Biggest further savings need delete-and-recreate (NAT, ALB, Valkey). They are deliberately excluded; each would need
its own approved recovery plan.

## Rules while paused
- RDS **restarts by itself after 7 days**. The state file records the date; re-run `pause-env.sh` before then.
- Do not run `terraform apply` (it would re-create scaling targets / raise counts) and do not push to `develop`/`main`
  (the CI deploy fails on "no running task"). Resume first.
- Production is **down** (`api.learnix.school` errors) while paused; the Vercel frontend stays up.
- Do not pause during a deploy (check `ecs-deploy.sh --status`).
- Alarms `rds-free-storage-low` and `queue-backlog` treat missing data as breaching: this is why alarm actions are muted.

## Manual rollback if resume fails
```bash
aws rds start-db-instance --db-instance-identifier learnix-<env>-pg
aws application-autoscaling register-scalable-target --service-namespace ecs --scalable-dimension ecs:service:DesiredCount \
  --resource-id service/learnix-<env>/<svc> --min-capacity <min> --max-capacity <max>     # only if a target exists
aws ecs update-service --cluster learnix-<env> --service <svc> --desired-count 1
aws cloudwatch enable-alarm-actions --alarm-names <ALARM lines from the .state file>
```
Prior task definitions (`:1`-`:3` prod) stay ACTIVE.

## Permissions
Root works but has no guardrails and the account has no CloudTrail trail. Prefer a role with
`scripts/ops/ops-pause-role-policy.json` assumed from an MFA-protected console user (creating it is a separate,
explicitly approved change).
