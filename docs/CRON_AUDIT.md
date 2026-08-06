# Cron Job Audit — Learnix

> **Phase 0 deliverable.** Addresses **Finding A-13** in `docs/ENVIRONMENT_INVENTORY.md`.

Eleven `@Cron` declarations exist. All run **inside the API process** — there is no separate worker or scheduler service (`nixpacks.toml`, `Procfile`). `ScheduleModule.forRoot()` (`src/app.module.ts:182`) arms them at boot; the earliest fires 60 seconds later.

**The governing risk:** three of these jobs mutate financial state and two delete storage objects. Before this phase none was gated by anything. A deployment pointed at another environment's database or bucket begins mutating it within a minute — which is why the isolation guard (`src/config/environment-isolation.guard.ts`) runs in `ConfigModule`'s `validate()`, before `ScheduleModule` ever loads.

---

## 1. Audit table

Legend — **Impact:** 💰 financial · 🗑️ destructive · 📣 contacts people · ⚙️ operational.

### 1.1 💰 Payment reconciliation — every minute

| | |
|---|---|
| **File** | `src/payments/services/payment-operations.service.ts:59` `runMaintenance()` |
| **Function** | Takes a Postgres advisory lock (`finance-maintenance-v1`), then sweeps orders, payments, entitlements, refunds and settlements; expires stale payments, releases discount-code usage, and advances teacher earnings toward settlement eligibility. |
| **Cadence** | `EVERY_MINUTE` |
| **Impact** | 💰 **Direct.** Writes to `payments`, `orders`, `entitlements`, `financial_ledger_entries`, `settlements`. |
| **Run in staging?** | **Yes** — reconciliation logic is exactly what staging must exercise, against the Paymob **sandbox** merchant. |
| **Feature flag** | `ENABLE_PAYMENT_RECONCILIATION` ✅ added |
| **Mock/sandbox** | Sandbox Paymob credentials; `PAYMOB_EXPECTED_MODE=test` enforced by the isolation guard. |
| **Notes** | Already multi-replica safe via `pg_try_advisory_lock`. The flag is an operator switch (incident response, or an environment whose isolation is not yet confirmed), not a correctness fix. |

### 1.2 💰 Gateway webhook replay — every minute

| | |
|---|---|
| **File** | `src/payments/services/gateway-webhook.service.ts:147` `recoverStaleEvents()` |
| **Function** | Re-drives `gateway_webhook_events` rows that are `processing` past their lease, or `failed` and due for retry. Uses `FOR UPDATE SKIP LOCKED` so replicas cooperate. |
| **Cadence** | `EVERY_MINUTE` |
| **Impact** | 💰 **Direct.** Replays webhooks that finalize payments and grant entitlements. |
| **Run in staging?** | **Yes** — webhook recovery is one of the highest-value things to prove before Production. |
| **Feature flag** | `ENABLE_WEBHOOK_REPLAY` ✅ added |
| **Mock/sandbox** | Sandbox webhook secret; staging webhook URL registered separately in Paymob. |
| **Notes** | Effects stay effectively-once through the locked finalizers, so a flag flip mid-flight is safe: unprocessed events are simply picked up on the next enabled run. |

### 1.3 💰 Gateway attempt reconciliation — every 30 minutes

| | |
|---|---|
| **File** | `src/payments/services/payment-operations.service.ts:192` `reconcileGatewayAttempts()` |
| **Function** | Re-queries the provider for payments still `PENDING`/`PROCESSING`/`EXPIRED` that carry a provider reference, and transitions them to their true state. |
| **Cadence** | `EVERY_30_MINUTES` |
| **Impact** | 💰 **Direct.** Makes outbound calls to Paymob and finalizes payments. |
| **Run in staging?** | **Yes**, against sandbox. |
| **Feature flag** | `ENABLE_PAYMENT_RECONCILIATION` ✅ (shares the flag — same financial domain, same reason to disable) |
| **Mock/sandbox** | Sandbox merchant. |
| **Notes** | This is the job that would make **outbound calls with whatever Paymob credentials it holds**. The isolation guard's `PAYMOB_EXPECTED_MODE=test` requirement is what stops that being a live merchant. |

### 1.4 🗑️ Weekly orphan file cleanup — Sundays 02:00 UTC

