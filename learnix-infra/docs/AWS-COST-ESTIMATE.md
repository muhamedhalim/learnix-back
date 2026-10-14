# Learnix staging: AWS cost estimate (actual planned configuration)

Date: 2026-10-13. Account `486940690416`, region `eu-central-1`. Scope: the `environments/staging` stack as
planned (183 resources, 0 changes, 0 destroys) plus the already-applied `bootstrap/` stack. Production is not
included. All prices are USD, on-demand, list price (no Free Tier, credits or discounts assumed).

> This file supersedes the generic staging figures in `../AWS-COST-ESTIMATE.md` (repository root), which were
> written before a plan existed. Update this file whenever sizes or resources change.

## 1. Summary

| Scenario | Monthly | Annual (x12) | What it means |
|---|---|---|---|
| Idle (`api_desired_count = 0`, as first applied) | **$69.90** | $839 | All fixed resources exist, no API task, no traffic |
| Low (1 task, 24/7, 100k requests, 1 GB logs) | $92.03 | $1,104 | One tester, light use |
| **Expected (1 task, 24/7, 500k requests, 2.5 GB logs)** | **$96.95** | **$1,163** | Normal QA / integration use |
| High (2 tasks, 5M requests, 50 GB CloudFront, 15 GB logs, 15M signals) | $173.97 | $2,088 | Load test week; still below $200 |

**Policy check:** the steady-state expected cost ($97) and the high case ($174) are below the USD 200 per month
limit. Roughly 72 % of the expected cost is fixed (hourly) and does not depend on traffic.

**First month:** deployment starts 2026-10-13. 19 of 31 days remain in October, and the API runs 0 tasks until
the image is pushed (same day). Expected October bill: about 19/31 x $97 = **about $59**, plus the bootstrap KMS key
(about $1). The first full month (November) is the steady-state figure.

## 2. Fixed hourly costs (independent of traffic)

730 hours per month, 24/7. Single-AZ data stores, no NAT gateway.

| Service / resource | Configuration | Qty | Hours | Unit price (source) | Formula | Monthly |
|---|---|---|---|---|---|---|
| ALB | internal, application | 1 | 730 | $0.0270 / h (Price List API, `EUC1-LoadBalancerUsage`) | 730 x 0.027 | $19.71 |
| RDS PostgreSQL 16.9 | db.t4g.micro, single-AZ | 1 | 730 | $0.019 / h (`EUC1-InstanceUsage:db.t4g.micro`) | 730 x 0.019 | $13.87 |
| RDS storage | gp3, 20 GB allocated (autoscale to 100 GB) | 20 GB | - | $0.137 / GB-month (`EUC1-RDS:GP3-Storage`) | 20 x 0.137 | $2.74 |
| ElastiCache Valkey 8.0 | cache.t4g.micro, 1 node, no replica | 1 | 730 | $0.0144 / h (`EUC1-NodeUsage:cache.t4g.micro`) | 730 x 0.0144 | $10.51 |
| ElastiCache snapshot | 1 daily snapshot, tiny | - | - | assumption | - | $0.10 |
| WAF (CloudFront scope) | 1 web ACL + 6 rules (allowlist, 2 rate-based, 3 AWS managed groups) | 1 + 6 | - | $5 per ACL + $1 per rule (Price List: "Price per WebACL", "Price per Rule") | 5 + 6 x 1 | $11.00 |
| KMS | 2 customer-managed keys (data, WAF logs) | 2 | - | $1 / key-month | 2 x 1 | $2.00 |
| Secrets Manager | 7 Terraform secrets + RDS-managed master secret | 8 | - | $0.40 / secret (Price List) | 8 x 0.40 | $3.20 |
| CloudWatch alarms | 17 standard + 1 anomaly-detection (3 metrics) | 18 | - | $0.10 / alarm; anomaly = 3 x $0.10 (published rate, not re-queried) | 17 x 0.10 + 0.30 | $2.00 |
| CloudWatch custom metrics | queue backlog + 3 log-metric filters | 4 | - | $0.30 / metric (`EUC1-CW:MetricMonitorUsage` 0-10k) | 4 x 0.30 | $1.20 |
| CloudWatch dashboard | 1 | 1 | - | $3 / dashboard (published; first 3 per account are free, not assumed) | 1 x 3 | $3.00 |
| ECR | 1 repo, about 0.5 GB of images | - | - | $0.10 / GB-month (published) | 0.5 x 0.10 | $0.05 |
| **Fixed subtotal (idle)** | | | | | | **about $68.4** |

