# Phase 8: parity window and decommission

**Status: checklist and inventory only.** This phase starts **at least 30 days after the production launch** and
mostly deletes things (vendor accounts, provider code, Sentry). None of it is reversible once done, so nothing here
was executed and no provider code was removed: the old providers are still the rollback switches
(`MAIL_PROVIDER`, `SMS_PROVIDER`, `PUSH_PROVIDER`, `video_platform`) until the window closes.

## Gate (all true before any deletion)

- [ ] 30 days since the Vercel production variables were switched to the AWS API host, with no rollback to a legacy provider
- [ ] Parity evidence below is filled in and signed off
- [ ] Month-end cost re-forecast done (section 5) and budgets adjusted
- [ ] You confirmed again that nothing needed from the old systems remains (plan section 0.0): Paymob export for
      accounting, any records you must retain, the Cloudflare DNS export
- [ ] A named owner for each deletion in section 4

## 1. Observability parity (what must exist before Sentry can go)

The CloudWatch replacement is **built in code and Terraform (2026-10-13)** and awaits its first live run:

| Piece | Where | Live check still needed |
|---|---|---|
| ADOT auto-instrumentation + CloudWatch agent sidecar (X-Ray traces, Application Signals) on api and worker | `modules/ecs-service` (`application_signals`), enabled by `application_signals_enabled` | Traces and service map appear; Sentry steps aside automatically (`skipOpenTelemetrySetup`) |
| CloudWatch RUM alongside Vercel Analytics (which stays) and as the candidate to replace Sentry browser capture | `modules/rum`, `learnix-front` `CloudWatchRum` component (`NEXT_PUBLIC_RUM_*`, set in Vercel) | Events arrive from the Vercel-hosted app; JS error alarm fires on a test error |
| Synthetics heartbeat canary (API readiness and catalogue on the API host; home and login page on the Vercel site) | `modules/synthetics`, started by `canary_enabled` at launch | Canary green; alarm on a forced failure |
| Saved Logs Insights queries, error anomaly detection, SMS/SES feedback metrics, queue backlog, dashboard | `modules/observability` | Queries return rows; alarms reach the topic |
| Source maps for RUM stack traces | **not built**: RUM shows minified frames | Optional; Next.js server errors are readable in CloudWatch Logs |

Acceptance for removal: **every error class Sentry reported during the window also raised a CloudWatch alarm or
matches a saved query.** Keep this table during the window:

| Date | Sentry issue (title, count) | CloudWatch alarm / query that caught it | Gap? |
|---|---|---|---|
| | | | |

Remove `@sentry/*` only when a full 30 days show no row with a gap.

## 2. Code and configuration to remove (inventory, counted 2026-10-10)

`node scripts/provider-audit.mjs --report` prints the live inventory; the reviewed list of every remaining
reference is `scripts/provider-baseline.json`. Shrink it with `--write-baseline` after each removal (the
audit fails on stale entries, so the baseline cannot drift).

| Provider | Backend files referencing it | Frontend files | Packages | Notes |
|---|---|---|---|---|
| Bunny Stream | 60 | 28 | none in the backend (own HTTP client); `tus-js-client` in the frontend | Keep the legacy-embed branch in `VideoPlayer` only if old Bunny embeds remain in data; with a fresh start none do |
| MailerSend | 28 | 2 | `mailersend` | Keep `MailTransport`, delete the MailerSend transport, templates and env |
| Twilio | 21 | 1 | `twilio` | Delete after the Egypt sender ID is live and OTP delivery is proven on all four carriers |
| Firebase / FCM | 35 | 8 | `firebase-admin`, `firebase` | Includes the **ID-token login path (needs your approval, plan decision 5)** and the old FCM push provider |
| Sentry | 3 | 10 | `@sentry/node`, `@sentry/nextjs` | Only after section 1 |
| Cloudflare R2 | 9 (`R2_*` variables, `prelaunch-reset.ts`, the R2 provider branch) | 0 | none | `prelaunch-reset.ts` now handles S3 (object keys, code exports, video assets); delete its R2 branch with the provider |
| Vercel | not a removal item | | `@vercel/analytics` | **Stays**: Vercel remains the frontend host (decision 2026-10-13), so its analytics and `VERCEL_GIT_COMMIT_SHA` release fallback stay |

Do each provider as its own change: delete the code, its env validation, its tests and docs, run the full backend
and frontend suites and the clean-boot script, deploy to staging, then production.

## 3. Documents and CI to update afterwards

`AWS_RUNTIME_ENV.md`, `docs/ENVIRONMENT_INVENTORY.md`, the Railway workflows (`deploy-production.yml` and its
GitHub-artifact `pg_dump`, which is a PII exposure to remove regardless), Nixpacks/Procfile/`railway.json`, and the
guard rules that name Railway or R2 hosts.

## 4. Vendor decommissions (each is a separate, irreversible decision for you)

Suggested order from the plan: **Bunny -> R2 -> MailerSend -> Twilio -> Firebase project -> Cloudflare zone
-> Railway.** Vercel is no longer on this list: it stays as the frontend host.

| Resource | Before you delete | Taking a backup? |
|---|---|---|
| Vercel project | **Do not delete.** It hosts the production frontend | n/a |
| Bunny library | Nothing in AWS references it | None taken (fresh start) |
| R2 bucket | Same | None taken (fresh start) |
| MailerSend / Twilio | Their sending domains and numbers are not used elsewhere | Export delivery logs if accounting needs them |
| Firebase project | Web push and login on AWS proven | Not needed |
| Cloudflare zone | Route 53 has been authoritative for 30 days; export the zone one last time | Zone export |
| Railway (prod and staging, DB, Redis) | You confirmed no data is wanted | **No dump is taken by this plan.** If you change your mind, take it *before* deleting |

I will not delete any of these myself; each needs your explicit yes in the moment.

## 5. Cost re-forecast (day 30, 60, 90)

1. Cost Explorer by `Environment` and `Component` tag versus the plan's section 6.3 lines.
2. Replace each section 6.2 assumption with the measured metric: CloudFront bytes and requests per behaviour,
   MediaConvert minutes, S3 bytes, ECS and RDS utilisation, SES and SMS counts.
3. Pick the matching scenario (Low / Expected / High) and move budgets.
4. After three stable months: Compute Savings Plan for Fargate, RDS Reserved Instances, and re-evaluate the
   CloudFront plan tier.

## 6. Still open from earlier phases

Real-handset SMS tests; S3 cross-region replication, second NAT, AWS Config and Security Hub (Stage 2); DNSSEC; an origin
certificate on the internal ALB; the read-only root filesystem trial.
