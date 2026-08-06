# Secrets Report — Learnix

> **NO SECRET VALUE APPEARS IN THIS DOCUMENT, ANYWHERE.** The "Secure fingerprint" column is a truncated SHA-256 digest — the same one-way construction `src/config/environment-isolation.guard.ts` already uses for `PROD_SECRET_FINGERPRINTS` — computed by `scripts/fingerprint-secrets.ts` and reproduced verbatim below. A fingerprint cannot be reversed to recover the value it was computed from.
>
> **Correction to an earlier finding.** `docs/SECRET_ROTATION_CHECKLIST.md` (written before this fingerprinting pass existed) generalised that the local `.env` holds "54 populated keys" and treated Paymob/Twilio/Meta/Firebase as exposed. Running `scripts/fingerprint-secrets.ts` against that file shows this was imprecise: `PAYMOB_API_KEY`, `PAYMOB_SECRET_KEY`, `PAYMOB_WEBHOOK_SECRET`, `TWILIO_AUTH_TOKEN`, `META_WHATSAPP_ACCESS_TOKEN`, `META_WHATSAPP_APP_SECRET`, and `FIREBASE_PRIVATE_KEY` are **declared but empty** in that file — the keys exist as blank lines, not populated secrets. The rotation urgency for those specific credentials is lower than originally stated. Everything else in that document — the P1/P2/P3 tiering, the checklist, the `REDIS_URL`-points-at-a-Railway-internal-host reasoning — stands.

**Generated:** 2026-08-05, via `npm run fingerprint:secrets` against the developer machine's local `.env`.

---

## 1. How to read this report

- **Present**: whether the variable has a non-empty value in the environment fingerprinted. `NOT SET` means the key is either absent or present-but-blank.
- **Secure fingerprint**: first 16 hex characters of `SHA-256(value)`. Two rows with the same fingerprint are, for all practical purposes, the same secret. A fingerprint here can safely be pasted into a `PROD_SECRET_FINGERPRINTS` variable on a staging deployment — that is the exact mechanism the isolation guard uses to block a production credential from being reused there (see `docs/ENVIRONMENT_INVENTORY.md` §14.1, rule class 4).
- **Rotation required?**: carried over from `docs/SECRET_ROTATION_CHECKLIST.md`'s tiering, corrected per variable below.
- A row with `Present: NOT SET` has no rotation urgency from *this* file — it simply isn't configured here. It may still be configured (and therefore need rotation) on the actual Railway deployment; that can only be confirmed from the Railway dashboard (audit item D-01/D-02).

## 2. Per-secret report

