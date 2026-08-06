/**
 * Seed idempotency verification — Phase 2 (Database and Redis), proves the
 * synthetic seed's "do not create duplicate records upon restart" and "safe
 * reset" requirements against a real, disposable database (not a mock).
 *
 * WHAT IT PROVES
 * --------------
 *   1. A first `runStagingSeed(false)` succeeds and produces the expected
 *      row counts.
 *   2. A second `runStagingSeed(false)` — no `--reset` — REFUSES with
 *      `SeedAlreadyRanError` instead of silently duplicating every row.
 *   3. `runStagingSeed(true)` (`--reset`) succeeds and produces the SAME row
 *      counts as step 1 — proving reset-and-reseed does not accumulate rows
 *      across cycles.
 *   4. A second `runStagingSeed(true)` also succeeds with the same counts
 *      again, proving the reset cycle is stable and repeatable, not a
 *      one-time fluke.
 *
 * Uses the identical disposable-temporary-database pattern as
 * `migration-chain-test.ts` and `verify-seed-interconnection.ts`: created
 * fresh, migrated, exercised, and dropped in a `finally` block regardless of
 * outcome.
 *
 * USAGE: npm run verify:seed-idempotency
 */

import { randomBytes } from 'node:crypto';

import { config as loadDotenv } from 'dotenv';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { AppEnvironment, recordReader, resolveAppEnv } from '../src/config/app-env';
import { typeOrmArtifactPaths } from '../src/data-source';
import { runStagingSeed, SeedAlreadyRanError } from '../src/database/seed-staging';

loadDotenv();

// Must contain "staging" — assertSafeTarget's guard 3 requires the target
// database name to positively identify itself as staging.
const TEMP_DB_PREFIX = 'lms_staging_seed_idempotency_';

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
  const url = new URL(databaseUrl);
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
      'Refusing to run the seed-idempotency verification with APP_ENV/NODE_ENV resolving to ' +
        'production. This script creates and drops a database and seeds fabricated data into it.',
    );
  }
}

async function createTemporaryDatabase(adminUrl: string, databaseName: string): Promise<void> {
  const client = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
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

async function migrate(targetUrl: string): Promise<void> {
  const artifacts = typeOrmArtifactPaths(false);
  const dataSource = new DataSource({
    type: 'postgres',
    url: targetUrl,
    entities: artifacts.entities,
    migrations: artifacts.migrations,
    synchronize: false,
    logging: false,
    migrationsTransactionMode: 'each',
  });
  await dataSource.initialize();
  try {
    await dataSource.runMigrations();
  } finally {
    await dataSource.destroy();
  }
}

function totalRows(summary: Record<string, number>): number {
  return Object.values(summary).reduce((sum, count) => sum + count, 0);
}

async function main(): Promise<void> {
  assertSafeToRun();

  const adminUrl = resolveAdminUrl();
  const databaseName = `${TEMP_DB_PREFIX}${randomBytes(4).toString('hex')}`;
  const targetUrl = targetUrlFor(adminUrl, databaseName);

  console.log(`Creating temporary database ${databaseName}...`);
  await createTemporaryDatabase(adminUrl, databaseName);

  // runStagingSeed reads DATABASE_URL from process.env directly (it opens
  // its own DataSource), and assertSafeTarget requires both a non-production
  // APP_ENV and a staging-shaped database name — satisfied by TEMP_DB_PREFIX
  // above and the default below.
  process.env['DATABASE_URL'] = targetUrl;
  process.env['APP_ENV'] = process.env['APP_ENV'] ?? 'staging';
  process.env['ALLOW_STAGING_SEED'] = 'true';

  try {
    console.log('Running migrations...');
    await migrate(targetUrl);

    console.log('\n[1] First seed run (no --reset)...');
    const first = await runStagingSeed(false);
    const firstTotal = totalRows(first);
    console.log(`    ${String(firstTotal)} total rows created.`);
    if (firstTotal === 0) fail('First seed run created zero rows.');

    console.log('\n[2] Second seed run with no --reset — expecting a refusal...');
    let refused = false;
    try {
      await runStagingSeed(false);
    } catch (error) {
      if (error instanceof SeedAlreadyRanError) {
        refused = true;
        console.log(`    Correctly refused: ${error.message.split('\n')[0]}`);
      } else {
        throw error;
      }
    }
    if (!refused) {
      fail('Second seed run without --reset did NOT refuse — it would have duplicated every row.');
    }

    console.log('\n[3] Seed run with --reset...');
    const second = await runStagingSeed(true);
    const secondTotal = totalRows(second);
    console.log(`    ${String(secondTotal)} total rows created.`);
    if (secondTotal !== firstTotal) {
      fail(
        `Row count after reset (${String(secondTotal)}) does not match the first run ` +
          `(${String(firstTotal)}) — reset is not producing a stable, repeatable result.`,
      );
    }

    console.log('\n[4] A second --reset cycle, to prove step 3 was not a fluke...');
    const third = await runStagingSeed(true);
    const thirdTotal = totalRows(third);
    console.log(`    ${String(thirdTotal)} total rows created.`);
    if (thirdTotal !== firstTotal) {
      fail(`Row count after the second reset (${String(thirdTotal)}) drifted from the baseline.`);
    }

    console.log(
      '\nPASS: the seed refuses to duplicate without --reset, and --reset produces a ' +
        'stable, repeatable row count across multiple cycles.',
    );
  } finally {
    console.log(`\nDropping temporary database ${databaseName}...`);
    await dropTemporaryDatabase(adminUrl, databaseName);
  }
}

main().catch((error: unknown) => {
  console.error('Seed idempotency verification FAILED:', error);
  process.exitCode = 1;
});
