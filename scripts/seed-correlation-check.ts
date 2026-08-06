/**
 * Seed data correlation check — Phase 2 (Database and Redis), the "data
 * correlation check command" requirement for the synthetic seed.
 *
 * WHY THIS IS SEPARATE FROM `verify-seed-interconnection.ts`
 * ------------------------------------------------------------
 * That script proves the seed CODE produces correlated data by seeding a
 * disposable, throwaway temporary database from empty and dropping it
 * afterwards — a development/CI-time proof about the seed logic. This
 * script instead runs the identical 12 foreign-key checks (imported, not
 * duplicated) against `DATABASE_URL` directly — a real, persistent,
 * already-seeded staging database — and never creates or drops anything.
 * Use this operationally, any time, to confirm an already-seeded staging
 * environment's data is still fully interconnected (e.g. after a manual
 * edit, a partial re-seed, or before handing the environment to UAT
 * testers).
 *
 * SAFETY
 * ------
 * Read-only (`SELECT` only), but still runs `assertSafeTarget` first — the
 * same guard `seed-staging.ts` itself uses — because "verify identity
 * before running against any DB" applies to every tool this seed system
 * ships, not only the one that writes.
 *
 * USAGE: npm run verify:seed-correlation
 */

import { config as loadDotenv } from 'dotenv';
import { DataSource } from 'typeorm';

import { assertSafeTarget } from '../src/database/seed-staging';
import { rowCounts, runChecks } from './verify-seed-interconnection';

loadDotenv();

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  assertSafeTarget(process.env, databaseUrl);

  const dataSource = new DataSource({
    type: 'postgres',
    url: databaseUrl ?? '',
    logging: false,
  });

  await dataSource.initialize();
  try {
    console.log('Seed data correlation check\n');

    const counts = await rowCounts(dataSource);
    const emptyTables = Object.entries(counts).filter(([, count]) => count === 0);

    console.log('Row counts:');
    for (const [table, count] of Object.entries(counts)) {
      console.log(`  ${table.padEnd(24)} ${String(count)}`);
    }
    console.log('');

    const checks = await runChecks(dataSource);
    let anyFailed = emptyTables.length > 0;

    for (const check of checks) {
      console.log(
        `${check.passed ? 'PASS' : 'FAIL'}  ${check.label} (${String(check.count)} orphaned rows)`,
      );
      if (!check.passed) anyFailed = true;
    }

    if (emptyTables.length > 0) {
      console.log(
        `\nEmpty table(s) found: ${emptyTables.map(([table]) => table).join(', ')} — a fully ` +
          'seeded environment should have no empty table in this list.',
      );
    }

    if (anyFailed) {
      console.error('\nFAILED: the seeded data is not fully interconnected.');
      process.exitCode = 1;
    } else {
      console.log('\nPASS: every checked relationship resolves and no table is empty.');
    }
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error('Seed correlation check FAILED:', error);
  process.exitCode = 1;
});
