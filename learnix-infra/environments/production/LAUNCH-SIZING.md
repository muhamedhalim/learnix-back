# Production launch sizing — cost comparison (PROPOSAL, nothing applied)

**Date:** 2026-10-18. **Region:** eu-central-1 (Frankfurt), plus us-east-1 (CloudFront certificate, WAF, WAF logs) and eu-west-1 (backup copies), as the IaC defines. **Status:** proposal only. No Terraform file, tfvars, GitHub variable or AWS resource was changed.

## 0. Pricing sources and rules used

| Source | What it gave | Status |
|---|---|---|
| AWS Price List bulk API, `pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<service>/current/eu-central-1/index.json`, downloaded 2026-10-18 (RDS publication 2026-10-06, ElastiCache 2026-10-14, ECS 2026-09-11, ELB 2026-09-11, VPC 2026-10-16, WAF 2026-09-14, CloudWatch 2026-10-07, Secrets Manager 2026-09-11, ECR 2026-09-11) | On-demand unit prices marked **[PL]** below | **Fetched** |
| `learnix-infra/AWS-COST-ESTIMATE.md` (repo, 2026-10-10/13) | CloudFront flat-rate Business plan $200/mo, Synthetics $0.0012/run, RUM $1/100k events, the $481–515 baseline | **Repo estimate**, not re-verified |
| Public AWS pricing pages (my knowledge, not fetched: the EC2 price file holding NAT is 434 MB) | NAT gateway $0.052/h + $0.052/GB; KMS $1/key-month; CloudFront always-free tier 1 TB + 10 M requests/month | **Unverified**, marked **[UNV]**. Check in the Pricing Calculator |
| Container Insights (enhanced), Application Signals / X-Ray, GuardDuty | Not priced here | **Estimate ranges only**, marked **[EST]** |

Assumptions: 730 h/month, on-demand, USD, no tax, no Savings Plans/RIs, no AWS Support plan, no free tier except CloudFront's always-free allowance. **Launch traffic is unknown** (there is no production baseline), so every usage line is a range. Vercel, GitHub, Cloudflare and EasyKash are outside this model.

### Unit prices used

| Item | Unit price | Src |
|---|---|---|
| Fargate ARM | $0.03725 per vCPU-h + $0.00409 per GB-h → a 0.5 vCPU / 1 GB task = $0.022715/h = **$16.58/mo** | [PL] |
| RDS PostgreSQL db.t4g.micro | $0.019/h Single-AZ · $0.037/h Multi-AZ | [PL] |
| RDS PostgreSQL db.t4g.small | $0.037/h Single-AZ · $0.074/h Multi-AZ | [PL] |
| RDS PostgreSQL db.t4g.medium | $0.074/h Single-AZ · $0.149/h Multi-AZ | [PL] |
| RDS gp3 storage | $0.137/GB-mo Single-AZ · $0.274/GB-mo Multi-AZ | [PL] |
| RDS backup/snapshot storage beyond the free allocation | $0.103/GB-mo | [PL] |
| ElastiCache Valkey cache.t4g.micro / small | $0.0144/h / $0.0288/h per node | [PL] |
| ALB | $0.027/h + $0.008 per LCU-h | [PL] |
| Public IPv4 address | $0.005/h (= $3.65/mo) | [PL] |
| VPC interface endpoint | $0.012/h per AZ + $0.01/GB | [PL] |
| WAF | $5/web ACL-mo + $1/rule-mo + $0.60/M requests | [PL] |
| CloudWatch | logs ingest $0.63/GB, storage $0.0324/GB-mo, $0.30/metric, $0.10/alarm | [PL] |
| Secrets Manager | $0.40/secret-mo | [PL] |
| ECR | $0.10/GB-mo | [PL] |
| NAT gateway | $0.052/h (= $37.96/mo) + $0.052/GB processed | [UNV] |
| KMS customer key | $1/key-mo | [UNV] |

## 1. What the current IaC actually provisions (evidence)

