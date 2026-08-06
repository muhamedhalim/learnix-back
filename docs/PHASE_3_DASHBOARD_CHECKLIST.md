# Phase 3 Dashboard Checklist — Storage and Third-Party Integrations

Everything in this document requires dashboard access (Cloudflare, Bunny, MailerSend, Paymob,
Meta, Firebase) this session does not have. **Nothing here has been created.** No secret values are
written down anywhere in this document — only variable **names** and where to find the **values**
each dashboard generates for you. Perform each step, then verify it with the listed check before
moving on.

## 1. Cloudflare R2 — staging bucket

1. Cloudflare dashboard → R2 → Create bucket → name it `learnix-staging` (must contain "staging" —
   the isolation guard requires this shape).
2. Confirm **public access is disabled** on the new bucket — it will hold synthetic paid-book and
   OMR-style objects during UAT, same sensitivity class as production's bucket.
3. Create a new R2 **API token** scoped to the `learnix-staging` bucket **only** (not
   account-wide, and not shared with the production token).
4. Set on the staging API service: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
   `R2_BUCKET=learnix-staging`. Leave `R2_PUBLIC_BASE_URL` unset.
5. **Verify (negative test):** using the STAGING token, attempt to list the PRODUCTION bucket:
   ```bash
   AWS_ACCESS_KEY_ID=$STAGING_R2_KEY AWS_SECRET_ACCESS_KEY=$STAGING_R2_SECRET \
     aws s3 ls s3://learnix --endpoint-url https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com
   ```
   Expect **Access Denied**. If it succeeds, the token is over-scoped — fix before proceeding.
6. **Verify (positive test):** upload, read, and delete a throwaway object in `learnix-staging`
   using the new credentials, confirming the full read/write/delete path works end to end.

## 2. Bunny Stream — staging library

1. Bunny dashboard → Stream → Create Library → name it something identifying it as staging (e.g.
   "Learnix Staging").
2. Record the new **Library ID**, **API Key** (Library-scoped, not account-wide if Bunny offers
   that scoping), **Token Authentication Key**, and the pull zone's **CDN hostname**.
3. Set on the staging API service: `BUNNY_STREAM_LIBRARY_ID`, `BUNNY_STREAM_API_KEY`,
   `BUNNY_STREAM_TOKEN_KEY`, `BUNNY_STREAM_CDN_HOSTNAME`.
4. **No webhook to register** — Bunny Stream has no inbound webhook in this codebase; video status
   is polled, not pushed (see `docs/STAGING_EXTERNAL_SERVICES_SETUP.md` §2 of the storage doc).
