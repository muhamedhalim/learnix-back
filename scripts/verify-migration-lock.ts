/**
 * Concurrent migration-lock verification — Phase 2 (Database and Redis),
 * plan item P2-09 / finding R4's acceptance test: "two concurrent runners:
 * one waits."
 *
 * WHAT IT PROVES
 * --------------
 * Two independent `DataSource` connections (standing in for two Railway
 * replicas both invoking `migration:run:prod` at once) race for the same
 * Postgres advisory lock (`src/database/migration-lock.util.ts`). Connection
 * A acquires the lock and deliberately holds it for `HOLD_MS`; connection B
 * attempts to acquire the identical lock at effectively the same moment. If
 * the lock genuinely serialises them, B's `pg_advisory_lock()` call blocks
 * for approximately `HOLD_MS` before returning — this script measures that
 * wait and fails loudly if B acquired the lock suspiciously fast (which would
 * mean the two connections were not actually contending for the same lock).
 *
 * This does not run the real migration content — that is already proven
 * separately by `scripts/migration-chain-test.ts`. This isolates and proves
 * only the concurrency primitive itself, against a real Postgres server, not
 * a mock.
 *
 * Runs against a disposable temporary database, dropped in `finally`, using
 * the identical safety pattern as `migration-chain-test.ts` (never runs when
 * APP_ENV/NODE_ENV resolves to production; the database name always carries
 * a fixed, script-generated prefix).
 *
 * USAGE: npm run verify:migration-lock
 */

import { randomBytes } from 'node:crypto';

import { config as loadDotenv } from 'dotenv';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { AppEnvironment, recordReader, resolveAppEnv } from '../src/config/app-env';
import { withMigrationAdvisoryLock } from '../src/database/migration-lock.util';

loadDotenv();

const TEMP_DB_PREFIX = 'lms_migration_lock_verify_';
const HOLD_MS = 1500;
/** B's wait must be at least this fraction of A's hold to count as "really
 * blocked" rather than a lucky/incidental delay. */
const MIN_ACCEPTABLE_WAIT_RATIO = 0.6;

function fail(message: string): never {
  throw new Error(message);
}

function resolveAdminUrl(): string {
  const explicit = process.env['MIGRATION_TEST_ADMIN_URL'];
  if (explicit !== undefined && explicit.trim() !== '') return explicit.trim();

  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    fail(
      'Neither MIGRATION_TEST_ADMIN_URL nor DATABASE_URL is set. Point one of them at a ' +
        'PostgreSQL server this script may create and drop a database on.',
    );
  }

  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return fail('DATABASE_URL is not a valid URL, and MIGRATION_TEST_ADMIN_URL was not supplied.');
  }
  url.pathname = '/postgres';
  return url.toString();
}

function targetUrlFor(adminUrl: string, databaseName: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function assertSafeToRun(): void {
  const appEnv = resolveAppEnv(recordReader(process.env as Record<string, unknown>));
  if (appEnv === AppEnvironment.Production) {
    fail(
      'Refusing to run the migration-lock verification with APP_ENV/NODE_ENV resolving to ' +
        'production. This script creates and drops a database and must never run against a ' +
        'production server.',
    );
  }
}

async function createTemporaryDatabase(adminUrl: string, databaseName: string): Promise<void> {
  const client = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      databaseName,
    ]);
    if (existing.rowCount !== null && existing.rowCount > 0) {
      fail(`Temporary database ${databaseName} already exists. Refusing to reuse it.`);
    }
    await client.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await client.end();
  }
}

async function dropTemporaryDatabase(adminUrl: string, databaseName: string): Promise<void> {
  if (!databaseName.startsWith(TEMP_DB_PREFIX)) {
    fail(`Refusing to drop "${databaseName}": it does not carry the ${TEMP_DB_PREFIX} prefix.`);
  }
  const client = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    await client.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [databaseName],
    );
    await client.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  assertSafeToRun();

  const adminUrl = resolveAdminUrl();
  const databaseName = `${TEMP_DB_PREFIX}${randomBytes(4).toString('hex')}`;
  const targetUrl = targetUrlFor(adminUrl, databaseName);

  console.log(`Creating temporary database ${databaseName}...`);
  await createTemporaryDatabase(adminUrl, databaseName);

  const connectionA = new DataSource({ type: 'postgres', url: targetUrl, logging: false });
  const connectionB = new DataSource({ type: 'postgres', url: targetUrl, logging: false });

  try {
    await connectionA.initialize();
    await connectionB.initialize();

    let aAcquiredAt = 0;
    let aReleasedAt = 0;
    let bAcquiredAt = 0;
    let bWaitedMs = 0;

    const holderA = withMigrationAdvisoryLock(connectionA, async () => {
      aAcquiredAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
      aReleasedAt = Date.now();
    });

    // Give A a small head start so it reliably wins the race to acquire
    // first — the point under test is B's wait, not who wins the race.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const bStartedAt = Date.now();
    const contenderB = withMigrationAdvisoryLock(connectionB, async () => {
      bAcquiredAt = Date.now();
      bWaitedMs = bAcquiredAt - bStartedAt;
    });

    await Promise.all([holderA, contenderB]);

    console.log(`A held the lock from ${String(aAcquiredAt)} to ${String(aReleasedAt)}.`);
    console.log(`B waited ${String(bWaitedMs)}ms before acquiring at ${String(bAcquiredAt)}.`);

    if (bAcquiredAt < aReleasedAt) {
      fail(
        `B acquired the lock at ${String(bAcquiredAt)}, before A released it at ` +
          `${String(aReleasedAt)}. The lock did not serialise the two connections.`,
      );
    }

    const minAcceptableWaitMs = HOLD_MS * MIN_ACCEPTABLE_WAIT_RATIO;
    if (bWaitedMs < minAcceptableWaitMs) {
      fail(
        `B only waited ${String(bWaitedMs)}ms, less than the ${String(minAcceptableWaitMs)}ms ` +
          "minimum expected if it had genuinely blocked behind A's lock.",
      );
    }

    console.log(
      'PASS: the second connection genuinely blocked behind the first — the advisory lock ' +
        'serialises concurrent migration runners as designed.',
    );
  } finally {
    await connectionA.destroy().catch(() => undefined);
    await connectionB.destroy().catch(() => undefined);
    console.log(`Dropping temporary database ${databaseName}...`);
    await dropTemporaryDatabase(adminUrl, databaseName);
  }
}

main().catch((error: unknown) => {
  console.error('Migration-lock verification FAILED:', error);
  process.exitCode = 1;
});