| Component | Current production setting | File |
|---|---|---|
| api service | 0.5 vCPU / 1 GB, `min_count = 2` (hard-coded), `max_count = 6`, ARM64, private subnets | `apps.tf:216-228` |
| worker service | 0.5 vCPU / 1 GB, `min_count = 1`, `max_count = var.worker_max_count` (4) | `apps.tf:250-262` |
| migrate | one-shot task, 0.5 vCPU / 1 GB, run per deploy | `apps.tf:287-300` |
| ADOT / CloudWatch agent sidecar | inside the task size (64 CPU units, 128 MiB) when `application_signals_enabled` (default **true**) | `modules/ecs-service/variables.tf:138-139` |
| ECS cluster | Container Insights **enhanced**, FARGATE only (no Spot) | `modules/ecs-cluster/main.tf:6-7,20` |
| RDS | `var.db_instance_class` (db.t4g.small), **`multi_az = true` hard-coded**, 20 GB gp3 autoscaling to 100 GB, 14-day PITR, deletion protection, final snapshot, Performance Insights 7 d (free tier), Enhanced Monitoring 60 s | `foundation.tf:136-151`, `modules/database/*` |
| RDS DR | automated-backup replication to eu-west-1, 14 days, own KMS key | `foundation.tf:153-160` |
| Valkey | `cache.t4g.micro`, **`node_count = 2` hard-coded** (primary + replica, automatic failover, Multi-AZ), TLS required, 7-day snapshots | `foundation.tf:162-175`, `modules/cache/main.tf:74-89` |
| NAT | `nat_gateway_count` = 1 (variable), 1 EIP | `variables.tf:192-196`, `modules/network/main.tf:85-111` |
| ALB | internal, deletion protection, access logs to S3, health check `/api/v1/health` | `edge.tf:59-76`, `modules/alb/main.tf` |
| CloudFront | VPC origin to the internal ALB, `PriceClass_All` (Egypt edges), WAF attached | `modules/cdn/main.tf:33-483` |
| WAF | 1 web ACL, 2 rate rules + 3 AWS managed groups (Common, KnownBadInputs, IpReputation), COUNT until `waf_block`; logs to CloudWatch (us-east-1) | `modules/cdn/main.tf:177-372`, `variables.tf:89-96` |
| Observability | ~15 alarms, SNS topic, dashboard, log metric filter, RUM (25 % sampling), Synthetics canary (**off** until `canary_enabled`) | `observability.tf`, `modules/observability/main.tf` |
| AWS Backup | daily (35 d) + monthly (365 d) of RDS + files bucket, daily copy to an eu-west-1 vault, deny-delete vault policy | `observability.tf:47-70`, `modules/backup/main.tf` |
| Secrets | 10 containers: 6 external (`easykash`, `paymob` *(retired, empty)*, `meta-whatsapp`, `vapid`, `cloudfront-signing`, `meetings`) + `core`, `db-app`, Valkey AUTH, RDS-managed master | `modules/secrets/main.tf` |
| KMS | 3 keys (data, WAF logs us-east-1, DR eu-west-1) + 1 bootstrap state key | `foundation.tf:25-56`, `bootstrap/main.tf` |
| GuardDuty / Config / Security Hub | **not** in the production stack (they live in `org/`, which is deferred) | — |
| CloudFront flat-rate plan | **not** in Terraform; a console subscription the old plan assumed ($200/mo) | `edge.tf:93-94`, `AWS-COST-ESTIMATE.md` |

## 2. Configurations compared

| Line (USD/month) | **B0** Documented baseline | **B1** Current IaC, pay-as-you-go CloudFront | **I1** Intermediate (tfvars only) | **L1** Lean launch (needs reviewed code change) |
|---|---|---|---|---|
| CloudFront flat-rate Business plan | 200 | 0 (not subscribed) | 0 | 0 |
| CloudFront pay-as-you-go | — | ~0 inside the free tier [UNV] | ~0 [UNV] | ~0 [UNV] |
| api tasks | 2 × 16.58 = 33.17 | 33.17 | 33.17 | **1** × 16.58 = 16.58 |
| worker tasks | 16.58 | 16.58 | 16.58 | 16.58 |
| RDS instance | small Multi-AZ 54.02 | 54.02 | 54.02 | **small Single-AZ 27.01** |
| RDS storage 20 GB | 5.48 | 5.48 | 5.48 | 2.74 |
| Valkey | 2 × 10.51 = 21.02 | 21.02 | 21.02 | **1** × 10.51 |
| ALB hours | 19.71 | 19.71 | 19.71 | 19.71 |
| NAT hours + EIP | 37.96 + 3.65 | 41.61 | 41.61 | 41.61 |
| WAF (ACL + 5 rules) | in the flat-rate plan | 10.00 | 10.00 | 10.00 |
| Secrets (10) | 4.00 | 4.00 | 4.00 | 4.00 |
| KMS (4 keys) | ~4 | ~4 | ~4 | ~4 |
| Alarms + custom metrics | ~3 | ~3 | ~3 | ~3 |
| **Fixed subtotal** | — | **≈ 212.8** | **≈ 212.8** | **≈ 155.8** |
| ALB LCU (usage) | | 1–6 | 1–6 | 1–6 |
| NAT data, 20–50 GB (usage) [UNV] | | 1–3 | 1–3 | 1–3 |
| RDS backup + DR replica + Enhanced Monitoring (usage, tiny DB) | | 1–3 | 1–3 | 1–3 |
| CloudWatch Logs (3–10 GB app + flow + WAF) | | 3–10 | 3–10 | 3–10 |
| Container Insights enhanced [EST] | | 5–15 | 5–15 | 5–15 |
| Application Signals + X-Ray [EST] | | 3–15 | **0 (disabled)** | **0 (disabled)** |
| Synthetics canary (after cutover, 5-min interval) | | 10.4 | 10.4 | 10.4 |
| RUM (25 % sampling) | | 1–5 | 1–5 | 1–5 |
| AWS Backup + cross-region copy (tiny data) | | 1–3 | 1–3 | 1–3 |
| ECR + S3 (images, files, logs) | | 1–2 | 1–2 | 1–2 |
| MediaConvert / SES / SMS | 38+ | 0 until used | 0 | 0 |
| **Estimated total** | **≈ 481–515** (repo doc) | **≈ 240–290** | **≈ 237–275** | **≈ 182–215** |
| Code change needed | — | none | none (`application_signals_enabled = false`) | yes: 3 new variables (section 4) |