| | |
|---|---|
| **File** | `src/uploads/cleanup.service.ts:46` `performWeeklyCleanup()` |
| **Function** | Scans the uploads tree for files with no referencing database row and **deletes them**. |
| **Cadence** | `0 2 * * 0`, `timeZone: 'UTC'` |
| **Impact** | 🗑️ **Destructive.** Permanent deletion unless the bucket has object versioning (unconfirmed — audit item D-05). |
| **Run in staging?** | **Yes**, but only once the staging bucket is confirmed separate. |
| **Feature flag** | `ENABLE_FILE_CLEANUP` ✅ added |
| **Mock/sandbox** | Separate `learnix-staging` bucket with a token scoped to it alone. |
| **Notes** | **The single most dangerous job in the codebase for cross-environment leakage.** "Orphaned" is computed from the *connected database*; a staging database plus a production bucket means every production file looks orphaned. Two independent defences now exist: the guard refuses to boot on a production bucket name, and this flag allows deletion to stay off until isolation is proven. |

### 1.5 🗑️ Expired upload-session cleanup — every 30 minutes

| | |
|---|---|
| **File** | `src/lessons/lessons.service.ts:812` `cleanExpiredBunnyUploadSessions()` |
| **Function** | Marks expired `created` sessions `abandoned` and runs `cleanupUploadSession`, which **deletes the video from Bunny Stream**. Batches of 100. |
| **Cadence** | `EVERY_30_MINUTES` |
| **Impact** | 🗑️ **Destructive** against the configured Bunny Stream library. |
| **Run in staging?** | **Yes**, once a separate staging library exists. |
| **Feature flag** | `ENABLE_FILE_CLEANUP` ✅ (shares the flag — same destructive class) |
| **Mock/sandbox** | Separate Bunny Stream library. |
| **Notes** | Same shape of hazard as 1.4, for video instead of objects. Guarded by the `BUNNY_STREAM_LIBRARY_ID` identifier denylist. |

### 1.6 ⚙️ Certificate auto-issuance retry — every 5 minutes

| | |
|---|---|
| **File** | `src/certificates/certificates.service.ts:254` `retryPendingAutoIssuanceFailures()` |
| **Function** | Retries up to 50 unresolved certificate-issuance failures whose `next_retry_at` has passed. |
| **Cadence** | `EVERY_5_MINUTES` |
| **Impact** | ⚙️ Issues certificates; may trigger a certificate email. No financial effect. |
| **Run in staging?** | **Yes** — needed to test the certificate lifecycle. |
| **Feature flag** | **Not added.** Idempotent, bounded, non-destructive, non-financial. A flag would be noise. |
| **Mock/sandbox** | Email side effects are constrained by `MAIL_ALLOWLIST` (staging) rather than by suppressing the job. |

### 1.7 ⚙️ Scheduled course publishing — every 5 minutes

| | |
|---|---|
| **File** | `src/packages/packages.service.ts:919` `publishScheduledCourses()` |
| **Function** | Flips `DRAFT` courses whose `scheduled_publish_at` has passed to `PUBLISHED`. |
| **Cadence** | `EVERY_5_MINUTES` |
| **Impact** | ⚙️ Changes public visibility. Indirect commercial effect (a course becomes purchasable). |
| **Run in staging?** | **Yes.** |
| **Feature flag** | **Not added.** Operates only on rows explicitly scheduled by a user; cannot act spontaneously. |

### 1.8 ⚙️ Support SLA sweep — every 15 minutes

| | |
|---|---|
| **File** | `src/complaints/support-sla.service.ts:55` `evaluate()` |
| **Function** | Evaluates complaint first-response and resolution deadlines against the active policy and flags breaches/warnings. |
| **Cadence** | `0 */15 * * * *` |
| **Impact** | ⚙️ Internal state only. |
| **Run in staging?** | **Yes.** |
| **Feature flag** | **Not added.** No external effect. |

### 1.9 ⚙️ Expired session cleanup — daily 03:00

| | |
|---|---|
| **File** | `src/users/sessions.service.ts:23` `cleanupExpiredSessions()` |
| **Function** | `DELETE FROM user_sessions WHERE expires_at < now()`. |
| **Cadence** | `EVERY_DAY_AT_3AM` |
| **Impact** | ⚙️ Deletes only already-expired rows. Not user-visible. |
| **Run in staging?** | **Yes.** |
| **Feature flag** | **Not added.** Deletes rows that are already dead; no recoverable state is lost. |

### 1.10 ⚙️ Health collection — every minute (+ 2s startup)

