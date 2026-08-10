import { randomUUID } from 'node:crypto';

import { config as loadDotenv } from 'dotenv';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { resolveDatabaseSsl } from '../src/common/utils/database-ssl.util';
import { typeOrmArtifactPaths } from '../src/data-source';
import { runPrelaunchReset } from '../src/database/prelaunch-reset';

loadDotenv();

const PREFIX = 'learnix_prelaunch_reset_test_';

function quotedDatabase(name: string): string {
  if (!new RegExp(`^${PREFIX}[a-f0-9]+$`, 'u').test(name)) {
    throw new Error(`Unsafe temporary database name: ${name}`);
  }
  return `"${name}"`;
}

async function main(): Promise<void> {
  const sourceUrl = process.env['MIGRATION_TEST_ADMIN_URL'] ?? process.env['DATABASE_URL'];
  if (!sourceUrl) throw new Error('DATABASE_URL or MIGRATION_TEST_ADMIN_URL is required.');
  const parsed = new URL(sourceUrl);
  if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname.toLowerCase())) {
    throw new Error('Pre-launch reset verification may only create a database on localhost.');
  }

  const name = `${PREFIX}${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const target = new URL(sourceUrl);
  target.pathname = `/${name}`;
  const maintenance = new URL(sourceUrl);
  maintenance.pathname = '/postgres';
  const admin = new Client({
    connectionString: maintenance.toString(),
    ssl: resolveDatabaseSsl(maintenance.toString()),
  });

  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${quotedDatabase(name)}`);
    const artifacts = typeOrmArtifactPaths(false);
    const dataSource = new DataSource({
      type: 'postgres',
      url: target.toString(),
      entities: artifacts.entities,
      migrations: artifacts.migrations,
      migrationsTransactionMode: 'each',
      synchronize: false,
      logging: ['error'],
      ssl: resolveDatabaseSsl(target.toString()),
    });
    await dataSource.initialize();
    let migrationsBefore = 0;
    try {
      await dataSource.runMigrations();
      migrationsBefore = Number(
        (
          (await dataSource.query('SELECT COUNT(*)::int AS count FROM migrations')) as Array<{
            count: number;
          }>
        )[0]?.count ?? 0,
      );
      await dataSource.query(`
        INSERT INTO users (username, name, email, phone, password_hash, role, status, is_active)
        VALUES ('reset_test_teacher', 'Reset Test Teacher', 'reset@test.invalid',
                '01000000001', 'not-a-real-hash', 'teacher', 'approved', true)
      `);
      await dataSource.query(`
        INSERT INTO health_metrics
          (component_id, category, status, resolution, bucket_start, metrics)
        VALUES ('reset-test', 'runtime', 'healthy', 'raw', now(), '{}'::jsonb)
      `);
    } finally {
      await dataSource.destroy();
    }

    Object.assign(process.env, {
      DATABASE_URL: target.toString(),
      APP_ENV: 'test',
      NODE_ENV: 'test',
      REDIS_URL: '',
      RESET_PRELAUNCH_DATA: 'true',
      RESET_PRELAUNCH_BACKUP_CONFIRMED: 'true',
      RESET_PRELAUNCH_BACKUP_REFERENCE: 'isolated-temporary-database',
      RESET_PRELAUNCH_SERVICES_STOPPED: 'true',
      RESET_PRELAUNCH_TARGET: `${target.hostname}/${name}`,
    });

    await runPrelaunchReset({ dryRun: false, verify: false, skipExternal: true });
    await runPrelaunchReset({ dryRun: false, verify: false, skipExternal: true });

    const verify = new Client({
      connectionString: target.toString(),
      ssl: resolveDatabaseSsl(target.toString()),
    });
    await verify.connect();
    try {
      const result = await verify.query(`
        SELECT
          (SELECT COUNT(*)::int FROM migrations) AS migrations,
          (SELECT COUNT(*)::int FROM users) AS users,
          (SELECT COUNT(*)::int FROM users WHERE role = 'admin') AS admins,
          (SELECT COUNT(*)::int FROM rank_tiers) AS ranks,
          (SELECT COUNT(*)::int FROM health_alert_rules) AS rules,
          (SELECT COUNT(*)::int FROM health_metrics) AS health_metrics
      `);
      const row = result.rows[0] as Record<string, number>;
      if (
        row['migrations'] !== migrationsBefore ||
        row['users'] !== 1 ||
        row['admins'] !== 1 ||
        row['ranks'] !== 5 ||
        row['rules'] !== 10 ||
        row['health_metrics'] !== 0
      ) {
        throw new Error(`Unexpected post-reset state: ${JSON.stringify(row)}`);
      }
      process.stdout.write(
        `PASS: isolated reset is repeatable; ${String(migrationsBefore)} migrations preserved, admin/system rows recreated.\n`,
      );
    } finally {
      await verify.end();
    }
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${quotedDatabase(name)} WITH (FORCE)`);
    await admin.end();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
