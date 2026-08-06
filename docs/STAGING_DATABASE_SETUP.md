# Staging Database Setup

Phase 2 deliverable. Companion to [`STAGING_REDIS_SETUP.md`](STAGING_REDIS_SETUP.md) and
[`PHASE_2_RAILWAY_CHECKLIST.md`](PHASE_2_RAILWAY_CHECKLIST.md). No secret values appear in this
document.

## 1. What already existed before Phase 2

- `synchronize` is blocked on any `NODE_ENV=production` deployment (`app.module.ts`), and now also
  independently on any `APP_ENV=staging` deployment regardless of `NODE_ENV`
  (`STAGING_SYNCHRONIZE_ENABLED`, `src/config/environment-isolation.guard.ts`).
- SSL is derived from `DATABASE_URL`'s hostname, not `NODE_ENV`
  (`src/common/utils/database-ssl.util.ts`) — a Railway-issued `DATABASE_URL` gets SSL
  automatically, no configuration needed.
- Connection pool tuning already existed and is fully env-driven: `DB_POOL_MAX` (default 10),
  `DB_POOL_MIN` (2), `DB_POOL_IDLE_TIMEOUT_MS` (30000), `DB_POOL_CONNECTION_TIMEOUT_MS` (10000).
- `DATABASE_URL` host/database-name isolation checks already existed from Phase 0
  (`STAGING_PRODUCTION_DATABASE_HOST`, `STAGING_PRODUCTION_DATABASE_NAME`,
  `STAGING_DATABASE_NAME_NOT_MARKED`) and their production-mirror counterpart
  (`PRODUCTION_DATABASE_NAME_LOOKS_LIKE_STAGING`, added this phase).
- The 104-migration chain was already proven against an empty database (Phase 0,
  `npm run test:migrations`) and is now also gated in CI (`migration-chain` job).

## 2. What Phase 2 added

| Gap | Fix | File |
|---|---|---|
| Two replicas could run `migration:run:prod` concurrently and race on DDL (R4) | Postgres advisory lock, shared by both the external boot step and the in-app safety net | `src/database/migration-lock.util.ts` |
| `migration:run:prod` called the raw `typeorm` CLI directly, unlocked | Now calls a small compiled CLI (`status`/`run`/`revert`) that wraps `run`/`revert` in the same lock | `src/database/migrate-cli.ts` |
| No graceful shutdown — `SIGTERM` dropped every connection instead of closing them | `app.enableShutdownHooks()` | `src/main.ts` |
| No opt-out for boot-time migrations if a deploy topology needs them run only from an explicit step | `RUN_MIGRATIONS=false` (additive; default unchanged) | `src/main.ts`, `.env.example` |
| No backup/restore tooling existed (R8) | `db-backup.sh` (pg_dump + `pg_restore --list` integrity check) and `db-restore.sh` (guarded) | `scripts/` |
| A restore could target any database, including production, with no check | `db-restore.sh` calls the same three-guard `assertSafeTarget` the seed uses, via `scripts/assert-restore-target-safe.ts` | `scripts/` |
| Nothing verified the test runner itself couldn't reach a production host | `assertTestDatabaseIsSafe`, wired into `test/setup-e2e.ts` | `src/config/environment-isolation.guard.ts` |

## 3. Migration commands

| Command | What it does | Locked? |
|---|---|---|
| `npm run migration:show` | Lists pending/applied migrations (dev, ts-node) | n/a (read-only) |
| `npm run migrate:status` | Same, via the new CLI (dev, ts-node) | n/a (read-only) |
| `npm run migration:run` | Applies pending migrations (dev, ts-node) | No — dev convenience |
| `npm run migrate:run` | Applies pending migrations via the new CLI (dev, ts-node) | **Yes** |
| `npm run migration:run:prod` | Applies pending migrations (compiled) — this is what `nixpacks.toml`/`Procfile` actually run before boot | **Yes** (changed this phase) |
| `npm run migration:revert` | Reverts the newest migration (dev, ts-node) | No — dev convenience |
| `npm run migrate:revert` | Reverts the newest migration via the new CLI (dev, ts-node) | **Yes** |
| `npm run test:migrations` | Full chain test against a disposable empty database | n/a (own database) |
| `npm run verify:migration-lock` | Proves two concurrent connections genuinely serialise through the lock | n/a (own database) |

The dev-facing `migration:*` scripts are left unlocked on purpose — a single local developer
iterating against their own database has nothing to race against, and locking them would only add
latency with no safety benefit. `migration:run:prod` is the one that matters, because it is the
command that actually runs on every Railway deploy, potentially from two replicas at once.

