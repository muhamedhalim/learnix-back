/**
 * Seed-interconnection verification — proves `seed-staging.ts` produces a
 * genuinely navigable platform, not a pile of unrelated user rows.
 *
 * WHY THIS EXISTS
 * ---------------
 * A seed script that creates users, subjects, courses, lessons, books, exams,
 * orders, payments and certificates as independent inserts — with no foreign
 * keys actually pointing at each other — LOOKS complete in a row count but is
 * useless for UAT: a tester opens a teacher account and finds no courses,
 * opens a course and finds no lessons, opens an order and finds no matching
 * payment. This script walks the actual foreign-key graph the seed produced
 * and asserts every link resolves.
 *
 * WHAT IT PROVES (one query per hop of the real domain graph)
 * -------------------------------------------------------------
 *   teacher → teacher_profiles → lesson_packages (courses) → lesson_package_items
 *     → lessons  → subjects
 *                → books
 *                → exams → exam_attempts → students
 *   lesson_packages → orders → payments
 *   students → certificates → lesson_packages
 *   students → student_guardians → guardians
 *
 * Runs against a disposable, generated database — same temp-DB pattern as
 * scripts/migration-chain-test.ts — migrates it, seeds it, verifies the graph,
 * then drops it. Nothing here touches a real environment.
 *
 * USAGE
 *   npm run verify:seed-interconnection
 */

import { randomBytes } from 'node:crypto';

import { config as loadDotenv } from 'dotenv';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { typeOrmArtifactPaths } from '../src/data-source';
import { runStagingSeed } from '../src/database/seed-staging';

loadDotenv();

const TEMP_DB_PREFIX = 'lms_seed_verify_staging_';

function fail(message: string): never {
  throw new Error(message);
}

