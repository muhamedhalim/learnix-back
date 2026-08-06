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

import type { DataSource, QueryRunner } from 'typeorm';

/** Fixed lock name — never change this once staging or production depend on
 * it, or a process running the old name and one running the new name would
 * no longer coordinate with each other. This is the ONLY place the name is
 * defined; every caller (the CLI, `main.ts`'s in-app safety net, and the
 * verification scripts) goes through this module's exports rather than
 * recomputing it, which is what makes "same lock ID everywhere" structural
 * rather than a convention someone could drift away from. */
const MIGRATION_LOCK_NAME = 'learnix:migrations';

/** Postgres error code raised when `lock_timeout` elapses before a lock is
 * acquired. https://www.postgresql.org/docs/current/errcodes-appendix.html */
const POSTGRES_LOCK_NOT_AVAILABLE = '55P03';

/**
 * How long a process will wait to acquire the migration lock before giving up
 * — this is what makes "the second process doesn't wait indefinitely" true.
 * Configurable via `MIGRATION_LOCK_TIMEOUT_MS` so a deployment with unusually
 * slow migrations can raise it, but both the CLI and `main.ts` read this same
 * function (never a locally-duplicated default), so there is no way for the
 * two call sites to disagree about how long is too long.
 *
 * Default 5 minutes: long enough that a legitimately slow migration (a large
 * backfill, `CREATE INDEX CONCURRENTLY`) holding the lock does not cause a
 * false timeout on the waiter, short enough that an operator is not left
 * staring at a hung deploy with no signal for longer than a coffee break.
 */
const DEFAULT_LOCK_TIMEOUT_MS = 5 * 60 * 1000;

function resolveLockTimeoutMs(): number {
  const raw = process.env['MIGRATION_LOCK_TIMEOUT_MS'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_LOCK_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LOCK_TIMEOUT_MS;
  return Math.floor(parsed);
}

export class MigrationLockTimeoutError extends Error {
  public constructor(lockName: string, waitedMs: number) {
    super(
      `Timed out after ${String(waitedMs)}ms waiting for the migration advisory lock ` +
        `(${lockName}). Another process is very likely still holding it — check for a stuck or ` +
        'crashed migration run on another replica before retrying. The lock is session-scoped, ' +
        "so it is released automatically if that process's database connection has already died; " +
        'if it is still alive, let it finish or terminate it deliberately, then retry.',
    );
    this.name = 'MigrationLockTimeoutError';
  }
}

function isLockTimeoutError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === POSTGRES_LOCK_NOT_AVAILABLE
  );
}

/** Minimal shape both a real `QueryRunner` and the unit tests' fake satisfy. */
interface Queryable {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
}

async function resolveLockId(runner: Queryable): Promise<string> {
  const rows = (await runner.query('SELECT hashtext($1)::bigint AS id', [
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
 * (up to `MIGRATION_LOCK_TIMEOUT_MS`) until any concurrent holder releases it
 * first. `dataSource` must already be initialised.
 *
 * Uses a single dedicated `QueryRunner` (one physical connection, held for
 * the entire critical section) rather than `dataSource.query()` for each
 * statement. This matters specifically because advisory locks and
 * `lock_timeout` are both tied to the Postgres *session* that issued them:
 * `dataSource.query()` checks a connection out of the pool per call and can
 * hand back a *different* physical connection each time. Acquiring the lock
 * on one pooled connection and later calling `pg_advisory_unlock` on another
 * would silently fail to release anything (Postgres reports "you don't own
 * this lock" and does nothing), and a `SET lock_timeout` issued on a
 * different connection than the one that runs `pg_advisory_lock` would never
 * take effect on the wait at all. A dedicated `QueryRunner` makes both of
 * those failure modes structurally impossible instead of merely unlikely.
 *
 * The lock-acquisition wait is bounded by Postgres's own `lock_timeout`
 * session setting (which applies to advisory-lock waits exactly as it does to
 * any other lock wait), not by a client-side `Promise.race` — so the timeout
 * is enforced by the server the lock actually lives on, not by best-effort
 * client bookkeeping that a hung network connection could defeat.
 */
export async function withMigrationAdvisoryLock<T>(
  dataSource: DataSource,
  fn: () => Promise<T>,
  log: (message: string) => void = () => undefined,
): Promise<T> {
  const runner: QueryRunner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    const lockId = await resolveLockId(runner);
    const lockTimeoutMs = resolveLockTimeoutMs();

    log(
      `Waiting for migration advisory lock (${MIGRATION_LOCK_NAME}), timeout ` +
        `${String(lockTimeoutMs)}ms...`,
    );
    try {
      await runner.query(`SET lock_timeout = ${String(lockTimeoutMs)}`);
      await runner.query('SELECT pg_advisory_lock($1)', [lockId]);
    } catch (error) {
      if (isLockTimeoutError(error)) {
        throw new MigrationLockTimeoutError(MIGRATION_LOCK_NAME, lockTimeoutMs);
      }
      throw error;
    } finally {
      // Reset immediately after the acquire attempt (success or failure) so
      // the timeout never leaks into `fn()`'s own queries (which run on
      // whichever connections `fn()` itself requests, not this one) nor into
      // whatever unrelated query eventually reuses this pooled connection
      // after `runner.release()` below.
      await runner.query('SET lock_timeout = 0').catch(() => undefined);
    }

    log('Migration advisory lock acquired.');
    try {
      return await fn();
    } finally {
      // Always released here, even if `fn()` throws (a failed migration) — a
      // failed run must never leave the second process waiting for a lock
      // nobody still holds. Session-scoped advisory locks are also released
      // automatically by Postgres if this connection dies outright, so a
      // crash (rather than a clean throw) is covered too.
      await runner.query('SELECT pg_advisory_unlock($1)', [lockId]);
      log('Migration advisory lock released.');
    }
  } finally {
    await runner.release();
  }
}