**Verified for real, not just unit-tested:** `npm run verify:migration-lock` (two live Postgres
connections; the second measurably blocked ~1.4s behind the first's ~1.5s hold before acquiring),
and `migrate-cli.ts`'s `status`/`run`/`revert` commands were each run against a real disposable
database end to end (104 migrations applied, then the newest reverted, then re-confirmed pending).

## 4. Backup and restore

```bash
# Backup (writes a timestamped, integrity-checked archive locally)
DATABASE_URL=postgres://... ./scripts/db-backup.sh [output-directory]

# Restore (refuses unless the target passes the seed's own three identity guards)
DATABASE_URL=postgres://... ./scripts/db-restore.sh path/to/backup.dump
```

`db-backup.sh` runs `pg_dump --format=custom`, then `pg_restore --list` against the result —
an archive that can't even be listed is deleted immediately, not left behind as a false sense of
security. `db-restore.sh` never accepts a "safety-checked database A, restore into database B"
split: the only target is `DATABASE_URL`, checked and restored into in the same invocation.

**Uploading the backup artefact to object storage is explicitly out of scope for this phase** — it
needs the R2 bucket and credentials Phase 3 provisions. Phase 2 delivers the
create-and-verify-locally mechanism; wiring its output to a bucket is a Phase 3 follow-up.

**Verified for real:** both scripts were run against disposable Postgres databases via a
`postgres:18-alpine` container (this dev machine has no local `pg_dump`/`pg_restore` on `PATH`) —
`db-backup.sh` end-to-end (created + integrity-checked a real archive), and `pg_restore`'s restore
step end-to-end with 3 known rows landing correctly in a second, separate database. The one piece
not exercised as a single combined process in this environment: `db-restore.sh`'s internal call to
`npx ts-node .../assert-restore-target-safe.ts`, because that requires the full Node project
(entities, decorators) which cannot run inside the Linux container's Windows-incompatible
`node_modules`. That exact safety check was instead verified directly, natively, against both an
unsafe (production-host) and a safe (staging-named) target — see §5.

## 5. Database safety — what is guarded, and how

| Danger | Guard | Trigger |
|---|---|---|
| Staging pointed at the production database | `STAGING_PRODUCTION_DATABASE_HOST` / `STAGING_PRODUCTION_DATABASE_NAME` | Boot (`validate()`) |
| A staging database not obviously named as such | `STAGING_DATABASE_NAME_NOT_MARKED` | Boot |
| Production pointed at a staging-named database | `PRODUCTION_DATABASE_NAME_LOOKS_LIKE_STAGING` | Boot |
| `synchronize=true` on staging (any `NODE_ENV`) | `STAGING_SYNCHRONIZE_ENABLED` | Boot |
| `synchronize=true` on `NODE_ENV=production` | Existing throw in `app.module.ts` | Boot |
| The seed run against a non-staging target | `assertSafeTarget` (3 independent checks: identity, host, name) | Every `runStagingSeed()` call |
| The seed run at all, even on a verified target | `assertSeedArmed` (`ALLOW_STAGING_SEED=true` required) | Every `runStagingSeed()` call |
| The seed silently duplicating rows on a second run | `SeedAlreadyRanError` — refuses unless `--reset` | `runStagingSeed(false)` |
| A restore run against a non-staging target | Same three-guard `assertSafeTarget`, via `assert-restore-target-safe.ts` | `db-restore.sh` |
| The E2E test runner pointed at a production host | `assertTestDatabaseIsSafe` | `test/setup-e2e.ts`, before any test file runs |

No single check is load-bearing on its own — this mirrors the four-rule-class design
`environment-isolation.guard.ts` already used for Phase 0's storage/payment/mail checks.

## 6. Required Postgres extensions

`uuid-ossp` — created by the very first migration (`1734986400000-InitialSchema.ts`). No manual
extension step is needed on a fresh staging database; the migration chain creates it.

## 7. What this phase does NOT do

- Does not create the `learnix-staging` Railway project, Postgres service, or Redis service — see
  [`PHASE_2_RAILWAY_CHECKLIST.md`](PHASE_2_RAILWAY_CHECKLIST.md) for the exact steps to perform in
  the dashboard.
- Does not run a restore drill against a real Production backup into a scratch database (P2-11) —
  that step specifically requires an actual Production backup and a Railway scratch database,
  neither of which exists yet; the restore *mechanism* is proven above against synthetic data.
- Does not upload backup artefacts to object storage (Phase 3).
