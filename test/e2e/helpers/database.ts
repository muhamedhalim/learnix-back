import type { DataSource } from 'typeorm';

import { FINANCE_PERMISSIONS } from '../../../src/payments/finance-permissions';

/** PostgreSQL `deadlock_detected`. */
const DEADLOCK_DETECTED = '40P01';

/** Wait a moment before retrying a deadlocked truncate. */
async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Truncate every table (except the TypeORM migrations table) so each suite
 * starts from a clean, isolated state with no shared data between tests.
 *
 * Uses a single `TRUNCATE ... RESTART IDENTITY CASCADE` for speed and to reset
 * sequences. Safe because E2E runs against a dedicated, disposable database.
 *
 * ## Why the retry
 * `TRUNCATE` takes an ACCESS EXCLUSIVE lock on every table at once. The
 * application under test is a live Nest app with post-commit listeners still
 * finishing their own writes when a test ends — a certificate auto-issue, a
 * notification insert — so the two occasionally deadlock and Postgres kills
 * one of them. That surfaced as an intermittent suite failure whose stack
 * pointed at `resetDatabase`, never at the behaviour under test.
 *
 * Retrying is correct rather than papering over a bug: the loser of a deadlock
 * is expected to retry, and by the next attempt the listener's transaction has
 * resolved. The retry is bounded so a genuine, permanent lock problem still
 * fails the run instead of hanging it.
 */
/**
 * `marketplace_currencies` is platform reference/configuration data (an
 * admin-managed allow-list), not per-test transactional state — production
 * seeds it once via migration `2096000000000-CreateMarketplaceMoney`, never
 * per request. `resetDatabase()` truncates every entity table including this
 * one, and nothing else re-seeds it afterward, so every marketplace e2e test
 * beyond the very first `beforeEach` in a run was silently missing its only
 * enabled currency row — any code path that validates through
 * `CurrencyRegistryService.resolve()` (payout requests, in particular) would
 * fail with "Currency EGP is not enabled" for a reason having nothing to do
 * with the behaviour under test. Re-seeding the exact same row the real
 * migration inserts keeps every test's baseline identical to a freshly
 * migrated database, matching production.
 */
async function reseedReferenceData(dataSource: DataSource): Promise<void> {
  await dataSource.query(`
    INSERT INTO "marketplace_currencies"
      ("code", "minor_unit_exponent", "is_enabled", "min_price_minor", "max_price_minor", "min_payout_minor")
    VALUES ('EGP', 2, true, 5000, 2000000, 50000)
    ON CONFLICT ("code") DO NOTHING;
  `);
}

/**
 * Gives post-commit listeners that are still writing a chance to finish before `TRUNCATE` takes its
 * ACCESS EXCLUSIVE locks. Bounded: it returns after `timeoutMs` whatever the state, and the deadlock retry
 * below still covers a session that starts after this look.
 */
async function waitForOtherSessionsToSettle(
  dataSource: DataSource,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [{ busy }] = (await dataSource.query(
      `SELECT count(*)::int AS busy FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND (state = 'active' OR state LIKE 'idle in transaction%')`,
    )) as [{ busy: number }];
    if (busy === 0 || Date.now() >= deadline) return;
    await pause(25);
  }
}

export async function resetDatabase(dataSource: DataSource, attempts = 3): Promise<void> {
  const tables = dataSource.entityMetadatas
    .map((entity) => `"${entity.tableName}"`)
    .filter((name) => name !== '"migrations"');

  if (tables.length === 0) return;

  const statement = `TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE;`;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await waitForOtherSessionsToSettle(dataSource);
      await dataSource.query(statement);
      await reseedReferenceData(dataSource);
      return;
    } catch (error: unknown) {
      const code =
        (error as { code?: string; driverError?: { code?: string } }).code ??
        (error as { driverError?: { code?: string } }).driverError?.code;

      if (code !== DEADLOCK_DETECTED || attempt === attempts) throw error;

      await pause(attempt * 100);
    }
  }
}

/**
 * Look up a registered user's id by email.
 *
 * `POST /auth/register` deliberately never returns a `userId` — that was the
 * user-enumeration leak this helper exists to work around. Tests that need the
 * id of an account they just created read it straight from the database, which
 * an attacker cannot do.
 */
export async function getUserIdByEmail(dataSource: DataSource, email: string): Promise<string> {
  const rows = (await dataSource.query('SELECT id FROM users WHERE email = $1', [
    email.trim().toLowerCase(),
  ])) as { id: string }[];

  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error(`No user registered with email ${email}`);
  }
  return id;
}

/** Directly set a user's account status (bypasses the admin approval flow). */
export async function setUserStatus(
  dataSource: DataSource,
  userId: string,
  status: string,
): Promise<void> {
  await dataSource.query('UPDATE users SET status = $1 WHERE id = $2', [status, userId]);
}

/** Promote a user to a given role (used to exercise role-guarded routes). */
/**
 * Promote a user to a role, provisioning the role the way production does.
 *
 * `finance_permissions` is a capability of the `admin` role, not a separate
 * finance role (migration 2058), and every real administrator is created by
 * `AdminInitializationService` with the full `FINANCE_PERMISSIONS` set. This
 * helper used to flip `role` alone, so an E2E "admin" landed on the column
 * default of `[]` and was refused by `FinancePermissionsGuard` on every
 * `/admin/finance/*` route — a fixture gap that reads as an application RBAC
 * failure but is not one (previously filed as E2E known failure #3).
 *
 * Non-admin roles are explicitly cleared, preserving 2058's other invariant:
 * a non-admin row must never carry finance permissions.
 *
 * Specs that need a *restricted* admin still override afterwards — e.g.
 * `finance-audit.postgres.e2e-spec.ts` sets `finance_permissions: []` to assert
 * denial. That continues to work; this only changes the starting point.
 */
export async function setUserRole(
  dataSource: DataSource,
  userId: string,
  role: string,
): Promise<void> {
  const financePermissions = role === 'admin' ? [...FINANCE_PERMISSIONS] : [];

  await dataSource.query(
    'UPDATE users SET role = $1, finance_permissions = $2::jsonb WHERE id = $3',
    [role, JSON.stringify(financePermissions), userId],
  );
}
