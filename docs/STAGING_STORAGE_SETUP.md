# Staging Storage Setup — R2 and Bunny Stream

> **Superseded 2026-10-15:** Bunny Stream and Bunny Storage are retired. Lesson video is S3, MediaConvert and CloudFront signed cookies, and no Bunny variable is read any more. See `docs/AWS-PRODUCTION-AUDIT.md` section 8. Mentions of Bunny below describe the old system and are kept as history.

Phase 3 of `STAGING_ENVIRONMENT_IMPLEMENTATION_PLAN.md`. Companion to
[`STAGING_DATABASE_SETUP.md`](STAGING_DATABASE_SETUP.md) and
[`STAGING_REDIS_SETUP.md`](STAGING_REDIS_SETUP.md).

## 1. What existed before Phase 3

- `src/storage/storage.service.ts` already refuses to boot in `NODE_ENV=production` with
  `R2_PUBLIC_BASE_URL` set, with Bunny-only storage configured, or with no object storage
  configured at all (lines 391–431). None of this is `AppEnvironment`/`APP_ENV`-aware — it is
  keyed purely on `NODE_ENV`, which staging also sets to `production` (see `app-env.ts`).
- `src/config/environment-isolation.guard.ts`'s `checkStorage()` (added in Phase 0/1, per the
  original plan's G3/G4) already, at boot, on staging:
  - denies `R2_BUCKET` if it equals a known production identifier;
  - denies `R2_BUCKET` if it does not itself look like a staging name (`/staging|stg/i`);
  - denies `BUNNY_STREAM_LIBRARY_ID` if it equals a known production identifier;
  - denies `BUNNY_STREAM_CDN_HOSTNAME` if it resolves to a known production host;
  - denies `R2_PUBLIC_BASE_URL` if set at all, mirroring the production rule above.
- Bunny Stream has **no inbound webhook** — the backend polls video status via
  `BunnyStreamService.getVideo()`, never receives a callback — so there is no webhook secret to
  isolate for this provider.

## 2. What Phase 3 added

| Gap found                                                                                                                                                                                                                                                                                                    | Fix                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A correctly-named staging bucket under the SAME Cloudflare account as production is still one over-scoped API token away from touching production data — bucket name alone doesn't prove account identity                                                                                                    | `checkStorage()` now also denies `R2_ACCOUNT_ID` against the identifier denylist (`STAGING_PRODUCTION_R2_ACCOUNT`)                                                                                                                                                                                                                          |
| The weekly "orphan file cleanup" cron (`src/uploads/cleanup.service.ts`, gated by `ENABLE_FILE_CLEANUP`) is documented and named as if it deletes from the configured object-storage bucket, but it only scans the LOCAL `UPLOAD_DIR/profiles` folder via `node:fs` — it never calls `StorageService` at all | Documented here as a correction; no code change, since the cron's actual behaviour when R2 is the active provider is already a no-op. Flagged as a documentation-accuracy fix, not a storage-isolation gap                                                                                                                                  |
| The health-check storage probe (`src/health/indicators/storage.indicator.ts`) performs a live upload → read → delete against whichever bucket `StorageService` currently resolves to, every minute, with no feature-flag gate                                                                                | Left as-is deliberately: it always runs against the environment's OWN correctly-isolated bucket (the boot guard has already run by the time this indicator's module exists), and disabling it would blind the environment to a real storage outage — the same reasoning `docs/CRON_AUDIT.md` already applies to health collection generally |
| Real R2 deletion happens ad hoc inside domain services (lesson-content replacement, complaint attachments, manual-payment proof uploads) via `StorageService.tryDelete()`/`delete()`, not from a single cron                                                                                                 | No additional runtime guard added: `StorageService` only ever holds ONE bucket identity per boot (resolved once in `selectProvider()`), and that identity has already passed the boot guard before any of these call sites can run. A per-call runtime check would be redundant with the boot-time one                                      |

## 3. Migration commands

Not applicable — this section covers object storage, not the database. See
`STAGING_DATABASE_SETUP.md` for migration commands.

## 4. Backup/restore usage and verification results

Object storage backup/restore is out of this phase's scope (R2 versioning, if enabled, is the
relevant control — see the plan's §17 rollback table and Q5 in the original open-questions list).
Nothing new was added here.

## 5. Database safety guard table (storage-relevant rows only)

| Guard                                              | Variable(s)                 | What it catches                                                                                       |
| -------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------- |
| `STAGING_PRODUCTION_STORAGE_BUCKET`                | `R2_BUCKET`                 | Staging pointed at the exact production bucket name                                                   |
| `STAGING_STORAGE_BUCKET_NOT_MARKED`                | `R2_BUCKET`                 | A bucket name that doesn't identify itself as staging                                                 |
| `STAGING_PRODUCTION_R2_ACCOUNT` (**new, Phase 3**) | `R2_ACCOUNT_ID`             | A correctly-named staging bucket living under production's Cloudflare account                         |
| `STAGING_R2_PUBLIC_BASE_URL_SET`                   | `R2_PUBLIC_BASE_URL`        | Staging configured with a public R2 origin (mirrors the production-only rule in `storage.service.ts`) |
| `STAGING_PRODUCTION_VIDEO_LIBRARY`                 | `BUNNY_STREAM_LIBRARY_ID`   | Staging pointed at the production Bunny Stream library                                                |
| `STAGING_PRODUCTION_VIDEO_CDN`                     | `BUNNY_STREAM_CDN_HOSTNAME` | Staging pointed at the production pull zone                                                           |

## 6. Required extensions / infrastructure

None new. R2 and Bunny Stream are external SaaS resources — see
`docs/PHASE_3_DASHBOARD_CHECKLIST.md` for the account/bucket/library creation checklist.

## 7. What this phase does NOT do

- Does not create the `learnix-staging` R2 bucket or a Bunny Stream staging library — no dashboard
  access from this environment (see the Phase 3 dashboard checklist).
- Does not implement R2 object versioning or a storage backup/restore tool — out of scope,
  unchanged from the original plan's open question (Q5).
- Does not add a runtime (post-boot) storage-identity check inside `storage.service.ts` itself —
  the boot guard already gates this before the service is ever constructed; a second check would
  be redundant, not additive safety.
- Does not touch the weekly file-cleanup cron's actual behaviour — only corrects the
  documentation describing what it touches.
