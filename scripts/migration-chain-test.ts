/**
 * Migration-chain test — runs the ENTIRE migration history against a genuinely
 * empty PostgreSQL database, then throws the database away.
 *
 * WHY THIS EXISTS
 * ---------------
 * The E2E suite materialises its schema with `TYPEORM_SYNCHRONIZE=true`
 * (`test/.env.test`, `.github/workflows/ci-cd.yml`), building tables directly from
 * entity metadata. That is fast and convenient, and it means **no test in this
 * repository has ever executed the migration files.** The 104-file chain that
 * every real deployment depends on is, today, unverified.
 *
 * `synchronize` cannot substitute for this. It produces the schema the entities
 * describe; migrations produce the schema the *history* describes. When those
 * two diverge — a migration that references a column a later migration drops, a
 * migration that runs fine against a populated database but fails on an empty
 * one — `synchronize` reports success and the next fresh deployment fails.
 * Standing up the staging database is otherwise the first time anyone finds out.
 *
 * WHAT IT PROVES
 * --------------
 *   1. Every migration applies, in timestamp order, from nothing.
 *   2. The recorded count matches the number of migration files discovered.
 *   3. `showMigrations()` reports no pending work afterwards.
 *   4. The resulting schema is non-trivial (guards against a chain that
 *      "succeeds" by doing nothing).
 *
 * The temporary database is dropped in a `finally` block, including on failure,
 * so a failed run leaves nothing behind.
 *
 * USAGE
 * -----
 *   npm run test:migrations
 *
 * Connection: `MIGRATION_TEST_ADMIN_URL` if set; otherwise derived from
 * `DATABASE_URL` by swapping the database name for `postgres` (the maintenance
 * database). The script therefore needs no credentials of its own and never
 * prints the ones it borrows.
 *
 * SAFETY
 * ------
 * This script CREATEs and DROPs a database. Four independent refusals protect
 * against it ever pointing at something real:
 *   - the target name is always generated here, never supplied;
 *   - the generated name must carry the `TEMP_DB_PREFIX`;
 *   - it refuses to run when APP_ENV resolves to production;
 *   - it refuses if the generated name somehow already exists.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { config as loadDotenv } from 'dotenv';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { resolveAppEnv, AppEnvironment, recordReader } from '../src/config/app-env';
import { typeOrmArtifactPaths } from '../src/data-source';

loadDotenv();

const TEMP_DB_PREFIX = 'lms_migration_chain_';

interface Report {
  temporaryDatabase: string;
  discoveredMigrations: number;
  appliedMigrations: number;
  recordedMigrations: number;
  pendingAfterRun: boolean;
  tableCount: number;
  /** SQL TypeORM would still run to make the migrated schema match the entities. */
  driftStatements: string[];
  /** Migration-only objects (see MIGRATION_ONLY_OBJECTS) absent after the chain. */
  missingMigrationOnlyObjects: string[];
  durationMs: number;
}

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

async function runChain(
  targetUrl: string,
): Promise<Omit<Report, 'temporaryDatabase' | 'durationMs'>> {
  const artifacts = typeOrmArtifactPaths(false);

  const dataSource = new DataSource({
    type: 'postgres',
    url: targetUrl,
    entities: artifacts.entities,
    migrations: artifacts.migrations,
    // Never true. The entire point is to exercise the migration files.
    synchronize: false,
    logging: ['error', 'warn'],
    migrationsTransactionMode: 'each',
    ssl: false,
  });

  await dataSource.initialize();
  try {
    const discoveredMigrations = dataSource.migrations.length;
    if (discoveredMigrations === 0) {
      fail(
        'No migrations were discovered. Check the glob in src/data-source.ts — a chain test that ' +
          'runs zero migrations proves nothing.',
      );
    }

    const applied = await dataSource.runMigrations({ transaction: 'each' });

    // TypeORM returns true when work REMAINS.
    const pendingAfterRun = await dataSource.showMigrations();

    const recorded = (await dataSource.query(
      'SELECT COUNT(*)::int AS count FROM migrations',
    )) as Array<{ count: number }>;

    const tables = (await dataSource.query(
      "SELECT COUNT(*)::int AS count FROM information_schema.tables WHERE table_schema = 'public'",
    )) as Array<{ count: number }>;

    // Schema drift: what `schema:log` would still change after every migration ran.
    // The schema builder reads TypeORM's metadata table for generated columns; migrations never
    // create it (only `synchronize` does), so provide an empty one to let the comparison run.
    await dataSource.query(
      'CREATE TABLE IF NOT EXISTS "typeorm_metadata" ("type" varchar NOT NULL, "database" varchar, "schema" varchar, "table" varchar, "name" varchar, "value" text)',
    );
    // Objects only a migration can create. The e2e schema is built by `synchronize` from entities, so
    // none of these exist there and no e2e test can notice if a migration stops creating them (MP-25).
    const present = (await dataSource.query(
      `SELECT indexname AS name FROM pg_indexes WHERE schemaname = 'public'
       UNION SELECT conname FROM pg_constraint
       UNION SELECT tgname FROM pg_trigger WHERE NOT tgisinternal`,
    )) as Array<{ name: string }>;
    const presentNames = new Set(present.map((row) => row.name));
    const missingMigrationOnlyObjects = MIGRATION_ONLY_OBJECTS.filter((name) => !presentNames.has(name));

    const sqlInMemory = await dataSource.driver.createSchemaBuilder().log();
    const driftStatements = sqlInMemory.upQueries.map((q) => q.query.replace(/\s+/g, ' ').trim());

    return {
      missingMigrationOnlyObjects,
      driftStatements,
      discoveredMigrations,
      appliedMigrations: applied.length,
      recordedMigrations: recorded[0]?.count ?? 0,
      pendingAfterRun,
      tableCount: tables[0]?.count ?? 0,
    };
  } finally {
    await dataSource.destroy();
  }
}