Idle total of $69.90 additionally contains small usage items (logs, requests, misc).

## 3. Compute that exists only while a task runs

`api_desired_count = 1`; task = 0.5 vCPU / 1 GiB, ARM64, includes the Application Signals sidecar and init container.

| Item | Qty | Hours | Unit price (source) | Formula | Monthly |
|---|---|---|---|---|---|
| Fargate vCPU (ARM) | 0.5 | 730 | $0.03725 / vCPU-h (`EUC1-Fargate-ARM-vCPU-Hours:perCPU`) | 0.5 x 730 x 0.03725 | $13.60 |
| Fargate memory (ARM) | 1 GiB | 730 | $0.00409 / GB-h (`EUC1-Fargate-ARM-GB-Hours`) | 1 x 730 x 0.00409 | $2.99 |
| Fargate ephemeral storage | 20 GiB default | - | included up to 20 GiB | - | $0.00 |
| Public IPv4 on the task ENI (no NAT gateway, so tasks get a public IP) | 1 | 730 | $0.005 / h (`EUC1-PublicIPv4:InUseAddress`) | 730 x 0.005 | $3.65 |
| **Subtotal per running task** | | | | | **$20.24** |

Two tasks (high scenario) double this to $40.48. The migrate task is one-off (about 5 minutes: under $0.01).

## 4. Traffic-dependent costs (expected scenario)

| Item | Assumption | Unit price | Monthly |
|---|---|---|---|
| ALB LCU | 0.25 LCU average | $0.008 / LCU-h | $1.46 |
| CloudFront data out | 5 GB | $0.085 / GB (published, EU first 10 TB; not re-queried) | $0.43 |
| CloudFront HTTPS requests | 500k | $0.012 / 10k (published) | $0.60 |
| WAF requests | 500k | $0.60 / million (Price List) | $0.30 |
| CloudWatch Logs ingest | 2.5 GB (API, WAF, flow, RDS OS metrics) | $0.63 / GB (`EUC1-DataProcessing-Bytes`; WAF logs use the vended-log tier at the same first-tier rate) | $1.57 |
| CloudWatch Logs storage | 30-day retention | $0.0324 / GB-month (`EUC1-TimedStorage-ByteHrs`) | $0.08 |
| CloudWatch RUM | 50k events (100 % sampling) | $0.00001 / event (`EUC1-CW:RUM-events`) | $0.50 |
| Application Signals | 1M signals | $1.50 / million, first tier (Price List `EUC1-Application-Signals`; tier boundaries not verified) | $1.50 |
| KMS requests | low | $0.03 / 10k | $0.10 |
| SQS, SNS, EventBridge, S3 requests, misc | low | free tiers largely cover | $0.50 |
| Inter-AZ and outbound transfer | 10 GB | $0.01 / GB per direction; $0.09 / GB out (published) | $0.30 |
| **Subtotal** | | | **$7.4** |

Expected total = 68.4 (fixed) + 20.24 (task) + 7.4 (traffic) + 0.9 (small items) = **$96.95**.

## 5. Scenario assumptions

| Item | Idle | Low | Expected | High |
|---|---|---|---|---|
| Tasks | 0 | 1 | 1 | 2 |
| Requests / month | 10k | 100k | 500k | 5M |
| CloudFront GB out | 0 | 1 | 5 | 50 |
| Log ingest GB | 0.3 | 1 | 2.5 | 15 |
| App Signals signals | 0 | 0.2M | 1M | 15M |
| RUM events | 0 | 10k | 50k | 500k |
| ALB LCU | 0 | 0.1 | 0.25 | 1.0 |
| Extra RDS storage/backup | 0 | 0 | 0 | $3 |

All scenarios assume: 24/7 operation, single-AZ (no Multi-AZ), 7-day RDS backups (free up to the allocated
storage), 30-day log retention, Performance Insights 7-day tier (free), staging-sized data (synthetic).

## 6. One-time, recurring and optional

* **One-time setup costs:** none. No setup fees, no commitments, no Savings Plans or Reserved Instances.
* **Recurring:** everything above. The bootstrap stack adds about $1 per month (state KMS key) plus S3 pennies.
* **Optional / not in this plan (not created):** NAT gateway (about $39 per month plus data), Route 53 hosted zone ($0.50), ACM public
  certificate (free), Multi-AZ RDS (+$13.9), Valkey replica (+$10.5), CloudFront flat-rate plan (production only),
  Shield Advanced, AWS Backup, MediaConvert jobs (billed per minute when video is transcoded), SES (sandbox;
  $0.10 per 1,000 emails after production access), End User Messaging SMS (per message, sandbox mode).
