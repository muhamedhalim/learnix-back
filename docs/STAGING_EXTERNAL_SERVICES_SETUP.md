# Staging External Services Setup — Mail, SMS/WhatsApp, Firebase, EasyKash, Webhooks, Sentry

> **Superseded 2026-10-15:** Bunny Stream and Bunny Storage are retired. Lesson video is S3, MediaConvert and CloudFront signed cookies, and no Bunny variable is read any more. See `docs/AWS-PRODUCTION-AUDIT.md` section 8. Mentions of Bunny below describe the old system and are kept as history.

Phase 3 of `STAGING_ENVIRONMENT_IMPLEMENTATION_PLAN.md`.

## 1. The gap this phase closes

Before this phase, `MAIL_ALLOWLIST` and `SMS_MODE=sandbox` were **required at boot** by
`environment-isolation.guard.ts` whenever real mail/Twilio/Meta credentials were configured
on staging — but nothing in `mail.service.ts`, `sms-sender.service.ts`, or
`whatsapp-meta.channel.ts` actually read those variables to change behaviour. An operator could
set `MAIL_ALLOWLIST` correctly and it would have **zero runtime effect**. This was the single
biggest functional gap found in Phase 3's audit, and closing it — not just re-verifying the boot
guard, which was already solid — is most of this phase's code.

## 2. Mail (Amazon SES)

> **Updated 2026-10-19:** MailerSend was removed from the codebase. Amazon SES (`MAIL_PROVIDER=ses`) is the
> only email provider, and every message is rendered in this repository, so there are no remote templates.

**New file:** `src/common/utils/staging-messaging-guard.util.ts` — `evaluateMailRecipient`,
`applyStagingSubjectPrefix`. **Wired into:** `src/mail/mail.service.ts`'s `deliver()`, the single
place in the entire codebase that calls Amazon SES (`SendEmailCommand` through `ses.transport.ts`).

**Behaviour on staging** (inert on production and on any deployment where `APP_ENV` isn't
`staging`):

- A recipient whose address or domain appears in `MAIL_ALLOWLIST` still receives a REAL email —
  this is how a UAT tester's own inbox gets a real test message.
- Every other recipient is blocked before SES is ever called. The block is logged
  (`status: "blocked_staging_allowlist"`) with the recipient masked, never in full.
- Every send gets `"[STAGING] "` prepended to its subject.

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

## 4. EasyKash (payment gateway)

EasyKash documents **no sandbox or test mode**, so staging must run with the gateway
**unconfigured**: the isolation guard refuses `EASYKASH_API_KEY` / `EASYKASH_HMAC_SECRET` on staging
(`STAGING_PAYMENT_CREDENTIALS_SET`), and both are in the secret-fingerprint denylist
(`STAGING_PRODUCTION_SECRET_REUSED`). Checkout therefore reports "payment service unavailable" on
staging. Payment logic is exercised with mocked EasyKash responses and signed callbacks only
(`easykash.gateway.spec.ts`, `test/e2e/easykash-callback.postgres.e2e-spec.ts`). See
`docs/EASYKASH_SETUP.md` for the production merchant configuration.

**Fake payments in the seed:** `seed-staging.ts` uses synthetic `sandbox-ref-...` references that
correspond to no real transaction and never call the gateway.

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
| Separate URLs and secrets per environment                          | Achieved structurally: `EASYKASH_HMAC_SECRET` and `META_WHATSAPP_APP_SECRET` are both in the secret-fingerprint denylist, and the callback/return URLs are built from `FRONTEND_URL`/`BACKEND_URL`, both already checked against the production-host denylist                                                                                                                                                                                                                                                           |
| Prevent staging from accepting production webhook secrets          | Same fingerprint check — tested in `environment-isolation.guard.spec.ts`'s "production webhook secrets" describe block                                                                                                                                                                                                                                                                                                                                                                                                  |
| Prevent replay between environments                                | Achieved by construction, not by a new mechanism: a webhook signed with production's secret will fail signature verification on staging (different `PAYMOB_WEBHOOK_SECRET`/`META_WHATSAPP_APP_SECRET`), and vice versa. A production-signed payload literally cannot be replayed into staging without staging's own secret matching it                                                                                                                                                                                  |
| Add an environment marker to each event when metadata is available | **Deliberately not added.** This would require a new `environment` column on `gateway_webhook_events` and a migration. Given the row above — cross-environment replay is already structurally impossible because the signatures themselves differ per environment — a marker column would be a second, redundant control for a risk the signature check already closes, not a new safety property. Flagged here as a considered-and-rejected item, matching Phase 2's own pattern of recording deliberate non-additions |
| Test duplicate delivery and invalid signatures                     | EasyKash: `easykash.gateway.spec.ts` (§4). WhatsApp: new tests (§5)                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Review DLQ and replay jobs                                         | `GatewayWebhookService.recoverStaleEvents()` (the webhook-replay cron) is already gated by `FEATURE_FLAGS.WEBHOOK_REPLAY` from Phase 0; `replayDeadLetter()` exists but has no controller endpoint (manual-only, invoked from nowhere in `src/`) — noted, not changed, since building an admin endpoint for it is new feature work outside this phase's isolation scope                                                                                                                                                 |

## 7. Sentry / analytics

No change needed. `src/observability/sentry.ts` already tags `environment` from
`resolveAppEnvLabel()` (`APP_ENV`, not `NODE_ENV`) — a Phase 1 fix, re-verified here and confirmed
still correct.

## 8. What this phase does NOT do

- Does not create any external account/resource (EasyKash merchant,
  Meta test number, Firebase staging project) — no dashboard access from this environment. See
  `docs/PHASE_3_DASHBOARD_CHECKLIST.md`.
- Does not implement push notifications in any form — none exist in this codebase to isolate.
- Does not add a DLQ-replay admin endpoint — out of scope, noted as a gap for future work, not a
  regression this phase introduced.
- Does not add an `environment` marker column to `gateway_webhook_events` — deliberately rejected,
  see §6.
