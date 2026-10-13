# AWS cost estimate

Summary of the cost model in the approved plan (§5–§6, AWS Price List API unit prices for eu-central-1
retrieved 2026-10-10, on-demand, USD, tax excluded), updated for the components added on 2026-10-13.
**Learnix has no production traffic to measure; every volume is an assumption** (plan §6.2), validated
with the AWS Pricing Calculator before approval and re-forecast at days 30/60/90 after launch.

## 0. What changed on 2026-10-13: the frontend stays on Vercel

The earlier model hosted the Next.js frontend on ECS Fargate (`web`). That service is removed, so its Fargate
cost leaves the AWS bill. **Vercel's own charges (plan, bandwidth, edge requests, image optimisation, function
usage) are outside this estimate and are not changed by this decision**: the Vercel plan already exists.

| Line | Low | Expected | High | Basis |
|---|---|---|---|---|
| Fargate `web` baseline removed (24×7) | −33.16 | −33.16 | −99.48 | Price List API: $0.03725/vCPU-h + $0.00409/GB-h, ARM, 730 h; web was 2×(0.5 vCPU/1 GB), 3×(1 vCPU/2 GB) at High. **Calculated.** |
| Fargate autoscaling peaks attributable to `web` | −1.00 | −5.45 | −16.33 | **Estimate**: assumed one third of the previous peak line (3.00 / 16.35 / 49.00). Re-measure after the load test |
| Staging `web` task (0.25 vCPU / 0.5 GB) | −8.29 | −8.29 | −8.29 | **Calculated** |
| ALB LCU, CloudFront requests/bytes | not reduced | not reduced | not reduced | Page traffic no longer crosses ALB/CloudFront, so these likely fall; kept unchanged until measured (conservative) |
| CloudFront flat-rate plan | unchanged | unchanged | unchanged | Video delivery drives the tier. **Re-check at launch:** at Low, request volume (≈ 2 M HLS requests + API calls) fits the Pro allowance (10 M), but VPC origins (the private ALB) are a Business-tier feature in the plan notes, so Business stays. Verify both claims in the console before subscribing |
| ECR | −0 | −0 | −0 | One repository fewer; storage is negligible |
| Synthetics | unchanged | unchanged | unchanged | 4 steps per run, billed per run |

## 1. Monthly totals

| USD per month | Low (pilot, recommended start) | Expected (FR-331 design point) | High |
|---|---|---|---|
| Production infrastructure | ≈ 481 (was 515) | ≈ 847 (was 885) | ≈ 4,252 (was 4,370) |
| Staging | ≈ 100 (≈ 78 with off-hours scale-down) | same | same |
| Shared accounts (org trail, log archive) | 5–15 | 5–15 | 5–15 |
| **AWS total** | **≈ 585–595** (was 630–640) | **≈ 955–965** (was ≈ 1,000) | **≈ 4,360** (was ≈ 4,490) |
| Messaging, provider-rate dependent (SMS + WhatsApp) | 55–270 | 250–1,300 | 1,250–6,500 |

Not included: taxes (Egyptian VAT may apply), AWS Support plan, **Vercel charges (unchanged, not modelled)**,
Paymob fees, domain renewal, GitHub minutes. The deltas above are calculated except where marked estimate;
none of the totals has been checked in the AWS Pricing Calculator yet.

## 2. Cost drivers (largest first)

| Driver | Low / Expected / High | Lever |
|---|---|---|
| CloudFront flat-rate plan (CDN + WAF + Route 53 + edge logs) | 200 / 200 / 2,250 | Tier review monthly; pay-as-you-go would cost ≈ 1,600 at Expected |
| MediaConvert (≈ $2.55 per content-hour, 3 renditions + thumbnails) | 38 / 204 / 765 | Drop 540p (−25 %), no 1080p |
| ECS Fargate ARM (api 2, worker 1; autoscaling peaks; no `web`) | 52 / 94 / 232 (was 86 / 132 / 347) | Right-size after the load test; Savings Plan after 3 months |
| RDS PostgreSQL Multi-AZ | 60 / 114 / 320 | Class change is a short failover; RIs after 3 months |
| NAT gateway (+ data) | 42 / 43 / 94 | S3 gateway endpoint already keeps S3 traffic off NAT |
| Valkey primary + replica | 21 / 42 / 84 | — |
| ALB (hours + LCU) | 23 / 28 / 78 | Likely lower now that page traffic bypasses it; not reduced until measured |
| S3 storage (video sources to Glacier after 30 days) | 3 / 49 / 161 | Source retention policy (decision 6) |
| Observability (logs, X-Ray, RUM, Synthetics, alarms, custom metrics) | 21 / 36 / 130 | Log retention 30 days, RUM session sampling, trace sampling |
| GuardDuty, backups, SES, misc | 14 / 29 / 98 | — |

## 3. Components added in this pass (inside the observability and backup lines above)

| Component | Unit price basis | Low / Expected | Notes |
|---|---|---|---|
| Synthetics heartbeat (1 canary, 5-minute interval, production only; 2 API checks + 2 Vercel page checks per run) | $0.0012 per run × 8,640 runs | ≈ 10 / 10 | Plus artifact S3 storage (31-day expiry, negligible). Verify in calculator |
| CloudWatch RUM | $1 per 100k events | ≈ 3–10 / 15–40 | Assumes 25 % session sampling in production. Verify |
| Application Signals + X-Ray | per-signal / per-trace pricing | within the observability line | X-Ray default sampling is 1 req/s + 5 %. Verify in calculator |
| CloudWatch agent sidecar + ADOT init container | uses the existing task's CPU/memory (64 CPU units, 128 MiB) | $0 | No task-size change; watch memory after enabling |
| Custom metrics (QueueBacklog, DeadLetterJobs) + 3 log metrics | $0.30 per metric | ≈ 1.50 per environment | — |
| AWS Backup (daily 35 d + monthly 365 d, DB + files, copy to eu-west-1) | warm storage per GB + cross-region transfer | ≈ 3–7 / 7–15 | Grows with data; the plan's backup line covers Low/Expected |
| Deploy pipeline (OIDC roles, ECR) | — | < 1 | GitHub runner minutes are outside AWS |

## 4. Budgets and alerts (configured in Terraform `org/`)

Production budget $650 (50/80/100 % actual + 100 % forecast), staging $130, per-service budgets for
MediaConvert ($75), SMS ($150) and CloudWatch ($40); Cost Anomaly Detection at $20 impact; the SMS
account spend limit is a hard cap (set in the console). CloudFront plan allowance notifications go to
the same alert channel.

## 5. Validation before approval

1. Pricing Calculator estimates for `learnix-prod-low/expected/high` and `learnix-staging` with the line
   items above, eu-central-1, flat-rate plan, SMS Egypt rate from the AWS SMS pricing tool. Investigate any
   line that differs by more than 10 %.
2. Day 30/60/90: compare Cost Explorer by `Environment`/`Component` tag with this model, replace each
   assumption with the measured metric, adjust budgets (learnix-infra/docs/phase8-decommission.md §5).