Usage lines scale with traffic: MediaConvert is ≈ $2.55 per content-hour transcoded (repo doc) and appears as soon as teachers upload video. CloudFront leaves the free tier above 1 TB or 10 M requests per month. Both are the first lines to watch.

### Considered and rejected for launch

| Option | Saving | Why rejected |
|---|---|---|
| No NAT (tasks in public subnets with public IPs) | ≈ −34/mo net (NAT − 2–3 public IPv4) | Code change to `apps.tf` network config. It reverses the deliberate private-subnet design (`foundation.tf:61-62`) and the static egress IP that EasyKash/Meta allowlisting relies on. Tasks would get internet-routable addresses (inbound still blocked by the SG) |
| No NAT + VPC interface endpoints | none (more expensive) | ECR api+dkr, Logs, Secrets Manager, STS, SQS, CloudWatch, SES ≈ 8 endpoints × 2 AZ × $8.76 ≈ $140/mo [PL] |
| db.t4g.micro (1 GB RAM) | −13.5 (Single-AZ) | DB pool is 10/process (`app.module.ts:305`); api+worker+migrate ≈ 30–40 connections fit, but 1 GB leaves little memory for shared buffers. Staging runs it, but staging has no load. Acceptable only as a conscious later trim |
| Removing WAF | −10 | Removes the only edge protection on a public API. Not offered |
| Disabling backups / DR copy / deletion protection | −2–5 | Data-loss risk for a negligible saving. Not offered |
| Fargate Spot | variable | `capacity_providers = ["FARGATE"]` only. A Spot interruption of the single api task in L1 is an outage |
| Container Insights `enabled` instead of `enhanced` | −(3–10) [EST] | Possible later; needs a module change (`modules/ecs-cluster/main.tf:6-7`), which affects staging too. Not in launch scope |

## 3. Trade-offs

| Area | B1 / I1 | L1 |
|---|---|---|
| API availability | 2 tasks over 2 AZs: survives the loss of a task or an AZ | 1 task: a task crash or an AZ event is an outage until ECS reschedules it (typically 1–3 min, longer during an AZ event). Deploys stay zero-downtime (`deployment_minimum_healthy_percent = 100`, `maximum = 200`) |
| Database | Multi-AZ synchronous standby, automatic failover (~1–2 min) | Single-AZ: host failure means RDS recovers the instance (minutes, can be longer); an AZ outage means a point-in-time restore into another AZ. RPO stays ≈ 5 min (PITR). Backups, the DR copy, deletion protection and the final snapshot are **unchanged** |
| Valkey | Replica + automatic failover | 1 node: on node failure ElastiCache replaces it (minutes), and BullMQ jobs and cache since the last daily snapshot are lost. `/api/v1/health/readiness` checks Redis (`health.service.ts:52-90`), so the API reports not-ready. The ALB uses liveness (`/api/v1/health`), so tasks keep serving cached/DB paths, while rate limiting and queues degrade |
| Tracing | I1/L1 drop X-Ray/Application Signals. Logs, metrics, alarms, RUM and the canary remain | same |
| Security | identical: private subnets, WAF, TLS to RDS/Valkey, KMS, least-privilege roles | identical |
| Scaling | autoscaling api 2..6, worker 1..4 | api 1..6, worker 1..4. Autoscaling still adds tasks under CPU load |
| Upgrade path | — | Each lean setting is one variable flip: RDS Single→Multi-AZ is an online modification (I/O impact while the standby is created; schedule it), Valkey 1→2 nodes adds a replica online, api min 1→2 is immediate |