/** Marketplace indexes, constraints and triggers that exist only because a migration created them. */
const MIGRATION_ONLY_OBJECTS = [
  'IDX_mp_courses_title_trgm',
  'IDX_mp_courses_title_ar_trgm',
  'IDX_mp_courses_summary_trgm',
  'IDX_mp_courses_description_trgm',
  'IDX_mp_courses_featured',
  'IDX_mp_applications_retention_sweep',
  'CHK_mp_applications_years_nonneg',
  'CHK_mp_orders_split',
  'CHK_mp_orders_zero_value',
  'FK_mp_payout_accounts_instructor',
  'FK_mp_payout_requests_account',
  'FK_mp_payout_requests_instructor',
  'TRG_mp_ledger_immutable',
];

const DRIFT_BASELINE = join(__dirname, 'schema-drift-baseline.json');

/**
 * Ratchet, not a clean-slate demand: drift that already existed when the check was added is
 * recorded in the baseline and tolerated; ANY new statement fails the run. Fixing drift shrinks
 * the baseline (`UPDATE_DRIFT_BASELINE=1 npm run test:migrations` rewrites it, never grows it in CI).
 */
function driftProblems(statements: string[]): string[] {
  const unique = [...new Set(statements)].sort();
  if (process.env['UPDATE_DRIFT_BASELINE'] === '1') {
    writeFileSync(DRIFT_BASELINE, `${JSON.stringify(unique, null, 2)}
`);
    return [];
  }
  const baseline = new Set<string>(
    existsSync(DRIFT_BASELINE)
      ? (JSON.parse(readFileSync(DRIFT_BASELINE, 'utf8')) as string[])
      : [],
  );
  return unique
    .filter((statement) => !baseline.has(statement))
    .map((statement) => `new schema drift (entity differs from migrated schema): ${statement}`);
}

function assertReport(report: Report): void {
  const problems: string[] = [...driftProblems(report.driftStatements)];

  for (const name of report.missingMigrationOnlyObjects) {
    problems.push(`migration-only database object is missing after the chain: ${name}`);
  }

  if (report.appliedMigrations !== report.discoveredMigrations) {
    problems.push(
      `applied ${report.appliedMigrations} of ${report.discoveredMigrations} discovered migrations`,
    );
  }
  if (report.recordedMigrations !== report.discoveredMigrations) {
    problems.push(
      `the migrations table records ${report.recordedMigrations}, expected ${report.discoveredMigrations}`,
    );
  }
  if (report.pendingAfterRun) {
    problems.push('migrations are still pending after the run');
  }
  if (report.tableCount < 2) {
    problems.push(
      `only ${report.tableCount} table(s) exist afterwards — the chain applied but built nothing`,
    );
  }

  if (problems.length > 0) {
    fail(`Migration chain verification FAILED:\n  - ${problems.join('\n  - ')}`);
  }
}

async function main(): Promise<void> {
  assertSafeToRun();

  const adminUrl = resolveAdminUrl();
  const databaseName = `${TEMP_DB_PREFIX}${randomBytes(6).toString('hex')}`;
  const targetUrl = targetUrlFor(adminUrl, databaseName);

  process.stdout.write(`Migration-chain test\n`);
  process.stdout.write(`  server:   ${safeHost(adminUrl)}\n`);
  process.stdout.write(`  database: ${databaseName} (temporary)\n\n`);

  const startedAt = Date.now();
  await createTemporaryDatabase(adminUrl, databaseName);

  try {
    const outcome = await runChain(targetUrl);
    const report: Report = {
      temporaryDatabase: databaseName,
      durationMs: Date.now() - startedAt,
      ...outcome,
    };

    process.stdout.write(`  discovered migrations : ${String(report.discoveredMigrations)}\n`);
    process.stdout.write(`  applied migrations    : ${String(report.appliedMigrations)}\n`);
    process.stdout.write(`  recorded in table     : ${String(report.recordedMigrations)}\n`);
    process.stdout.write(`  pending after run     : ${String(report.pendingAfterRun)}\n`);
    process.stdout.write(`  public tables created : ${String(report.tableCount)}\n`);
    process.stdout.write(`  drift statements      : ${String(report.driftStatements.length)} (baseline-tolerated)\n`);
    process.stdout.write(`  duration              : ${String(report.durationMs)}ms\n\n`);

    assertReport(report);
    process.stdout.write('Migration chain verified: all migrations applied, none pending.\n');
  } finally {
    await dropTemporaryDatabase(adminUrl, databaseName);
    process.stdout.write(`Temporary database ${databaseName} dropped.\n`);
  }
}

main().catch((error: unknown) => {
  process.exitCode = 1;
  process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
});
