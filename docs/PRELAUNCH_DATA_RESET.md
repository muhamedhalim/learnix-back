# Learnix pre-launch data reset

This maintenance command resets application data while preserving the migrated
schema and TypeORM migration history. It is a CLI task, not an HTTP endpoint.

## Discovered runtime architecture

- `src/main.ts` starts the NestJS API and applies pending TypeORM migrations in
  production before creating the module graph.
- BullMQ producers and workers run in that same API process. There is no worker
  entry point or separate worker command in this repository.
- Nest Schedule cron jobs also run in the API process. BullMQ independently
  stores two global repeatable schedules: the one-minute exam auto-submit sweep
  and the hourly gamification streak-reset sweep.
- PostgreSQL owns schema, business data, sessions, configuration and operational
  health history. TypeORM uses the `migrations` table for history.
- Redis owns cache, throttling state, idempotency records, distributed locks,
  health-collector coordination, leaderboards and all BullMQ queue state.
- R2 is the primary private object store for non-video media. Bunny Stream owns
  lesson videos and is explicitly out of scope for this reset: no Bunny API is
  called and all Bunny assets are intentionally preserved. Generated
  attendance-code exports are temporary local files.

## Table classification

The command introspects every table in the current PostgreSQL schema and compares
it with TypeORM's loaded entity/junction metadata. It refuses to continue when a
table is unknown, so a newly added table cannot be silently truncated.

- Application/test data: every entity/junction table except the two system-data
  tables below. This includes users, profiles, catalog/content, exams,
  submissions, commerce/finance, notifications, support, logs, sessions and
  operational runtime history.
- Required system data, rebuilt from code: `rank_tiers` (5 rows) and
  `health_alert_rules` (10 rows).
- Preserved internal metadata: `migrations` and `typeorm_metadata` when present.
- Rebuildable runtime data: Learnix cache/locks/idempotency/leaderboard keys and
  all declared BullMQ queue keys. With an explicit Redis namespace, the whole
  namespace is removed. For un-namespaced production Redis, `FLUSHDB` is allowed
  only after the operator confirms that selected Redis database is dedicated.

The administrator is deleted with `users` and recreated inside the same database
transaction through `AdminInitializationService`, using only
`ADMIN_INIT_EMAIL`/`ADMIN_INIT_PASSWORD`.

## Safe operating procedure

1. In Railway, stop or scale the Learnix application service to zero so its API,
   workers, cron jobs and repeatable-job registration cannot race the reset.
2. Create or verify a recoverable PostgreSQL backup and record its Railway backup
   identifier/timestamp. Test restoreability according to the deployment backup
   policy when possible.
3. From an environment carrying the target service variables, run the dry run:

   `npm run db:reset:prelaunch:prod -- --dry-run`

4. Review the printed non-secret host/database/environment, all table classes and
   row counts, storage-reference counts and Redis key-category counts.
5. Execute with all guards set. `RESET_PRELAUNCH_TARGET` must exactly match the
   dry-run host/database string. Never put credentials in these variables.

   `RESET_PRELAUNCH_DATA=true`

   `RESET_PRELAUNCH_TARGET=<host>/<database>`

   `RESET_PRELAUNCH_BACKUP_CONFIRMED=true`

   `RESET_PRELAUNCH_BACKUP_REFERENCE=<backup-id-or-timestamp>`

   `RESET_PRELAUNCH_SERVICES_STOPPED=true`

   For the current un-namespaced production Redis, also set
   `RESET_PRELAUNCH_REDIS_DEDICATED=true` only after verifying the selected Redis
   database is exclusive to Learnix.

6. Restart the application service. Startup recreates the two global repeatable
   jobs idempotently and starts all in-process workers and cron jobs.
7. Run `npm run db:reset:prelaunch:prod -- --verify`. Both expected repeatable
   job counts must be exactly 1 and orphan rows must be 0. Then run readiness and
   administrator login/authorization smoke checks.

`--skip-external` exists only for isolated non-production database tests. The
command rejects it when `APP_ENV=production`.

## Failure behavior

Record-derived R2/local storage objects are deleted first, Redis second, and
PostgreSQL last. Bunny Stream is never contacted. Any in-scope storage failure
aborts before database deletion. PostgreSQL truncation, system seeding and admin
recreation are one transaction. A failure after external cleanup is safe to
retry because object deletion, Redis cleanup, system seeds and admin
initialization are idempotent.
