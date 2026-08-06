/**
 * Internal helper for `verify-migration-lock.ts`'s bounded-wait scenario.
 * Spawned as a genuinely separate OS process — not a second concurrent task
 * inside the parent's own event loop — because two real Railway replicas
 * running `migrate-cli.ts` are always separate processes, and because racing
 * two `withMigrationAdvisoryLock` calls inside a single Node.js process was
 * found, empirically, to produce unreliable timing specifically for the
 * `lock_timeout`-bounded path (Scenario 1's plain blocking proof has no
 * timeout involved and is unaffected, so it stays in-process). Two isolated
 * `pg.Client` connections in separate OS processes reproduce the correct,
 * expected ~timeout-bound failure; two `DataSource`s racing inside one
 * process — even using raw `pg`, with no TypeORM involved — did not. This
 * file exists so the verification actually matches the topology it claims to
 * verify, rather than a topology that happens to expose an unrelated
 * single-process timing artifact.
 *
 * Usage:
 *   node -r ts-node/register -r tsconfig-paths/register lock-worker.ts hold <ms>
 *   node -r ts-node/register -r tsconfig-paths/register lock-worker.ts wait <ms>
 *
 * `hold <ms>`: acquires the lock, prints `ACQUIRED` the instant it does (the
 * parent synchronises on this line), holds for `<ms>`, releases, exits 0.
 *
 * `wait <ms>`: sets `MIGRATION_LOCK_TIMEOUT_MS=<ms>`, attempts to acquire the
 * same lock, and prints exactly one JSON line describing the outcome
 * (`acquired` | `timeout` | `error`) and the elapsed time. Always exits 0 —
 * the parent reads the JSON, not the exit code, so a deliberately-expected
 * timeout is not confused with this worker script itself failing.
 */

import { DataSource } from 'typeorm';

import {
  MigrationLockTimeoutError,
  withMigrationAdvisoryLock,
} from '../../src/database/migration-lock.util';

async function main(): Promise<void> {
  const mode = process.argv[2];
  const ms = Number(process.argv[3]);
  if ((mode !== 'hold' && mode !== 'wait') || !Number.isFinite(ms)) {
    throw new Error(
      `Usage: lock-worker.ts <hold|wait> <ms>. Received: ${process.argv.slice(2).join(' ')}`,
    );
  }

  const url = process.env['DATABASE_URL'] ?? '';
  const dataSource = new DataSource({ type: 'postgres', url, logging: false });
  await dataSource.initialize();

  try {
    if (mode === 'hold') {
      await withMigrationAdvisoryLock(dataSource, async () => {
        process.stdout.write('ACQUIRED\n');
        await new Promise((resolve) => setTimeout(resolve, ms));
      });
      return;
    }

    // mode === 'wait'
    process.env['MIGRATION_LOCK_TIMEOUT_MS'] = String(ms);
    const start = Date.now();
    try {
      await withMigrationAdvisoryLock(dataSource, async () => undefined);
      process.stdout.write(
        `${JSON.stringify({ outcome: 'acquired', elapsedMs: Date.now() - start })}\n`,
      );
    } catch (error) {
      const elapsedMs = Date.now() - start;
      const outcome = error instanceof MigrationLockTimeoutError ? 'timeout' : 'error';
      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(`${JSON.stringify({ outcome, elapsedMs, message })}\n`);
    }
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
