/**
 * Migration rollback test (spec 004 / T127) — applies the whole chain to a genuinely empty,
 * temporary database, then rolls back and re-applies the newest migrations with TypeORM's own
 * `undoLastMigration` / `runMigrations`, checking each index is absent after `down()`, present
 * and `indisvalid` after `up()`, and that no INVALID index remains.
 *
 * Same safety rules as `migration-chain-test.ts`: generated database name with its own prefix,
 * refuses production, refuses an existing name, drops the database in `finally`.
 *
 * USAGE   npm run test:migrations:rollback
 *         (MIGRATION_TEST_ADMIN_URL or DATABASE_URL, as for the chain test)
 */

import { randomBytes } from 'node:crypto';

import { config as loadDotenv } from 'dotenv';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { resolveAppEnv, AppEnvironment, recordReader } from '../src/config/app-env';
import { typeOrmArtifactPaths } from '../src/data-source';

loadDotenv();

const TEMP_DB_PREFIX = 'lms_migration_rollback_';

function fail(message: string): never {
  throw new Error(message);
}

/** Connection string for the `postgres` maintenance database. */
function resolveAdminUrl(): string {
  const explicit = process.env['MIGRATION_TEST_ADMIN_URL'];
  if (explicit !== undefined && explicit.trim() !== '') return explicit.trim();

  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    fail(
      'Neither MIGRATION_TEST_ADMIN_URL nor DATABASE_URL is set. Point one of them at a ' +
        'PostgreSQL server the test may create and drop databases on.',
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

/** Same server and credentials as the admin URL, but the temporary database. */
function targetUrlFor(adminUrl: string, databaseName: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

/** Host only. Used for log lines; never includes credentials. */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '<unparseable>';
  }
}

function assertSafeToRun(): void {
  const appEnv = resolveAppEnv(recordReader(process.env as Record<string, unknown>));
  if (appEnv === AppEnvironment.Production) {
    fail(
      'Refusing to run the migration-chain test with APP_ENV/NODE_ENV resolving to production. ' +
        'This script creates and drops databases and must never run against a production server.',
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
    // Identifier cannot be parameterised; it is generated here from a fixed
    // prefix plus hex, so it contains no user input.
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
    // Detach anything still holding the database open so DROP cannot hang.
    await client.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [databaseName],
    );
    await client.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
  } finally {
    await client.end();
  }
}

/** Newest migrations to roll back (newest first) and the index each one owns. */
const ROLLBACK_TARGETS: Array<{ migrationName: string; indexName: string }> = [
  {
    migrationName: 'AddAuditLogsTargetIndex2113000000000',
    indexName: 'IDX_audit_logs_target_created',
  },
  {
    migrationName: 'AddLedgerSettlementIdIndex2112000000000',
    indexName: 'IDX_ledger_settlement_id',
  },
  {
    migrationName: 'AddDiscountUsagePaymentIndex2111000000000',
    indexName: 'IDX_discount_usage_payment',
  },
];

async function indexState(
  dataSource: DataSource,
  indexName: string,
): Promise<{ exists: boolean; valid: boolean }> {
  const rows = (await dataSource.query(
    `SELECT i.indisvalid AS valid
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = $1`,
    [indexName],
  )) as Array<{ valid: boolean }>;
  return { exists: rows.length > 0, valid: rows[0]?.valid === true };
}

async function runRollback(targetUrl: string): Promise<string[]> {
  const artifacts = typeOrmArtifactPaths(false);
  const dataSource = new DataSource({
    type: 'postgres',
    url: targetUrl,
    entities: artifacts.entities,
    migrations: artifacts.migrations,
    synchronize: false,
    logging: ['error', 'warn'],
    migrationsTransactionMode: 'each',
    ssl: false,
  });
  const log: string[] = [];
  await dataSource.initialize();
  try {
    await dataSource.runMigrations({ transaction: 'each' });

    for (const target of ROLLBACK_TARGETS) {
      const before = await indexState(dataSource, target.indexName);
      if (!before.exists || !before.valid) {
        fail(
          `${target.indexName}: expected a valid index after the chain, got ${JSON.stringify(before)}`,
        );
      }
    }

    // `undoLastMigration` cannot be used: `HardenTeacherPayoutP1P2205600000000` carries a 13-digit
    // suffix (2205600000000) that TypeORM parses as the newest timestamp, so it sorts after 2112.
    // Each target's own down()/up() is executed instead, on one query runner, outside a transaction
    // (the migrations are `transaction = false` because of CREATE/DROP INDEX CONCURRENTLY).
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    try {
      for (const target of ROLLBACK_TARGETS) {
        const migration = dataSource.migrations.find((m) => m.name === target.migrationName);
        if (!migration) fail(`${target.migrationName} was not discovered`);
        if (migration.transaction !== false)
          fail(`${target.migrationName} must declare transaction = false`);
        await migration.down(runner);
        const after = await indexState(dataSource, target.indexName);
        if (after.exists) fail(`${target.indexName}: still present after down()`);
        log.push(`down ${target.migrationName}: ${target.indexName} absent`);
      }
      for (const target of [...ROLLBACK_TARGETS].reverse()) {
        const migration = dataSource.migrations.find((m) => m.name === target.migrationName);
        if (!migration) fail(`${target.migrationName} was not discovered`);
        await migration.up(runner);
        const state = await indexState(dataSource, target.indexName);
        if (!state.exists || !state.valid) {
          fail(
            `${target.indexName}: expected a valid index after up(), got ${JSON.stringify(state)}`,
          );
        }
        log.push(`up ${target.migrationName}: ${target.indexName} present, indisvalid`);
      }
    } finally {
      await runner.release();
    }

    const invalid = (await dataSource.query(
      'SELECT indexrelid::regclass::text AS name FROM pg_index WHERE NOT indisvalid',
    )) as Array<{ name: string }>;
    if (invalid.length > 0)
      fail(`INVALID indexes remain: ${invalid.map((r) => r.name).join(', ')}`);
    log.push('no INVALID index in the database');

    if (await dataSource.showMigrations()) fail('migrations are pending after the round trip');
    return log;
  } finally {
    await dataSource.destroy();
  }
}

async function main(): Promise<void> {
  assertSafeToRun();
  const adminUrl = resolveAdminUrl();
  const databaseName = `${TEMP_DB_PREFIX}${randomBytes(6).toString('hex')}`;
  const targetUrl = targetUrlFor(adminUrl, databaseName);
  process.stdout.write(
    `Migration-rollback test\n  server:   ${safeHost(adminUrl)}\n  database: ${databaseName} (temporary)\n\n`,
  );
  await createTemporaryDatabase(adminUrl, databaseName);
  try {
    for (const line of await runRollback(targetUrl)) process.stdout.write(`  ${line}\n`);
    process.stdout.write(`\nMigration rollback verified.\n`);
  } finally {
    await dropTemporaryDatabase(adminUrl, databaseName);
    process.stdout.write(`Temporary database ${databaseName} dropped.\n`);
  }
}

main().catch((error: unknown) => {
  process.exitCode = 1;
  process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
});
