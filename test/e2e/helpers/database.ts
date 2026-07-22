import type { DataSource } from 'typeorm';

/**
 * Truncate every table (except the TypeORM migrations table) so each suite
 * starts from a clean, isolated state with no shared data between tests.
 *
 * Uses a single `TRUNCATE ... RESTART IDENTITY CASCADE` for speed and to reset
 * sequences. Safe because E2E runs against a dedicated, disposable database.
 */
export async function resetDatabase(dataSource: DataSource): Promise<void> {
  const tables = dataSource.entityMetadatas
    .map((entity) => `"${entity.tableName}"`)
    .filter((name) => name !== '"migrations"');

  if (tables.length === 0) return;

  await dataSource.query(
    `TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE;`,
  );
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
  await dataSource.query('UPDATE users SET status = $1 WHERE id = $2', [
    status,
    userId,
  ]);
}

/** Promote a user to a given role (used to exercise role-guarded routes). */
export async function setUserRole(
  dataSource: DataSource,
  userId: string,
  role: string,
): Promise<void> {
  await dataSource.query('UPDATE users SET role = $1 WHERE id = $2', [
    role,
    userId,
  ]);
}
