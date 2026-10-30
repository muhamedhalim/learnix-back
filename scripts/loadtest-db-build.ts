/**
 * Builds the load-test database schema from the real migration chain (not `synchronize`).
 *
 * WHY: the e2e database is built from entity metadata, so it lacks every migration-only index and carries
 * entity-only drift indexes production does not have. EXPLAIN plans and latency measured there would not
 * describe production. See docs/performance/load-test-results.md ("Schema parity").
 *
 * USAGE
 *   DATABASE_URL=postgres://postgres:lms_load_password@localhost:55433/lms_load npm run loadtest:db:build
 *   npm run loadtest:db:build -- --recreate     # drop and recreate the database first (guarded as below)
 *
 * SAFETY: refuses unless the database name contains "load" and the host is local (localhost, 127.0.0.1, [::1]).
 * Load data is synthetic and the database disposable; a deployed database must never match both rules.
 */
import { config as loadDotenv } from 'dotenv';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { typeOrmArtifactPaths } from '../src/data-source';

loadDotenv({ quiet: true });

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function fail(message: string): never {
  throw new Error(message);
}

function parseTarget(): { url: URL; database: string } {
  const raw = process.env['DATABASE_URL'];
  if (raw === undefined || raw.trim() === '') fail('DATABASE_URL is not set.');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail('DATABASE_URL is not a valid URL.');
  }
  const database = url.pathname.replace(/^\//, '').toLowerCase();
  if (!/load/.test(database)) {
    fail(
      `Refusing to build load-test schema in "${database}": the database name must contain "load".`,
    );
  }
  if (!LOCAL_HOSTS.has(url.hostname)) {
    fail(
      `Refusing to build load-test schema on host "${url.hostname}": only a local database is allowed.`,
    );
  }
  return { url, database };
}

async function recreate(url: URL, database: string): Promise<void> {
  const admin = new URL(url.toString());
  admin.pathname = '/postgres';
  const client = new Client({
    connectionString: admin.toString(),
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  try {
    await client.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [database],
    );
    // The name was validated above (contains "load", local host); identifiers cannot be parameterised.
    await client.query(`DROP DATABASE IF EXISTS "${database}"`);
    await client.query(`CREATE DATABASE "${database}"`);
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const { url, database } = parseTarget();
  if (process.argv.includes('--recreate')) {
    console.log(`Recreating database ${database} on ${url.host}`);
    await recreate(url, database);
  }

  const artifacts = typeOrmArtifactPaths(false);
  const dataSource = new DataSource({
    type: 'postgres',
    url: url.toString(),
    entities: artifacts.entities,
    migrations: artifacts.migrations,
    synchronize: false,
    logging: ['error', 'warn'],
    migrationsTransactionMode: 'each',
    ssl: false,
  });

  await dataSource.initialize();
  try {
    const started = Date.now();
    const applied = await dataSource.runMigrations({ transaction: 'each' });
    const pending = await dataSource.showMigrations();
    // pg_stat_statements is never created by a migration (docs/performance: PERF-19); the load stack preloads the library.
    await dataSource.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
    const rows = (await dataSource.query(
      "SELECT count(*)::int AS count FROM pg_indexes WHERE schemaname = 'public'",
    )) as Array<{ count: number }>;
    console.log(
      JSON.stringify({
        database,
        host: url.host,
        appliedNow: applied.length,
        pending,
        publicIndexes: rows[0]?.count ?? null,
        ms: Date.now() - started,
      }),
    );
    if (pending) fail('Migrations are still pending after the run.');
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