* **Billed per use, not estimated:** MediaConvert transcodes, S3 storage of uploaded files and videos, SMS and
  WhatsApp. Staging holds synthetic data only.

## 7. Free Tier and credits

A new AWS account may receive Free Tier benefits or credits (for example 750 hours of `db.t4g.micro`, alarms and
log allowances). Whether this account has them is **not verified** and none are assumed. If they apply, RDS, ElastiCache
and some CloudWatch items could be lower for the first 6-12 months. Budget alerts do **not** stop spending.

## 8. Major cost drivers and optimizations

| Driver | Share (expected) | Option |
|---|---|---|
| ALB | $21 (22 %) | Required for the CloudFront VPC-origin design. Cannot be removed without redesign. |
| Fargate task + IPv4 | $20 (21 %) | Set `api_desired_count = 0` outside working hours: saves about $20 per month (wait for a scheduled-scaling addition). |
| RDS | $17 (17 %) | Already the smallest class. Stop the instance when idle (RDS auto-restarts after 7 days). |
| WAF | $11 (11 %) | Drop the three managed rule groups ($0 each, but they are 3 of the 6 rules: saves $3). Not recommended before tuning. |
| Valkey | $11 (11 %) | Smallest node. |
| Application Signals and X-Ray | $1.5 expected, $22 high | `application_signals_enabled = false` removes the sidecar and the per-signal charge. It is the main high-scenario driver. |
| Dashboard, alarms, metrics | $6 | Small. |

## 9. Budget recommendation

Monthly budget **$120** (expected $97 + about 25 % headroom), cost anomaly detection on. Recommended alerts:
50 % ($60), 80 % ($96), 100 % ($120) of actual spend, plus a 100 % forecasted alert, to `mohalim612002@gmail.com`.
**Not created yet:** the `org/` stack that holds budgets is for the management account and was not applied. A
standalone budget can be created later with `aws budgets create-budget` or the console after approval. Budgets only
notify; they never stop spending.

## 10. Verification and unverified items

* Prices marked "Price List" were read from the AWS Price List API (service codes AmazonECS, AWSELB, AmazonRDS,
  AmazonElastiCache, AmazonVPC, awswaf, awskms, AWSSecretsManager, AmazonCloudWatch) on 2026-10-13 for
  EU (Frankfurt).
* Marked "published" were taken from public AWS pricing pages and **not re-queried**: CloudFront transfer and
  request rates, CloudWatch standard-alarm rate, dashboard rate, ECR storage, inter-AZ transfer.
* Not verified: Application Signals tier boundaries, WAF WCU surcharge (assumed under 1,500 WCU), exact log volume,
  whether Free Tier or credits apply.
* Sources: <https://aws.amazon.com/fargate/pricing/>, <https://aws.amazon.com/elasticloadbalancing/pricing/>,
  <https://aws.amazon.com/rds/postgresql/pricing/>, <https://aws.amazon.com/elasticache/pricing/>,
  <https://aws.amazon.com/waf/pricing/>, <https://aws.amazon.com/cloudwatch/pricing/>,
  <https://aws.amazon.com/cloudfront/pricing/>, <https://aws.amazon.com/vpc/pricing/>,
  <https://aws.amazon.com/secrets-manager/pricing/>, <https://aws.amazon.com/kms/pricing/>,
  <https://aws.amazon.com/ecr/pricing/>; programmatic: AWS Price List API, accessed 2026-10-13.

## 11. Account plan and credits (observed 2026-10-13)

The account was on the AWS Free plan (USD 100 credits, expiring 2027-04-13), which rejected RDS and SMS resources.
After you upgraded, `aws freetier get-account-plan-state` reports `accountPlanType: PAID` with USD 100 of credits
still available. Credits are not assumed in any figure above. At the expected USD 97 per month they cover roughly the
first month only.

## 12. Estimate vs deployed configuration (validated 2026-10-13)

The deployed stack matches this estimate: 1 task of 0.5 vCPU / 1 GiB ARM64 (with ADOT sidecar), RDS db.t4g.micro single-AZ
20 GB gp3 with 7-day backups, cache.t4g.micro Valkey single node, internal ALB, CloudFront + WAF (6 rules), 8 secrets,
2 KMS keys, 18 alarms, 4 log groups (30 days). No NAT gateway, no Multi-AZ, no Route 53 zone, no ACM certificate. The first
month is therefore the idle ($69.90) plus task ($20.24) plus traffic figures; the October bill is roughly USD 59 as estimated.
