# Phase 6: production build and DNS move (no user impact)

`environments/production` composes the same modules as staging with production settings. **Nothing has been
applied.** Offline checks passed (validate, a mocked-provider `terraform test` of three scenarios, tflint, checkov
with 0 failed). Applying it needs the `learnix-production` account, the Phase 2 manual steps, and your approval.

## How production differs from staging

|               | Staging                                                              | Production                                                                                                                             |
| ------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Account / VPC | `learnix-staging`, 10.10.0.0/16                                      | `learnix-production`, 10.20.0.0/16                                                                                                     |
| Tasks         | public subnets, public IPs, no NAT                                   | private app subnets behind NAT (static egress IP in `nat_egress_ips`)                                                                  |
| Services      | `api` (`PROCESS_ROLE=all`), optional `worker`                        | `api` x2..6 (`api` role), `worker` (always split). No `web`: the frontend stays on Vercel                                              |
| Database      | single-AZ micro, no deletion protection                              | Multi-AZ `db.t4g.small`, deletion protection, final snapshot, 14-day PITR, **automated backups replicated to eu-west-1** (own KMS key) |
| Valkey        | 1 node                                                               | primary + replica with automatic failover                                                                                              |
| Edge          | allowlist gate, managed rules in COUNT                               | public; managed and per-IP rate rules (general 6000 and auth 100 per 5 min) in COUNT until `waf_block = true`                          |
| App flags     | `APP_ENV=staging`, `MAIL_ALLOWLIST`, `SMS_MODE=sandbox`, Paymob TEST | `APP_ENV=production`; none of those (the isolation guard refuses a production boot that has an allowlist)                              |
| Safety        | `force_destroy`, short key deletion windows                          | deletion protection on RDS and ALB, `prevent_destroy` on the DNS zone, no `force_destroy`, 30-day key and secret windows               |

## Steps

1. **Bootstrap** the production account (`bootstrap/`, `phase2-manual-steps.md`); set repository variables
   `PRODUCTION_PLAN_ROLE_ARN`, `PRODUCTION_APPLY_ROLE_ARN`, `PRODUCTION_TF_STATE_BUCKET`,
   `PRODUCTION_TF_STATE_KMS_KEY_ARN`, `PRODUCTION_TFVARS_JSON`. Create the GitHub environment `infra-production`
   with required reviewers (two, including the person who owns the database).
2. **Export the current zone** from Cloudflare (every record) and fill `dns_records` with all of them
   **except** any `_dmarc` record (Terraform manages that one for SES). The apex and `www` records that point at
   Vercel **are** copied (take the targets from Vercel's domain settings; they never move to AWS). Keep the
   Cloudflare zone untouched. Lower the TTLs of the important records to 300 s a day ahead.
3. **Apply** with the `Terraform` workflow (`target=production`). First apply creates everything with all service counts at 0 and the
   Route 53 zone holding the copied records, still pointing at today's Vercel targets (and still not delegated).
4. **Subscribe the CloudFront flat-rate Business plan** to the distribution in the console
   (`cloudfront_distribution_id` output). Terraform support for the plan subscription is unverified. Confirm the
   distribution still meets the plan's rules (no real-time logs, no Lambda@Edge, OAC not OAI, a WAF ACL attached).
5. **Fill the operator secrets** (`vapid`, `cloudfront-signing`, `paymob`, `meta-whatsapp`, `meetings`) as in
   `phase3-staging.md`, escrow the two encryption keys from `core`, push images, set `image_tag`, run the
   `migrate` task, then raise `api_desired_count` to 2 and `worker_desired_count` to 1.
6. **Verify the zone before touching the registrar:**

   ```bash
   node scripts/dns-diff.mjs records.json --old <cloudflare ns> --new <one of the name_servers output>
   ```

   `records.json` lists `{name, type}` for every exported record. Zero differences is required. Also send a test
   email to and from the domain.

7. **Change the name servers at Name.com** to the `name_servers` output (the registrar change is yours; the domain
   is `clientTransferProhibited`, which blocks transfers, not NS edits). Turn DNSSEC off at the registrar first if it
   is on. Watch resolution for a day; rollback is setting the Cloudflare name servers back (bounded by record TTL).
8. **After delegation**, set `certificate_enabled = true` and apply: the us-east-1 certificate for `api.<domain>`
   validates over DNS, the distribution gains that alias and the `api` A/AAAA records appear. The apex and `www`
   keep pointing at Vercel; the frontend only starts using the API host at the Phase 7 Vercel switch.
9. **Hold**: keep the Cloudflare zone for 30 days. Tune WAF in COUNT mode against synthetic and test traffic; only
   then set `waf_block = true`.

## Acceptance

- [ ] `dns-diff` reports every record identical; email delivery for the domain unchanged
- [ ] API healthy while Vercel still builds against the old API value: `node scripts/staging-acceptance.mjs https://api.<domain> --frontend https://<domain> --pin <cloudfront_domain_name>`
- [ ] 150 migrations ran on the empty production RDS; admin, rank tiers and alert rules seeded
- [ ] Replicated backups exist in eu-west-1 (`dr_backup_replication_arn`); one PITR drill done with `scripts/pitr-restore-drill.sh`
- [ ] The two encryption keys are escrowed outside AWS or in another account
- [ ] Budgets and anomaly monitors fire in a test; alerts reach `alert_emails`
- [ ] No IAM user or access key exists in the account

## Notes and limits

- The ALB is internal and CloudFront reaches it over HTTP inside the VPC; adding an origin certificate
  (`certificate_arn` on the `alb` module plus `https-only` on the VPC origin) is a hardening item.
- SES stays in the sandbox until production access is granted (a separate AWS-account request), so production
  email cannot go out to arbitrary recipients yet; SMS needs the approved Egypt sender ID.
- A second NAT gateway, S3 cross-region replication, AWS Config and Security Hub are Stage 2 items (plan section 7).
- Destroying the zone or the database is blocked on purpose (`prevent_destroy`, deletion protection); the conftest
  policy also fails a plan that deletes protected resource types.
