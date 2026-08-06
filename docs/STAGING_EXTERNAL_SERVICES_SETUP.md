# Staging External Services Setup — Mail, SMS/WhatsApp, Firebase, Paymob, Webhooks, Sentry

Phase 3 of `STAGING_ENVIRONMENT_IMPLEMENTATION_PLAN.md`.

## 1. The gap this phase closes

Before this phase, `MAIL_ALLOWLIST` and `SMS_MODE=sandbox` were **required at boot** by
`environment-isolation.guard.ts` whenever real MailerSend/Twilio/Meta credentials were configured
on staging — but nothing in `mail.service.ts`, `sms-sender.service.ts`, or
`whatsapp-meta.channel.ts` actually read those variables to change behaviour. An operator could
set `MAIL_ALLOWLIST` correctly and it would have **zero runtime effect**. This was the single
biggest functional gap found in Phase 3's audit, and closing it — not just re-verifying the boot
guard, which was already solid — is most of this phase's code.

## 2. Mail (MailerSend)

**New file:** `src/common/utils/staging-messaging-guard.util.ts` — `evaluateMailRecipient`,
`applyStagingSubjectPrefix`. **Wired into:** `src/mail/mail.service.ts`'s `deliver()`, the single
place in the entire codebase that calls the real MailerSend API (`client.email.send`).

**Behaviour on staging** (inert on production and on any deployment where `APP_ENV` isn't
`staging`):

- A recipient whose address or domain appears in `MAIL_ALLOWLIST` still receives a REAL email —
  this is how a UAT tester's own inbox gets a real test message.
- Every other recipient is blocked before MailerSend is ever called. The block is logged
  (`status: "blocked_staging_allowlist"`) with the recipient masked, never in full.
- A non-templated send (`subject`/`text`/`html`) gets `"[STAGING] "` prepended to its subject.
  **Limitation, disclosed rather than hidden:** MailerSend template-backed sends carry their
  subject from the template configured in the MailerSend dashboard; this SDK has no per-send
  subject override for a templated email. A staging deployment MUST use its own template IDs
  (`MAILERSEND_TEMPLATE_*`, already a distinct variable set per environment) with `"[STAGING]"`
  baked into each template's own subject in the MailerSend dashboard — this code cannot reach in
  and change it.

## 3. SMS (Twilio) and WhatsApp (Meta)

**New variable:** `SMS_ALLOWLIST` (comma-separated E.164 numbers) — one allowlist shared by both
channels, since they address the same guardian phone numbers.

**Wired into:** `src/notifications/services/sms-sender.service.ts`'s `sendSms()` (the single
funnel for every Twilio call in the app — guardian notifications, admin bulk sends, anything
added later) and `src/notifications/channels/whatsapp-meta.channel.ts`'s `send()` (the only place
that calls the Meta Graph API).

**Behaviour on staging:** identical shape to mail — an allowlisted number gets a REAL SMS/WhatsApp
message; every other number is sandboxed: no outbound provider call, logged, and reported to the
caller as **accepted/success** (not a failure) so the guardian-notification worker does not
fall back from WhatsApp to SMS, or mark the parent message failed, for a send that was
deliberately never attempted.