**Can L1 support the first launch?** Yes, for a launch **without payments, production email or SMS** and with negligible measured traffic, which is the case today (no production users; the Railway production has been down since 2026-08-13). Its limitation is availability, not capacity: a single task or AZ failure becomes a user-visible outage of minutes. **Upgrade triggers (move to I1 values before any of them):** enabling EasyKash payments, the first paying users, or sustained API p95 > 500 ms / CPU > 60 %.

## 4. Proposed code change for L1 (NOT applied, NOT tested)

L1 needs three variables, because the current values are hard-coded. The defaults reproduce today's behavior exactly, so B1/I1 and the existing tests are unaffected. Applying this patch is a separate approved step (Phase A0 in the revised plan). When applied, it must pass `terraform validate`, the existing 7 mocked tests, and a new mocked test for `api_min_count = 1`, `db_multi_az = false`, `valkey_node_count = 1`. An attempt to stage it temporarily for offline testing was blocked by this session's safety controls, so it is untested.

```diff
--- a/learnix-infra/environments/production/apps.tf
+++ b/learnix-infra/environments/production/apps.tf
@@ module "api"
-  min_count        = 2
+  min_count        = var.api_min_count
--- a/learnix-infra/environments/production/foundation.tf
+++ b/learnix-infra/environments/production/foundation.tf
@@ module "database"
-  multi_az                  = true
+  multi_az                  = var.db_multi_az
@@ module "cache"
-  node_count                = 2
+  node_count                = var.valkey_node_count
--- a/learnix-infra/environments/production/variables.tf
+++ b/learnix-infra/environments/production/variables.tf
+variable "api_min_count" {
+  description = "Minimum api tasks once scaled up. 2 = both AZs; 1 = lean launch (a task/AZ failure is an outage until ECS replaces it)."
+  type        = number
+  default     = 2
+  validation {
+    condition     = var.api_min_count >= 1 && var.api_min_count <= 6
+    error_message = "api_min_count must be 1..6."
+  }
+}
+variable "db_multi_az" {
+  description = "RDS Multi-AZ standby with automatic failover. false = lean launch (no standby)."
+  type        = bool
+  default     = true
+}
+variable "valkey_node_count" {
+  description = "2 = primary + replica with automatic failover; 1 = lean launch (no failover)."
+  type        = number
+  default     = 2
+  validation {
+    condition     = var.valkey_node_count >= 1 && var.valkey_node_count <= 3
+    error_message = "valkey_node_count must be 1..3."
+  }
+}
```

Things to check when it is applied:
- `aws_db_instance.multi_az` false → true later is an in-place modification (`apply_immediately = false` defers it to the maintenance window unless overridden).
- `modules/cache` derives `automatic_failover_enabled` and `multi_az_enabled` from `node_count > 1` (`modules/cache/main.tf:75-76`), so 1 node is valid.
- The checkov skip comments in `modules/database/main.tf:98-99` already treat Multi-AZ as a per-environment decision. The repository's conftest policies (`learnix-infra/policies`) must be re-run against the real plan, because a policy may require Multi-AZ in production. **Not verified.**

## 5. Recommendation and spending ceiling

| | Recommendation |
|---|---|
| Launch configuration | **L1** if the ≈ $55/month saving over I1 is worth minutes-scale outages before payments go live. **I1** if you prefer zero code changes and full HA from day one. Both keep WAF, backups, DR copy, deletion protection, alarms, RUM and the canary |
| Not recommended now | Subscribing the CloudFront flat-rate Business plan ($200/mo). Staging's distribution was created with a VPC origin, and `docs/INITIAL-AWS-DEPLOYMENT.md` records no plan subscription. That is **probable** (not confirmed) evidence that VPC origins work on pay-as-you-go, contrary to the "Business-tier feature" note in `AWS-COST-ESTIMATE.md`. Confirm in the console (staging distribution → pricing plan) before relying on it. Revisit when video traffic approaches the free tier |
| Budget (create at account creation, before any billable resource) | AWS Budgets monthly cost budget **$250 for L1** (or **$300 for I1**), alerts at 50 / 80 / 100 % actual and 100 % forecast, plus a Cost Anomaly Detection monitor (≈ $20 impact). `org/budgets.tf` will **not** run in a standalone account, so this is a console step (or a later Terraform change) |
| Hard ceiling to stop and review | Any month forecast > **$350**, or MediaConvert > $50 |
| Re-forecast | Days 7, 30, 60 from Cost Explorer by the `Environment`/`Component` tags (activate the cost-allocation tags in Billing first) |

## 6. Launch tfvars

See `launch.tfvars.example` in this directory: the **I1** shape using existing variables only, plus a commented-out L1 block that requires the section 4 change. It is not loaded by Terraform (not `terraform.tfvars` or `*.auto.tfvars`). Placeholders `__REQUIRED_…__` must be replaced by real values supplied by you. A plan must not run while any placeholder remains.