5. **Verify:** create one throwaway test video via the staging library's TUS upload flow, confirm
   it appears ONLY in the staging library (not production's), then delete it.

## 3. MailerSend — staging setup

1. MailerSend dashboard → create or select a sending domain distinct from production's (a
   subdomain, e.g. `staging.learnix.school`, is sufficient — review its SPF/DKIM records against
   the existing apex SPF before adding, per the original plan's §6 DNS note).
2. Create a new MailerSend **API key** scoped to that domain.
3. Create 10 template IDs under the staging account/domain, one per `MAILERSEND_TEMPLATE_*`
   variable, each with **"[STAGING] "** manually added to the template's own subject line in the
   MailerSend template editor — this cannot be done from application code for templated sends (see
   `docs/STAGING_EXTERNAL_SERVICES_SETUP.md` §2).
4. Set on the staging API service: `MAIL_PROVIDER=mailersend`, `MAILERSEND_API_KEY`,
   `MAIL_FROM_EMAIL` (a staging-only address), `MAIL_FROM_NAME=Learnix [STAGING]`,
   `MAIL_ALLOWLIST` (comma-separated tester addresses/domains).
5. **Verify (negative test):** confirm the staging API key cannot send from the production sending
   domain (MailerSend enforces domain-key binding; attempting to set `MAIL_FROM_EMAIL` to a
   production address with the staging key should be rejected by MailerSend itself).
6. **Verify (positive test):** call the existing admin-only test-email endpoint
   (`POST /health/actions/test-email`) with an allowlisted address; confirm the email arrives with
   the `[STAGING]` subject prefix (non-templated path) and confirm a templated send (e.g. password
   reset) arrives with the dashboard-configured `[STAGING]` template subject.
7. **Verify (blocking behaviour):** call the same endpoint (or trigger any `MailService.send`) with
   a non-allowlisted address; confirm MailerSend's own dashboard shows **no** send attempt for it.

## 4. Paymob — sandbox/test merchant credentials

1. Confirm whether a Paymob **test/sandbox merchant account** already exists (Q3 from the original
   plan's open questions) or request one from Paymob if not — this is the longest lead-time item
   in this checklist; start it early.
2. From the test merchant's dashboard, record: `PAYMOB_API_KEY`, `PAYMOB_SECRET_KEY`,
   `PAYMOB_CARD_INTEGRATION_ID`, `PAYMOB_IFRAME_ID`, `PAYMOB_WEBHOOK_SECRET` (HMAC secret) — **all
   distinct from production's**, since the isolation guard now checks the integration/iframe IDs
   as well as the mode flag (see `docs/STAGING_EXTERNAL_SERVICES_SETUP.md` §4).
3. In the Paymob dashboard, register the staging webhook/callback URL:
   `https://api-staging.learnix.school/api/v1/payments/webhook` (and the alternate
   `/api/v1/payments/webhook/callback` if Paymob's UI requires registering both).
4. Register the staging return URL (where the customer is redirected after checkout) pointing at
   `https://staging.learnix.school/...`, matching `FRONTEND_URL`.
5. Set on the staging API service: `PAYMOB_EXPECTED_MODE=test`, plus all values from step 2.
6. **Verify:** a sandbox checkout using Paymob's published test card numbers completes end to end
   and the webhook lands on the staging URL with a signature that verifies against
   `PAYMOB_WEBHOOK_SECRET`.
7. **Verify (negative test):** confirm attempting to configure the staging deployment with the
   production `PAYMOB_CARD_INTEGRATION_ID` causes the app to refuse to boot
   (`STAGING_PRODUCTION_PAYMENT_INTEGRATION`) — this is the live drill pattern already established
   in `PHASE_2_RAILWAY_CHECKLIST.md` §8 (deliberately misconfigure, confirm the refusal, revert).

## 5. Meta WhatsApp Cloud API — test number

1. Meta for Developers → WhatsApp product → use (or request) a **test phone number**, distinct
   from production's registered business number.
2. Record `META_WHATSAPP_PHONE_NUMBER_ID`, `META_WHATSAPP_ACCESS_TOKEN`.
3. Generate a distinct `META_WHATSAPP_APP_SECRET` and `META_WHATSAPP_VERIFY_TOKEN` for the staging
   app/webhook configuration (Meta apps have their own secret per app registration — use a
   staging-specific Meta app if the production Meta app cannot have a second webhook URL attached).
4. Register the staging webhook URL in the Meta App dashboard: `https://api-staging.learnix.school/api/v1/webhooks/whatsapp`,
   completing the one-time verify-token handshake (`GET` with `hub.verify_token` matching
   `META_WHATSAPP_VERIFY_TOKEN`).
5. Pre-register any tester phone numbers that need to receive real WhatsApp messages during UAT
   (Meta requires this for test numbers) and add them to `SMS_ALLOWLIST`.
6. **Verify:** send a templated WhatsApp message to an allowlisted, pre-registered number; confirm
   it arrives and the delivery-status webhook updates the message to `delivered`/`read`.
7. **Verify (blocking behaviour):** attempt a send to a non-allowlisted number; confirm the
   application log shows `"WhatsApp sandboxed, not sent"` and no request reaches Meta's API.

## 6. Firebase — staging project

1. Firebase Console → create a new project distinct from production's (or reuse an existing
   non-production Firebase project if one already exists for this purpose).
2. Generate a new service-account key: `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`,
   `FIREBASE_PRIVATE_KEY`.
3. **Verify:** a Firebase ID token minted against the STAGING project is accepted by
   `POST /auth/firebase` (or wherever `syncFirebaseUser` is wired) on staging, and a token minted
   against PRODUCTION's project is rejected there (`verifyIdToken` will throw — Firebase ID tokens
   are project-scoped by design, so this should already hold once the projects differ).

## 7. Sentry — staging project

1. Sentry → create a new project (or use an existing "staging" environment tag inside one project,
   if your Sentry plan doesn't support separate projects — the code only requires `SENTRY_DSN` to
   point somewhere and tags `environment` from `APP_ENV` regardless).
2. Set `SENTRY_DSN` on the staging API service.
3. **Verify:** trigger a deliberate test error (e.g. a malformed request to a diagnostic endpoint)
   and confirm it lands in Sentry tagged `environment=staging`, not `production`.

## 8. Do not create external resources without explicit access

None of the accounts, buckets, libraries, keys, or webhook registrations above were created by
this session — every step requires a dashboard this environment cannot reach. This checklist is
the complete, ordered list for whoever does have that access. No secret value appears anywhere in
this document, this phase's code, or its commit history — only variable names and verification
commands.