**Push notifications:** Phase 3's audit found **no push/FCM sending code exists anywhere in this
codebase.** Firebase's only actual use is `FirebaseService.verifyToken()` — ID-token verification
for Firebase-authenticated sign-in (`users.service.ts`'s `syncFirebaseUser`) — not push. The
`.env.example` section historically labelled this "Firebase (SMS notifications to parents)" /
"optional — for SMS notifications," which this phase's `.env.example` edit corrects. There is
therefore nothing to sandbox for push: it does not exist. What IS relevant is that staging use a
**separate Firebase project**, so an ID token minted by the production app cannot authenticate
against staging (`FIREBASE_PROJECT_ID`, now checked by the isolation guard — see §5).

## 4. Paymob

Already fail-fast at boot, from Phase 0/1/2: `PAYMOB_EXPECTED_MODE` must be `test` on staging
whenever `PAYMOB_API_KEY` is configured (`STAGING_PAYMENT_MODE_NOT_TEST`), and
`PAYMOB_API_KEY`/`PAYMOB_SECRET_KEY`/`PAYMOB_WEBHOOK_SECRET` are all in the secret-fingerprint
denylist (`STAGING_PRODUCTION_SECRET_REUSED`).

**Gap found and closed this phase:** `PAYMOB_EXPECTED_MODE` is this application's OWN belief about
a transaction; whether Paymob actually treats it as real money is decided by which **integration
reference** is submitted. A staging deployment reusing production's real
`PAYMOB_CARD_INTEGRATION_ID` or `PAYMOB_IFRAME_ID` would let Paymob process a genuinely
live-capable transaction regardless of what `PAYMOB_EXPECTED_MODE` says —
`PaymobGateway.assertProviderMode()` would only notice the mismatch _after_ Paymob already
processed it. Both are now checked against the identifier denylist
(`STAGING_PRODUCTION_PAYMENT_INTEGRATION`), the same mechanism already used for `R2_BUCKET` and
`BUNNY_STREAM_LIBRARY_ID`.

**Webhook signature testing with fake data:** already thoroughly covered before this phase —
`paymob.gateway.spec.ts`'s "rejects forged, tampered, unsigned, and wrong-integration callbacks"
test constructs fake HMAC signatures and confirms `verifyWebhook()` rejects every one of them.
Nothing new needed here; verified, not re-built.

**Duplicate delivery / replay:** already covered — `gateway-webhook.service.spec.ts`'s "processes
a successful callback once and deduplicates the exact retry" and "claims a concurrent webhook
replay before any second financial side effect" tests exercise the real idempotency-key mechanism
(a `(provider, provider_event_id)` unique constraint), not a mock.

**Fake payments in the seed:** already true, verified against the actual code — `seed-staging.ts`'s
commerce section uses `provider_reference: 'sandbox-ref-...'`, a synthetic string that corresponds
to no real Paymob transaction and never calls the gateway at all.

## 5. WhatsApp webhook — new test coverage

**New file:** `src/notifications/controllers/whatsapp-webhook.controller.spec.ts` — this controller
had **zero existing tests**. Added 12 tests covering: a correctly-signed payload is accepted and
applied; a signature computed with the wrong secret is rejected; a missing signature header is
rejected; a non-`sha256=` scheme is rejected; a missing raw body fails closed even with a
well-formed header; a missing `META_WHATSAPP_APP_SECRET` fails closed; an unrecognised Meta status
value is accepted without crashing; and the `GET` verify-token handshake accepts the correct
token/mode and rejects every incorrect combination, including an unconfigured verify token.

**New isolation guard checks (this phase):**

- `META_WHATSAPP_PHONE_NUMBER_ID` — production identifier check
  (`STAGING_PRODUCTION_WHATSAPP_NUMBER`). Meta requires senders to be pre-registered, so reusing
  production's real `phone_number_id` would send from the real business number regardless of
  `SMS_MODE`.
- `FIREBASE_PROJECT_ID` — production identifier check (`STAGING_PRODUCTION_FIREBASE_PROJECT`).

## 6. Webhook isolation — what already exists vs. what was deliberately not added

| Requirement (from the Phase 3 brief)                               | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Separate URLs and secrets per environment                          | Achieved structurally: `PAYMOB_WEBHOOK_SECRET` and `META_WHATSAPP_APP_SECRET` are both in the secret-fingerprint denylist, and the callback/return URLs are built from `FRONTEND_URL`/`BACKEND_URL`, both already checked against the production-host denylist                                                                                                                                                                                                                                                          |
| Prevent staging from accepting production webhook secrets          | Same fingerprint check — tested in `environment-isolation.guard.spec.ts`'s "production webhook secrets" describe block                                                                                                                                                                                                                                                                                                                                                                                                  |
| Prevent replay between environments                                | Achieved by construction, not by a new mechanism: a webhook signed with production's secret will fail signature verification on staging (different `PAYMOB_WEBHOOK_SECRET`/`META_WHATSAPP_APP_SECRET`), and vice versa. A production-signed payload literally cannot be replayed into staging without staging's own secret matching it                                                                                                                                                                                  |
| Add an environment marker to each event when metadata is available | **Deliberately not added.** This would require a new `environment` column on `gateway_webhook_events` and a migration. Given the row above — cross-environment replay is already structurally impossible because the signatures themselves differ per environment — a marker column would be a second, redundant control for a risk the signature check already closes, not a new safety property. Flagged here as a considered-and-rejected item, matching Phase 2's own pattern of recording deliberate non-additions |
| Test duplicate delivery and invalid signatures                     | Paymob: existing tests (§4). WhatsApp: new tests (§5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Review DLQ and replay jobs                                         | `GatewayWebhookService.recoverStaleEvents()` (the webhook-replay cron) is already gated by `FEATURE_FLAGS.WEBHOOK_REPLAY` from Phase 0; `replayDeadLetter()` exists but has no controller endpoint (manual-only, invoked from nowhere in `src/`) — noted, not changed, since building an admin endpoint for it is new feature work outside this phase's isolation scope                                                                                                                                                 |

## 7. Sentry / analytics

No change needed. `src/observability/sentry.ts` already tags `environment` from
`resolveAppEnvLabel()` (`APP_ENV`, not `NODE_ENV`) — a Phase 1 fix, re-verified here and confirmed
still correct.

## 8. What this phase does NOT do

- Does not create any external account/resource (MailerSend staging key, Paymob test merchant,
  Meta test number, Firebase staging project) — no dashboard access from this environment. See
  `docs/PHASE_3_DASHBOARD_CHECKLIST.md`.
- Does not implement push notifications in any form — none exist in this codebase to isolate.
- Does not add a DLQ-replay admin endpoint — out of scope, noted as a gap for future work, not a
  regression this phase introduced.
- Does not add an `environment` marker column to `gateway_webhook_events` — deliberately rejected,
  see §6.
