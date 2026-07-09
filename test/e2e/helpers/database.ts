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
