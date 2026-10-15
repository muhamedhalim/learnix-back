# Secret Rotation Checklist — Learnix

> **Superseded 2026-10-15:** Bunny Stream and Bunny Storage are retired. Lesson video is S3, MediaConvert and CloudFront signed cookies, and no Bunny variable is read any more. See `docs/AWS-PRODUCTION-AUDIT.md` section 8. Mentions of Bunny below describe the old system and are kept as history.

> **Phase 0 deliverable.** Triggered by **Finding A-09** in `docs/ENVIRONMENT_INVENTORY.md`.
>
> **NO SECRET VALUES APPEAR IN THIS FILE, AND NONE MAY EVER BE ADDED.**
> Nothing here is executed by code. Every action is performed by a human in an external dashboard.

---

> **Update (Phase 0 closure pass).** `docs/SECRETS_REPORT.md` fingerprinted this file precisely. Correction to this section: the file has 54 _declared_ keys, but `PAYMOB_API_KEY`, `PAYMOB_SECRET_KEY`, `PAYMOB_WEBHOOK_SECRET`, `TWILIO_AUTH_TOKEN`, `META_WHATSAPP_ACCESS_TOKEN`, `META_WHATSAPP_APP_SECRET`, and `FIREBASE_PRIVATE_KEY` are present as **blank lines**, not populated values. Rotation urgency for those specific credentials is downgraded accordingly — see `docs/SECRETS_REPORT.md` for the corrected per-secret status. Everything else below, including the `REDIS_URL` finding, is unaffected.

## 1. Why this exists

`learning-center-backend/.env` (gitignored, **never committed** — verified with `git log` and gitleaks) contains **54 declared keys, of which 12 hold non-empty values** (see `docs/SECRETS_REPORT.md` for the exact list with fingerprints). One of the populated ones is decisive:

```
REDIS_URL = redis://<credentials>@redis.railway.internal:6379
```

`*.railway.internal` is a Railway **private-network** hostname. It is unresolvable from any machine outside a Railway deployment. A local developer machine cannot have obtained that value by any means other than copying it out of a deployed Railway environment's variables.

Corroborating signals in the same file: `R2_BUCKET=learnix` and an `R2_PUBLIC_BASE_URL` whose host matches the one hardcoded in `dodline/next.config.ts:13`; `MAIL_FROM_EMAIL=info@learnix.school`, the public production sender also present in `dodline/app/[locale]/lib/site.ts:4`.

**Therefore every secret in that file is treated as exposed** and must be rotated before Staging is built — otherwise Staging will be provisioned from a compromised credential set.

**One counter-signal, recorded for accuracy:** `DATABASE_URL` in that file points at `localhost:5432/LMS`, and `R2_PUBLIC_BASE_URL` is set — a value that makes production **refuse to boot** (`src/storage/storage.service.ts:392`). So the file is a _partial or stale_ copy, not a live mirror. This lowers the probability that the database credentials specifically were ever exposed, but does not lower it for the rest.

**Blast-radius note:** the repository is private and `.env` was never committed. Exposure is limited to whoever has had filesystem access to developer machines holding this file. That is a smaller set than a public leak — but it is not zero, and the credentials include live payment and email capability.

---

## 2. Rotation priority

| Tier   | Meaning                                                     | Act within |
| ------ | ----------------------------------------------------------- | ---------- |
| **P1** | Enables money movement, or mass contact with real customers | 24 hours   |
| **P2** | Enables authentication bypass or data access                | 72 hours   |
| **P3** | Enables reconnaissance or service disruption                | 1 week     |

---

## 3. Rotation register

### P1 — money and customer contact

| #    | Variable                     | Used at                    | External service          | Rotation procedure                                                                                                                                                              | Restart needed |
| ---- | ---------------------------- | -------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| S-01 | `PAYMOB_API_KEY`             | `paymob.gateway.ts:52`     | Paymob merchant dashboard | Settings → API keys → regenerate. Update Railway var.                                                                                                                           | Yes            |
| S-02 | `PAYMOB_SECRET_KEY`          | `paymob.gateway.ts:53`     | Paymob                    | Same screen as S-01; rotate together                                                                                                                                            | Yes            |
| S-03 | `PAYMOB_WEBHOOK_SECRET`      | `paymob.gateway.ts:56`     | Paymob                    | Integrations → callback HMAC → regenerate. **Update Railway var in the same maintenance window** — a mismatch causes every webhook to 401 (`payments-webhook.controller.ts:37`) | Yes            |
| S-04 | `MAILERSEND_API_KEY`         | `mail.service.ts:85`       | MailerSend                | Domains → API tokens → create new, update Railway, then delete old. **Create-then-delete order matters** — deleting first drops queued mail                                     | Yes            |
| S-05 | `TWILIO_AUTH_TOKEN`          | `sms.channel.ts`           | Twilio Console            | Account → Auth tokens → create secondary → promote → revoke primary                                                                                                             | Yes            |
| S-06 | `META_WHATSAPP_ACCESS_TOKEN` | `whatsapp-meta.channel.ts` | Meta for Developers       | App → WhatsApp → API setup → regenerate permanent token                                                                                                                         | Yes            |
| S-07 | `META_WHATSAPP_APP_SECRET`   | `env.validation.ts:101`    | Meta                      | App → Settings → Basic → App secret → reset. Verifies `X-Hub-Signature-256`                                                                                                     | Yes            |
| S-08 | `META_WHATSAPP_VERIFY_TOKEN` | `env.validation.ts:106`    | Meta                      | Self-chosen value; set on both sides simultaneously                                                                                                                             | Yes            |

