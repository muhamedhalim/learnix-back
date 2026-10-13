# Phase 7: production launch (clean environment, no data migration)

**Status: checklist and tooling only.** Every step that changes what users reach, takes money or tells people
something is yours to perform or to approve in the moment. Nothing here has been run.

**The frontend stays on Vercel.** The launch moves nothing for visitors except that the Vercel production build
starts calling the new API host `https://api.<domain>`; the apex and `www` records keep pointing at Vercel.

The launch starts an **empty** system. Old accounts, purchases, certificates and videos do not carry over
(plan section 0.0); the announcement in step 7 must say so.

## Go / no-go gate (all must be true before step 1)

- [ ] Phase 4 acceptance passed in staging for every service (S3, video, email, SMS, push, observability)
- [ ] Phase 5: load test thresholds met on the production sizing; PITR drill recorded; region tabletop held
- [ ] Phase 6: `dns-diff` clean (apex and `www` still resolve to Vercel), name servers delegated for at least a
      day, `certificate_enabled = true` applied (certificate and `api.<domain>` records exist)
- [ ] Production API healthy while Vercel still builds against the old API value (pinned test below passes)
- [ ] The current Vercel Production environment variables are written down (so the switch can be reversed)
- [ ] Vercel Node.js version reviewed (`engines.node >= 24` in `learnix-front`; AWS-DEPLOYMENT-RUNBOOK.md §6)
- [ ] Encryption keys escrowed; admin password changed from the generated one and stored in your password manager
- [ ] CloudFront Business plan subscribed to the distribution (console)
- [ ] SES production access granted and the sender domain verified; if not, email will only reach verified addresses
- [ ] SMS: Egypt sender ID approved (or you accept that guardian SMS fallback is off at launch)
- [ ] You confirmed nobody holds paid content or an unpaid refund on the old system, and whether a Paymob
      dashboard export is needed for accounting (plan 0.7)
- [ ] Legal checks done: PDPL cross-border hosting, minors' data, Paymob SAQ type
- [ ] `waf_block` decision made (COUNT-only at launch is acceptable; blocking before tuning risks real users)
- [ ] A named person is on call for the first 48 hours, and the rollback below has been read

## Steps

1. **Pre-launch test through the distribution** (Vercel still on the old API value):

   ```bash
   node scripts/staging-acceptance.mjs https://api.<domain> --frontend https://<domain> --pin <cloudfront_domain_name output>
   ```

   All checks pass, including the credentialed preflight from the frontend origin, the refusal of a foreign
   origin and of a `*.vercel.app` preview URL. Then walk the journeys by hand against a **Vercel Preview** build
   whose `NEXT_PUBLIC_API_URL` is `https://api.<domain>` and whose exact URL you added to `cors_extra_origins` for
   the duration of the test (remove it afterwards): admin login, create a course, register a student, a Paymob
   **test-mode** purchase if the account has test credentials, a 20 GB-class upload, transcode and playback, a
   code export downloaded from the other task.
2. **Provider callbacks (you, in each provider's dashboard).** Point them at `https://api.<domain>/api/v1/...`
   (`terraform output provider_callback_urls`): Paymob (transaction processed/response callbacks and the
   marketplace webhook), Meta WhatsApp webhook and verify token, Zoom/Google/Microsoft OAuth redirect URIs.
   Webhooks are not blocked by the WAF at production (there is no allowlist), but check each provider's delivery
   log after the switch.
3. **Frontend switch (Vercel, you).** In the Vercel project, set the Production variables printed by
   `terraform output vercel_environment` (`NEXT_PUBLIC_API_URL=https://api.<domain>`, `NEXT_PUBLIC_SITE_URL`,
   `NEXT_PUBLIC_APP_ENV`, the `NEXT_PUBLIC_RUM_*` set) and redeploy production from Vercel. They are build-time
   values, so only the new deployment uses them; the previous deployment stays one click away for rollback. Set
   `canary_enabled = true` and apply.

   ```bash
   node scripts/cutover-verify.mjs api.<domain> <cloudfront_domain_name output>
   ```

   (checks that public resolvers return CloudFront addresses for the API host; the apex is intentionally not
   checked: it stays on Vercel.)
4. **Live checks, in this order, watching the dashboards and the alerts topic:**
   - `node scripts/staging-acceptance.mjs https://api.<domain> --frontend https://<domain>` (no pin)
   - log in on the real site: the auth cookies are set on the API host, the CSRF header is accepted, a protected
     page loads, logout clears the session
   - a **low-value live Paymob payment** (you approve and perform it): the webhook is processed exactly once, the
     order settles, the entitlement is granted; refund it afterwards from the admin screen
   - email (password reset link points at the Vercel site), SMS OTP to a real Egyptian number if the sender ID is
     approved, WhatsApp template, Web Push on Chrome and Android
   - a large upload, transcode and playback (signed cookies sent cross-origin to the API host); a code export
     downloaded from a different task
   - each scheduled job logs once per tick (check the worker log for duplicated runs), no DLQ messages, no alarms
5. **Hypercare, first 48 hours:** watch 5xx, p95 latency, queue depth, DB CPU/connections, WAF counted-rule
   samples (look for legitimate traffic that would be blocked), SES bounce/complaint rate, NAT data.
6. **Tune the WAF** against the first days of real traffic, then `waf_block = true` through a normal reviewed change.
7. **Announce** that accounts must be re-created and what happens to old purchases (your wording and decision).

## Rollback

| Situation | Action |
|---|---|
| Bad deploy | Re-deploy the previous task-definition revision (the circuit breaker already does this on failed health checks) |
| Data corruption | Point-in-time restore to a new instance (`scripts/pitr-restore-drill.sh --keep`), validate, then switch the services' `DB_HOST` |
| The site misbehaves for users | **Frontend:** Vercel dashboard, promote the previous production deployment (it still has the old build-time API value). **API:** previous task-definition revision. The apex and `www` never moved, so there is no DNS change to undo |
| A provider callback fails | Re-point that provider's callback to the previous URL if the old system is still live; otherwise fix forward |

There is no legacy data or system to roll back *to* for the application itself: the old Railway production has been
down since 2026-08-13 and is not restarted by this plan.

## Not done by tooling, deliberately

Live payment, registrar and provider-dashboard changes, the `terraform apply` approval and the user announcement
are decisions with outside effects; the repository only provides the checks around them.