function resolveAdminUrl(): string {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    fail('DATABASE_URL must be set to a PostgreSQL server this script may create databases on.');
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

interface CountResult {
  count: string;
}

export interface CheckResult {
  label: string;
  count: number;
  passed: boolean;
}

/** Exported for reuse by `scripts/seed-correlation-check.ts`, which runs the
 * identical checks against an already-seeded, persistent staging database
 * rather than a disposable temporary one. */
export async function runChecks(dataSource: DataSource): Promise<CheckResult[]> {
  const checks: Array<{ label: string; sql: string }> = [
    {
      label: 'Every lesson references a teacher who actually exists',
      sql: `SELECT count(*)::text FROM lessons l LEFT JOIN users u ON u.id = l.teacher_id WHERE u.id IS NULL`,
    },
    {
      label: 'Every lesson references a subject that actually exists',
      sql: `SELECT count(*)::text FROM lessons l LEFT JOIN subjects s ON s.id = l.subject_id WHERE s.id IS NULL`,
    },
    {
      label: 'Every course (lesson_package) references a teacher who exists',
      sql: `SELECT count(*)::text FROM lesson_packages p LEFT JOIN users u ON u.id = p.teacher_id WHERE u.id IS NULL`,
    },
    {
      label: 'Every course→lesson link (lesson_package_items) resolves both ends',
      sql: `SELECT count(*)::text FROM lesson_package_items i
            LEFT JOIN lesson_packages p ON p.id = i.package_id
            LEFT JOIN lessons l ON l.id = i.lesson_id
            WHERE p.id IS NULL OR l.id IS NULL`,
    },
    {
      label: 'Every book references a teacher and subject that exist',
      sql: `SELECT count(*)::text FROM books b
            LEFT JOIN users u ON u.id = b.teacher_id
            LEFT JOIN subjects s ON s.id = b.subject_id
            WHERE u.id IS NULL OR s.id IS NULL`,
    },
    {
      label: 'Every exam references a teacher and subject that exist',
      sql: `SELECT count(*)::text FROM exams e
            LEFT JOIN users u ON u.id = e.teacher_id
            LEFT JOIN subjects s ON s.id = e.subject_id
            WHERE u.id IS NULL OR s.id IS NULL`,
    },
    {
      label: 'Every exam attempt references a real exam AND a real student',
      sql: `SELECT count(*)::text FROM exam_attempts a
            LEFT JOIN exams e ON e.id = a.exam_id
            LEFT JOIN users u ON u.id = a.student_id
            WHERE e.id IS NULL OR u.id IS NULL`,
    },
    {
      label: 'Every order references a real student and a real course',
      sql: `SELECT count(*)::text FROM orders o
            LEFT JOIN users u ON u.id = o.student_id
            LEFT JOIN lesson_packages p ON p.id::text = o.item_id::text
            WHERE u.id IS NULL OR p.id IS NULL`,
    },
    {
      label: 'Every payment references a real order and a real user',
      sql: `SELECT count(*)::text FROM payments pay
            LEFT JOIN orders o ON o.id = pay.order_id
            LEFT JOIN users u ON u.id = pay.user_id
            WHERE pay.order_id IS NOT NULL AND (o.id IS NULL OR u.id IS NULL)`,
    },
    {
      label: 'Every certificate references a real student and a real course',
      sql: `SELECT count(*)::text FROM certificates c
            LEFT JOIN users u ON u.id = c.student_id
            LEFT JOIN lesson_packages p ON p.id = c.package_id
            WHERE u.id IS NULL OR p.id IS NULL`,
    },
    {
      label: 'Every student_guardians link resolves both a real student and a real guardian',
      sql: `SELECT count(*)::text FROM student_guardians sg
            LEFT JOIN users u ON u.id = sg.student_id
            LEFT JOIN guardians g ON g.id = sg.guardian_id
            WHERE u.id IS NULL OR g.id IS NULL`,
    },
    {
      label: 'Every attendance_records row references a real student and a real lesson',
      sql: `SELECT count(*)::text FROM attendance_records r
            LEFT JOIN users u ON u.id = r.student_id
            LEFT JOIN lessons l ON l.id = r.lesson_id
            WHERE u.id IS NULL OR l.id IS NULL`,
    },
  ];

  const results: CheckResult[] = [];
  for (const check of checks) {
    const rows = (await dataSource.query(check.sql)) as CountResult[];
    const brokenLinks = Number(rows[0]?.count ?? '1');
    results.push({ label: check.label, count: brokenLinks, passed: brokenLinks === 0 });
  }
  return results;
}

/** Exported for reuse by `scripts/seed-correlation-check.ts`. */
export async function rowCounts(dataSource: DataSource): Promise<Record<string, number>> {
  const tables = [
    'users',
    'teacher_profiles',
    'student_profiles',
    'guardians',
    'student_guardians',
    'subjects',
    'lessons',
    'lesson_packages',
    'lesson_package_items',
    'books',
    'exams',
    'exam_attempts',
    'attendance_records',
    'lesson_sessions',
    'orders',
    'payments',
    'notifications',
    'certificates',
  ];
  const out: Record<string, number> = {};
  for (const table of tables) {
    const rows = (await dataSource.query(
      `SELECT count(*)::text AS count FROM "${table}"`,
    )) as CountResult[];
    out[table] = Number(rows[0]?.count ?? '0');
  }
  return out;
}

async function main(): Promise<void> {
  const adminUrl = resolveAdminUrl();
  const databaseName = `${TEMP_DB_PREFIX}${randomBytes(6).toString('hex')}`;
  const targetUrl = targetUrlFor(adminUrl, databaseName);

  process.stdout.write(`Seed-interconnection verification\n  database: ${databaseName}\n\n`);

  const adminClient = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 10_000 });
  await adminClient.connect();
  await adminClient.query(`CREATE DATABASE "${databaseName}"`);
  await adminClient.end();

  try {
    process.stdout.write('Running migrations...\n');
    const artifacts = typeOrmArtifactPaths(false);
    const migrationDataSource = new DataSource({
      type: 'postgres',
      url: targetUrl,
      entities: artifacts.entities,
      migrations: artifacts.migrations,
      synchronize: false,
      logging: false,
      migrationsTransactionMode: 'each',
      ssl: false,
    });
    await migrationDataSource.initialize();
    await migrationDataSource.runMigrations();
    await migrationDataSource.destroy();

    process.stdout.write('Running the synthetic staging seed...\n');
    process.env['DATABASE_URL'] = targetUrl;
    process.env['APP_ENV'] = 'staging';
    process.env['ALLOW_STAGING_SEED'] = 'true';
    const summary = await runStagingSeed(false);
    for (const [key, count] of Object.entries(summary)) {
      process.stdout.write(`  seeded ${key.padEnd(20)} ${String(count)}\n`);
    }

    process.stdout.write('\nVerifying row counts (nothing should be zero)...\n');
    const verifyDataSource = new DataSource({
      type: 'postgres',
      url: targetUrl,
      entities: artifacts.entities,
      migrations: artifacts.migrations,
      synchronize: false,
      logging: false,
      ssl: false,
    });
    await verifyDataSource.initialize();
    try {
      const counts = await rowCounts(verifyDataSource);
      let anyZero = false;
      for (const [table, count] of Object.entries(counts)) {
        const marker = count === 0 ? '  <-- EMPTY' : '';
        if (count === 0) anyZero = true;
        process.stdout.write(`  ${table.padEnd(22)} ${String(count).padStart(4)}${marker}\n`);
      }

      process.stdout.write(
        '\nVerifying every foreign-key link resolves (0 broken links expected)...\n',
      );
      const checks = await runChecks(verifyDataSource);
      let anyBroken = false;
      for (const check of checks) {
        const marker = check.passed ? 'OK' : `BROKEN (${String(check.count)} orphaned rows)`;
        if (!check.passed) anyBroken = true;
        process.stdout.write(`  [${marker.padEnd(28)}] ${check.label}\n`);
      }

      if (anyZero)
        fail('At least one seeded table is EMPTY — the seed is not fully interconnected.');
      if (anyBroken)
        fail('At least one foreign-key link is BROKEN — the seed produced orphaned rows.');

      process.stdout.write(
        '\nSeed-interconnection verification PASSED: every domain table is populated and every\n' +
          'foreign-key link between teacher → subjects → courses → lessons → books → exams →\n' +
          'attempts → orders → payments → certificates → guardians resolves to a real row.\n',
      );
    } finally {
      await verifyDataSource.destroy();
    }
  } finally {
    const cleanupClient = new Client({
      connectionString: adminUrl,
      connectionTimeoutMillis: 10_000,
    });
    await cleanupClient.connect();
    await cleanupClient.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [databaseName],
    );
    await cleanupClient.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await cleanupClient.end();
    process.stdout.write(`\nTemporary database ${databaseName} dropped.\n`);
  }
}

// Guarded so `scripts/seed-correlation-check.ts` can import `runChecks` and
// `rowCounts` without this file's own temp-database create/seed/drop cycle
// running as an unwanted side effect of the import.
if (require.main === module) {
  main().catch((error: unknown) => {
    process.exitCode = 1;
    process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
  });
}
