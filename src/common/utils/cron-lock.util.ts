import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';

/**
 * Cluster-wide single-runner guard for `@Cron` jobs, so N worker replicas run each tick once.
 * Uses a PostgreSQL session-level advisory lock on a dedicated connection: if the process dies
 * the connection closes and the lock is released automatically.
 *
 * The lock is held for `holdMs` from the START of the run even if the job finishes sooner.
 * Replicas fire the same cron within milliseconds of each other, so a lock released the moment
 * the winner finishes would let a slightly-late replica run the same tick again. Holding it
 * covers that clock skew. `holdMs` must stay well below the job's shortest interval.
 *
 * `CRON_LOCK_HOLD_MS` overrides the default hold for every job (tests set 0 so a job can be invoked
 * several times in a row; leave it unset in deployed environments).
 *
 * The DataSource is registered once by `CronLockModule`. When none is registered (unit tests,
 * scripts) the wrapped job simply runs, which preserves existing behaviour.
 */
const logger = new Logger('CronLock');
export const DEFAULT_CRON_LOCK_HOLD_MS = 30_000;

function defaultHoldMs(): number {
  const raw = process.env['CRON_LOCK_HOLD_MS'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_CRON_LOCK_HOLD_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_CRON_LOCK_HOLD_MS;
}
let dataSource: DataSource | null = null;

export function registerCronLockDataSource(ds: DataSource | null): void {
  dataSource = ds;
}

export async function runWithCronLock<T>(
  name: string,
  task: () => Promise<T>,
  holdMs: number = defaultHoldMs(),
): Promise<T | undefined> {
  if (dataSource === null) return task();

  const runner = dataSource.createQueryRunner();
  await runner.connect();
  const key = `learnix-cron:${name}`;
  const startedAt = Date.now();

  const unlockAndRelease = async (): Promise<void> => {
    try {
      await runner.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]);
    } catch (error) {
      logger.warn(`Unlock of ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await runner.release();
    }
  };

  let acquired = false;
  try {
    const rows = (await runner.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok', [
      key,
    ])) as Array<{ ok: boolean }>;
    acquired = rows[0]?.ok === true;
  } catch (error) {
    await runner.release();
    throw error;
  }

  if (!acquired) {
    logger.log(JSON.stringify({ event: 'cron_skipped', job: name, reason: 'lock_held' }));
    await runner.release();
    return undefined;
  }

  try {
    return await task();
  } finally {
    const remaining = holdMs - (Date.now() - startedAt);
    if (remaining > 0) {
      // Keep the connection (and lock) until the hold window ends, without delaying the caller.
      setTimeout(() => void unlockAndRelease(), remaining).unref();
    } else {
      await unlockAndRelease();
    }
  }
}

/**
 * Method decorator: run the method under `runWithCronLock`. Place it BELOW `@Cron(...)` so the
 * scheduler registers the wrapped function. Skipped ticks resolve to `undefined`.
 */
export function CronSingleRunner(name: string, holdMs?: number): MethodDecorator {
  return (_target, _key, descriptor: PropertyDescriptor) => {
    const original = descriptor.value as (...args: unknown[]) => Promise<unknown>;
    descriptor.value = function (this: unknown, ...args: unknown[]): Promise<unknown> {
      return runWithCronLock(name, () => original.apply(this, args), holdMs);
    };
    return descriptor;
  };
}