> `PAYMOB_CARD_INTEGRATION_ID` and `PAYMOB_IFRAME_ID` are **identifiers, not secrets** — no rotation. Record them in the inventory instead.

### P2 — authentication and data access

| #    | Variable                 | Used at                                   | External service   | Rotation procedure                                                                                                   | User impact                                                                                                                |
| ---- | ------------------------ | ----------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| S-09 | `JWT_SECRET`             | `env.validation.ts:165`; `auth.module.ts` | none (self-issued) | Generate ≥32 bytes; set in Railway                                                                                   | **All access tokens invalidated.** Clients auto-refresh via `axios.config.ts:181` — most users recover silently            |
| S-10 | `JWT_REFRESH_SECRET`     | `env.validation.ts:173`                   | none               | Generate ≥32 bytes                                                                                                   | **All users logged out.** Rotate in a low-traffic window                                                                   |
| S-11 | `COOKIE_SECRET`          | `main.ts:106`; `csrf.guard.ts:167`        | none               | Generate ≥32 bytes                                                                                                   | CSRF cookies invalidated; `csrf.guard.ts:143-157` re-issues automatically, and `axios.config.ts:153` retries once. Handled |
| S-12 | `R2_ACCESS_KEY_ID`       | `storage.service.ts:386`                  | Cloudflare R2      | R2 → Manage API tokens → create new **scoped to one bucket** → update → delete old                                   | Brief upload failures during swap                                                                                          |
| S-13 | `R2_SECRET_ACCESS_KEY`   | `storage.service.ts:387`                  | Cloudflare R2      | Issued with S-12                                                                                                     | as above                                                                                                                   |
| S-14 | `BUNNY_STREAM_API_KEY`   | `bunny-stream.service.ts:71`              | Bunny.net          | Stream → library → API → regenerate                                                                                  | Video upload/delete fails until updated                                                                                    |
| S-15 | `BUNNY_STREAM_TOKEN_KEY` | `bunny-stream.service.ts:107`             | Bunny.net          | Stream → library → API → token auth key                                                                              | **In-flight signed playback URLs break** (TTL-bounded)                                                                     |
| S-16 | `BUNNY_API_KEY`          | `bunny-stream.service.ts:72` (fallback)   | Bunny.net          | Account → API key                                                                                                    | Low                                                                                                                        |
| S-17 | `ADMIN_INIT_PASSWORD`    | `admin-initialization.service.ts:49`      | none               | Change the admin's password **in-app**, then unset the variable. Note: `:72` means it is inert once any admin exists | None                                                                                                                       |
| S-18 | `INIT_SECRET`            | `env.validation.ts:192`                   | none               | **Unset entirely** after bootstrap — `.env.example:45` already instructs this                                        | None                                                                                                                       |
| S-19 | `FIREBASE_PRIVATE_KEY`   | `env.validation.ts:243`                   | Firebase Console   | Project settings → Service accounts → generate new key → update → delete old from IAM                                | Push interruption                                                                                                          |

### P3 — reconnaissance and disruption

| #    | Variable               | Used at                         | External service | Procedure                                                                                                                                                                             |
| ---- | ---------------------- | ------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S-20 | `METRICS_BEARER_TOKEN` | `metrics-bearer.guard.ts:21`    | none             | Generate; update scraper config in the same window                                                                                                                                    |
| S-21 | `BULL_BOARD_PASSWORD`  | `bull-board-auth.middleware.ts` | none             | Generate ≥12 chars                                                                                                                                                                    |
| S-22 | `SENTRY_DSN`           | `sentry.ts:22`                  | Sentry           | Project settings → Client keys → generate new → deactivate old                                                                                                                        |
| S-23 | `REDIS_URL`            | `redis-connection.util.ts:23`   | Railway          | Railway rotates on service recreation. **Coordinate with Phase 2** — recreating Redis clears the cache, all queues, throttle counters, and idempotency records                        |
| S-24 | `DATABASE_URL`         | `data-source.ts:30`             | Railway          | Postgres → rotate credentials. **Lowest priority** — the local copy points at `localhost`, so production DB credentials were probably never in that file. Verify D-01 before deciding |

