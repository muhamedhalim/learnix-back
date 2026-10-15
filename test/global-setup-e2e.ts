/**
 * Build the E2E schema exactly once, before any suite runs.
 *
 * ## Why this exists
 * E2E cannot use migrations: the chain was baselined against an existing
 * database, so `migration:run` against an empty one fails immediately on
 * `InitialSchema1734986400000` ("column \"status\" does not exist"). The suite
 * therefore builds its schema with TypeORM `synchronize`.
 *
 * `synchronize` is only safe to run *once*, though. Every suite calls
 * `createE2EApp()`, which used to re-run it, and the second run reliably
 * deadlocked the whole suite:
 *
 *   QueryFailedError: operator does not exist:
 *     scheduled_lesson_sessions_meeting_status_enum =
 *     scheduled_lesson_sessions_meeting_status_enum_old
 *
 * `scheduled_lesson_sessions.meeting_status` is an enum column carrying a
 * *partial* index whose predicate casts to that enum type
 * (`IDX_scheduled_sessions_meeting_status ... WHERE meeting_status IN (...)`).
 * TypeORM cannot round-trip that predicate, decides the column changed, and
 * takes its enum-alteration path: rename the type to `…_old`, create the new
 * type, then `ALTER COLUMN … TYPE`. That last step has to re-evaluate the index
 * predicate, which still references `…_old` — so it fails, TypeORM retries the
 * connection forever, and the run hangs with no output.
 *
 * Building the schema here, once, and leaving `TYPEORM_SYNCHRONIZE=false` for
 * the suites themselves removes the retry entirely. Production is unaffected:
 * it has always run migrations with `synchronize` hard-disabled (`app.module`
 * refuses to start otherwise).
 *
 * Per-test isolation is unchanged — `resetDatabase()` still truncates between
 * tests.
 */

import { join } from 'node:path';

import { config } from 'dotenv';
import { DataSource } from 'typeorm';

import { assertTestDatabaseIsSafe } from '../src/config/environment-isolation.guard';
import { CreateMarketplaceMoney2096000000000 } from '../src/migrations/2096000000000-CreateMarketplaceMoney';

export default async function globalSetup(): Promise<void> {
  // Same clock as CI and the deployed containers. Most timestamp columns are `timestamp without time
  // zone`: node-postgres reads them as LOCAL time, so on a developer machine in another zone every
  // such instant moved by the UTC offset, ties between fixture instants disappeared, and goldens
  // captured there (teacher-follow-up-ownership) failed on the UTC runners. Set here, in the process
  // that spawns the jest workers, before any Date is formatted.
  process.env['TZ'] = 'UTC';

  config({ path: join(__dirname, '..', '.env.test') });

  // Same guard the per-suite setup applies: never build a schema over a
  // database that resolves to a known production host.
  assertTestDatabaseIsSafe((key) => process.env[key]);

  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error('E2E global setup requires DATABASE_URL (see test/.env.test).');
  }

  // Probe first, with synchronize OFF. Re-synchronizing an existing schema is
  // exactly the operation that fails (see above), so this must be a strict
  // build-once: a database that already has the schema is left untouched, which
  // is also what makes repeated local runs work without tearing down Docker.
  const probe = new DataSource({ type: 'postgres', url, synchronize: false, logging: false });
  await probe.initialize();
  let alreadyBuilt = false;
  try {
    const [{ exists }] = (await probe.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'users'
       ) AS exists`,
    )) as [{ exists: boolean }];
    alreadyBuilt = exists;
  } finally {
    await probe.destroy();
  }

  if (!alreadyBuilt) {
    const dataSource = new DataSource({
      type: 'postgres',
      url,
      entities: [join(__dirname, '..', 'src', '**', 'entities', '*.entity.ts')],
      synchronize: true,
      logging: false,
    });

    await dataSource.initialize();
    await dataSource.destroy();
  }

  // `synchronize` builds tables from `@Entity()` decorators only — it has no
  // concept of a raw-SQL trigger, so `TRG_mp_ledger_immutable` (FR-162, the
  // database-level backstop `marketplace-ledger-immutability.e2e-spec.ts`
  // exists specifically to prove) was silently never created in this e2e
  // schema. Applied unconditionally, every run (not just the first, "build
  // once" `alreadyBuilt` branch above) — idempotent by construction
  // (`CREATE OR REPLACE FUNCTION` + `DROP TRIGGER IF EXISTS`), so a
  // long-lived local Docker Postgres whose schema was already built by an
  // earlier run (before this trigger was added here) still gets it.
  const triggerSetup = new DataSource({
    type: 'postgres',
    url,
    synchronize: false,
    logging: false,
  });
  await triggerSetup.initialize();
  try {
    await triggerSetup.query(CreateMarketplaceMoney2096000000000.ledgerTriggerSql());
    // Like the trigger, a free-standing sequence is not part of any entity. Migration
    // 2059000000000-ExtendComplaintsForCallCenterTickets creates it and ComplaintsService.nextTicketNumber()
    // calls nextval() on it; without it every ticket took the "relation does not exist" fallback (one
    // Postgres ERROR per ticket) and the production numbering path was never exercised. Same DDL as the
    // migration, made repeatable. TRUNCATE ... RESTART IDENTITY leaves it alone, so numbers keep rising.
    await triggerSetup.query(
      'CREATE SEQUENCE IF NOT EXISTS "complaint_ticket_number_seq" START WITH 1 INCREMENT BY 1',
    );
  } finally {
    await triggerSetup.destroy();
  }
}