| | |
|---|---|
| **File** | `src/health/health-collection.service.ts:27` |
| **Function** | Collects component health into `health_*` tables. Coordinated across replicas by a Redis lock plus `PROCESS_ROLE` / `HEALTH_COLLECTOR_PROCESS_ROLE` (`health-collector-coordinator.service.ts:66`). |
| **Cadence** | `EVERY_MINUTE` + `@Timeout(2_000)` |
| **Impact** | ⚙️ Observability only. **Probes external providers**, so it makes outbound calls with the configured credentials. |
| **Run in staging?** | **Yes** — this is how staging proves its own isolation is healthy. |
| **Feature flag** | **Not added.** Disabling it would blind the environment precisely when visibility matters most. |
| **Notes** | Probes are read-only. Cadence is tunable via `HEALTH_COLLECTOR_CADENCE_SECONDS`. |

### 1.11 ⚙️ Health retention prune — hourly

| | |
|---|---|
| **File** | `src/health/health-collection.service.ts:106` |
| **Function** | Prunes historical health rows past their retention window. |
| **Cadence** | `EVERY_HOUR` |
| **Impact** | ⚙️ Observability data only. |
| **Run in staging?** | **Yes.** |
| **Feature flag** | **Not added.** |

---

## 2. Flags introduced

Defined in `src/config/feature-flags.ts`. **Every flag defaults to enabled and is disabled only by the exact string `false`.** Production sets none of them, so production behaviour is unchanged by construction — verified by `src/config/feature-flags.spec.ts`, which asserts that `FALSE`, `False`, `0`, `no`, `off`, and `" false"` all leave a flag **enabled**.

| Flag | Gates | Applied at |
|---|---|---|
| `ENABLE_PAYMENT_RECONCILIATION` | §1.1, §1.3 | `payment-operations.service.ts` — both cron entry points |
| `ENABLE_WEBHOOK_REPLAY` | §1.2 | `gateway-webhook.service.ts:recoverStaleEvents` |
| `ENABLE_FILE_CLEANUP` | §1.4, §1.5 | `uploads/cleanup.service.ts`, `lessons/lessons.service.ts` |
| `ENABLE_NOTIFICATIONS` | outbound guardian delivery | `notifications/processors/parent-notification.processor.ts:process` |
| `ENABLE_BACKGROUND_JOBS` | all BullMQ processing | `queues/queues.constants.ts:areQueuesEnabled` |

### Why five flags and not eleven

A flag on a job that cannot cause harm is not a safety control — it is an extra way to misconfigure the system, and an extra branch that can silently disable something nobody notices for a week. Flags were added only where the job is **financial**, **destructive**, or **contacts a real person**. The remaining six jobs are idempotent, bounded, and internal; they run everywhere.

### `ENABLE_NOTIFICATIONS` placement

Applied at `process()` — the single entry point covering both `deliver` and `redeliver` — rather than at each channel. The handler **returns** instead of throwing, so a deliberately-disabled environment completes jobs rather than accumulating failures and DLQ entries.

This is orthogonal to `MAIL_ALLOWLIST` and `SMS_MODE=sandbox`: those constrain *who* may be reached, this constrains *whether delivery is attempted at all*. Staging is expected to use the allowlist and keep delivery **on**, so notification flows are actually testable.

---

## 3. Recommended settings per environment

| Flag | Production | Staging | Local dev |
|---|---|---|---|
| `ENABLE_PAYMENT_RECONCILIATION` | unset (on) | unset (on) | unset (on) |
| `ENABLE_WEBHOOK_REPLAY` | unset (on) | unset (on) | unset (on) |
| `ENABLE_FILE_CLEANUP` | unset (on) | **`false` until the staging bucket and Bunny library are confirmed isolated**, then unset | `false` |
| `ENABLE_NOTIFICATIONS` | unset (on) | unset (on) — rely on `MAIL_ALLOWLIST` + `SMS_MODE=sandbox` | `false` |
| `ENABLE_BACKGROUND_JOBS` | unset (on) | unset (on) | unset (on) |

**Production must leave all five unset.** Setting any of them, even to `true`, adds a variable whose only possible effect is to disable something later by mistake.

---

## 4. Outstanding cron-related risk

| Risk | Status |
|---|---|
| No separate worker/cron service; a busy API replica competes with cron for the event loop | **Open** — architecture change, out of Phase 0 scope. `PROCESS_ROLE` already exists to support the split |
| §1.4 computes "orphaned" from the connected database | **Mitigated** — isolation guard + `ENABLE_FILE_CLEANUP`. Fully closed once the staging bucket exists (Phase 3) |
| R2 object versioning unconfirmed, so §1.4 deletions may be unrecoverable | **Open** — audit item D-05 |
| Cron fires on every replica; only §1.1 and §1.10 take a lock | **Partially open** — §1.2 uses `SKIP LOCKED`; §1.6/§1.7/§1.8 are idempotent by query shape. No corruption path identified, but duplicate work is possible under multi-replica |