---

## 4. Execution checklist

Tick each box in order. Do not batch P1 with P2.

### Preparation

- [ ] **R-00** Confirm the current Production Railway variable **key list** (audit item D-01) so nothing is missed
- [ ] **R-01** Confirm from the Railway dashboard whether the `.env` values match the deployed set (resolves the ambiguity in §1)
- [ ] **R-02** Announce a maintenance window covering S-09/S-10 (logout) and S-03 (webhook)
- [ ] **R-03** Take a verified database backup before any rotation
- [ ] **R-04** Confirm rollback: keep the previous value recorded in the password manager until the new one is proven

### P1 — within 24h

- [ ] **R-05** S-01 + S-02 Paymob API + secret key (together)
- [ ] **R-06** S-03 Paymob webhook secret — **then immediately** send a Paymob test webhook and confirm a `200`, not `401`
- [ ] **R-07** S-04 MailerSend API key (create → update → verify a send → delete old)
- [ ] **R-08** S-05 Twilio auth token
- [ ] **R-09** S-06 + S-07 + S-08 Meta WhatsApp token, app secret, verify token
- [ ] **R-10** Verify: `GET /api/v1/health/all` shows every external provider healthy

### P2 — within 72h

- [ ] **R-11** S-12 + S-13 R2 keys — **scope the new token to a single bucket**, unlike the current one
- [ ] **R-12** S-14 + S-15 + S-16 Bunny keys; verify upload and signed playback
- [ ] **R-13** S-19 Firebase service-account key
- [ ] **R-14** S-11 `COOKIE_SECRET`
- [ ] **R-15** S-09 `JWT_SECRET` (maintenance window)
- [ ] **R-16** S-10 `JWT_REFRESH_SECRET` (same window — expect full logout)
- [ ] **R-17** S-17 change the admin password in-app, then unset `ADMIN_INIT_PASSWORD`
- [ ] **R-18** S-18 unset `INIT_SECRET`
- [ ] **R-19** Verify: login → refresh → protected route → logout, end to end

### P3 — within 1 week

- [ ] **R-20** S-20 `METRICS_BEARER_TOKEN` + scraper config
- [ ] **R-21** S-21 `BULL_BOARD_PASSWORD`
- [ ] **R-22** S-22 Sentry DSN
- [ ] **R-23** S-23 `REDIS_URL` — schedule with Phase 2
- [ ] **R-24** S-24 `DATABASE_URL` — only if R-01 shows production DB credentials were exposed

### Containment — do this regardless of rotation timing

- [ ] **R-25** Delete `learning-center-backend/.env` from **every** developer machine
- [ ] **R-26** Replace it with a values-free copy of `.env.example` on each machine
- [ ] **R-27** Confirm no secret ever entered git history:
      `gitleaks detect --source . --log-opts="--all"` on both repos
- [ ] **R-28** Agree a standing rule: production variables are **never** copied to a local machine. Local development uses local Postgres/Redis and disabled providers
- [ ] **R-29** After Phase 4, developers who need realistic config pull **staging** values, never production

---

## 5. Post-rotation verification

Run all of these after each tier. Every command is read-only.

```bash
curl -sS https://learning-center-backend-production.up.railway.app/api/v1/health | jq
```

Then, as an admin, confirm each external provider reports healthy:

```
GET /api/v1/health/all      → all indicators "up"
POST /api/v1/health/actions/test-email  → delivered
```

Paymob: trigger a sandbox webhook and assert `200` (a `401` means `PAYMOB_WEBHOOK_SECRET` is out of sync — see `payments-webhook.controller.ts:37`).

Auth: `POST /auth/login` → `POST /auth/refresh` → an authenticated `GET` → `POST /auth/logout`.

---

## 6. What code does — and does not — do

**Phase 0 added no rotation logic.** No script in this repository reads, writes, or transmits a secret value.

What Phase 0 _does_ add is a guard that makes a rotated-vs-stale mismatch **loud instead of silent**: `src/config/environment-isolation.guard.ts` compares SHA-256 fingerprints of the running secrets against an operator-supplied denylist of **hashes** (`PROD_SECRET_FINGERPRINTS`). Because only hashes are stored, a production secret can be blocked from Staging without that secret ever being written down.

To produce a fingerprint without exposing the value:

```bash
node -e "console.log(require('crypto').createHash('sha256').update(process.env.SECRET||'').digest('hex').slice(0,16))"
```

Run it in the environment that already holds the value; record only the 16-character output.