| Name | Location of use | Associated service | Rotation required? | Present locally | Secure fingerprint |
|---|---|---|---|---|---|
| `JWT_SECRET` | `src/config/env.validation.ts`; `src/auth/auth.module.ts` | none (self-issued) | **Yes — P2** | yes | `b4d2af54675ca1af` |
| `JWT_REFRESH_SECRET` | `src/config/env.validation.ts` | none (self-issued) | **Yes — P2** | yes | `0b6063c47778c7c2` |
| `COOKIE_SECRET` | `src/main.ts:106`; `src/common/guards/csrf.guard.ts:167` | none (self-issued) | **Yes — P2** | yes | `cba7e85116cd9a31` |
| `INIT_SECRET` | `src/config/env.validation.ts:192` | none | **Yes — P2 (unset, don't rotate)** | yes | `d26b3380c56ffd8b` |
| `METRICS_BEARER_TOKEN` | `src/observability/metrics-bearer.guard.ts:21` | none | **Yes — P3** | yes | `0c1ad1cf9695f4a9` |
| `BULL_BOARD_PASSWORD` | `src/queues/bull-board-auth.middleware.ts` | none | Yes — P3, if ever set | **NOT SET** | — |
| `PAYMOB_API_KEY` | `src/payments/providers/paymob/paymob.gateway.ts:52` | Paymob | Yes — P1, if configured on Railway | **NOT SET locally** | — |
| `PAYMOB_SECRET_KEY` | `paymob.gateway.ts:53` | Paymob | Yes — P1, if configured on Railway | **NOT SET locally** | — |
| `PAYMOB_WEBHOOK_SECRET` | `paymob.gateway.ts:56` | Paymob | Yes — P1, if configured on Railway | **NOT SET locally** | — |
| `MAILERSEND_API_KEY` | `src/mail/mail.service.ts:85` | MailerSend | **Yes — P1** | yes | `80cb41096c3dd802` |
| `R2_ACCESS_KEY_ID` | `src/storage/storage.service.ts:386` | Cloudflare R2 | **Yes — P2** | yes | `23aac714f489361e` |
| `R2_SECRET_ACCESS_KEY` | `storage.service.ts:387` | Cloudflare R2 | **Yes — P2** | yes | `1855f13bb2a3ee7c` |
| `BUNNY_STREAM_API_KEY` | `src/lessons/bunny-stream.service.ts:71` | Bunny.net | **Yes — P2** | yes | `0089e08f648df8d1` |
| `BUNNY_STREAM_TOKEN_KEY` | `bunny-stream.service.ts:107` | Bunny.net | **Yes — P2** | yes | `af9df458b412c2b9` |
| `BUNNY_API_KEY` | `bunny-stream.service.ts:72` (fallback) | Bunny.net | **Yes — P2** | yes | `82c2045d31236f44` |
| `TWILIO_AUTH_TOKEN` | `src/notifications/channels/sms.channel.ts` | Twilio | Yes — P1, if configured on Railway | **NOT SET locally** | — |
| `META_WHATSAPP_ACCESS_TOKEN` | `src/notifications/channels/whatsapp-meta.channel.ts` | Meta | Yes — P1, if configured on Railway | **NOT SET locally** | — |
| `META_WHATSAPP_APP_SECRET` | `src/config/env.validation.ts:101` | Meta | Yes — P1, if configured on Railway | **NOT SET locally** | — |
| `FIREBASE_PRIVATE_KEY` | `src/config/env.validation.ts:243`; `src/firebase/` | Firebase | Yes — P2, if configured on Railway | **NOT SET locally** | — |
| `ADMIN_INIT_PASSWORD` | `src/admin-init/admin-initialization.service.ts:49` | none | **Yes — P2, but by in-app password change, not this variable** | yes | `50b1a5c85992e91b` ⚠️ |

⚠️ **`ADMIN_INIT_PASSWORD` is human-chosen and therefore lower entropy than the others.** A truncated SHA-256 digest is not reversible for a 32-byte random secret, but it offers meaningfully weaker protection against a targeted dictionary attack on a chosen password. Do not treat this fingerprint as equally safe to the others above; the recommended action remains the same regardless — change the admin's password in-app and let `ADMIN_INIT_PASSWORD` become inert (`admin-initialization.service.ts:72` already skips initialization once any admin exists).

## 3. Identifiers — not secrets, no fingerprint needed

| Name | Location | Note |
|---|---|---|
| `PAYMOB_CARD_INTEGRATION_ID` | `paymob.gateway.ts:54` | Merchant-visible identifier, not a credential |
| `PAYMOB_IFRAME_ID` | `paymob.gateway.ts:55` | Same |
| `R2_ACCOUNT_ID` | `storage.service.ts` | Account identifier, not a credential |
| `BUNNY_STREAM_LIBRARY_ID` | `bunny-stream.service.ts:63` | Resource identifier — but see `docs/ENVIRONMENT_INVENTORY.md`: this IS included in the isolation guard's identifier denylist, since a shared value would let staging delete production videos |
| `R2_BUCKET` | `storage.service.ts` | Same reasoning — identifier-denylisted, not secret-fingerprinted |

## 4. Reproducing this report

```bash
npm run fingerprint:secrets
```

Reads `.env` via the same `dotenv` loading every other script in this repo uses, computes fingerprints with the exported `fingerprint()` function from `src/config/environment-isolation.guard.ts` (identical construction the isolation guard itself uses), and prints only names, presence, and fingerprints — never a value, and the script contains no code path capable of printing one.

Run this again after each rotation in `docs/SECRET_ROTATION_CHECKLIST.md` §4 and confirm the fingerprint CHANGED — that is the verification step that a rotation actually took effect, without anyone needing to compare raw values.
