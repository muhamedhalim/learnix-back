/**
 * Advisory-locked migration execution — Phase 2 (Database and Redis) of
 * STAGING_ENVIRONMENT_IMPLEMENTATION_PLAN.md, resolving finding R4.
 *
 * WHY THIS EXISTS
 * ----------------
 * `nixpacks.toml`/`Procfile` run `migration:run:prod` as an external step
 * before `node dist/src/main.js` starts, and `main.ts`'s `runPendingMigrations()`
 * repeats the same idempotent call from inside the app as a safety net. Both
 * are unconditional and uncoordinated: with two Railway replicas deploying at
 * once, two processes can call `dataSource.runMigrations()` against the same
 * database at the same moment. TypeORM's runner is idempotent about *which*
 * migrations have already run, but is not safe against two processes
 * concurrently executing DDL from the *same* not-yet-applied migration —
 * `CREATE INDEX`, `ALTER TABLE`, and similar statements can collide.
 *
 * A Postgres advisory lock serialises this without needing any new
 * infrastructure: whichever process gets there first holds
 * `pg_advisory_lock(id)` for the duration of the run; the second process
 * blocks on the same call until the first releases it, then proceeds against
 * an already-migrated (and therefore no-op) database. The lock ID is derived
 * from a fixed string via Postgres's own `hashtext()`, so every process
 * computes the identical ID with no coordination and no magic number to keep
 * in sync across files.
 *
 * This is a no-op wrapper in the common case (one replica, one migration
 * run): acquire, run, release, with no other process ever contending for the
 * lock. It only changes behaviour the moment a second concurrent runner
 * actually appears — exactly the race it exists to prevent.
 */

import type { DataSource } from 'typeorm';

/** Fixed lock name — never change this once staging or production depend on
 * it, or a process running the old name and one running the new name would
 * no longer coordinate with each other. */
const MIGRATION_LOCK_NAME = 'learnix:migrations';

async function resolveLockId(dataSource: DataSource): Promise<string> {
  const rows = (await dataSource.query('SELECT hashtext($1)::bigint AS id', [
    MIGRATION_LOCK_NAME,
  ])) as Array<{ id: string }>;
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error('Failed to compute the migration advisory lock ID.');
  }
  return id;
}

/**
 * Runs `fn` while holding a session-scoped Postgres advisory lock, blocking
 * until any concurrent holder releases it first. `dataSource` must already be
 * initialised (a live connection is required for the lock to have any
 * meaning — advisory locks are tied to the session that acquired them).
 */
export async function withMigrationAdvisoryLock<T>(
  dataSource: DataSource,
  fn: () => Promise<T>,
  log: (message: string) => void = () => undefined,
): Promise<T> {
  const lockId = await resolveLockId(dataSource);
  log(`Waiting for migration advisory lock (${MIGRATION_LOCK_NAME})...`);
  await dataSource.query('SELECT pg_advisory_lock($1)', [lockId]);
  log('Migration advisory lock acquired.');
  try {
    return await fn();
  } finally {
    await dataSource.query('SELECT pg_advisory_unlock($1)', [lockId]);
    log('Migration advisory lock released.');
  }
}
