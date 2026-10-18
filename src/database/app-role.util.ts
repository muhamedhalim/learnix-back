/**
 * Least-privilege application database role.
 *
 * On AWS the API and worker connect as `APP_DB_USER`, a role that can read and write rows but cannot
 * run DDL. Only the one-shot migrate task holds the RDS master credentials; after the migrations it
 * calls `ensureAppRole`, which creates the role if needed, sets its password to the current secret
 * value (so a rotation is just a new secret version plus a redeploy) and grants privileges on every
 * table and sequence that exists now or that the master creates later.
 *
 * Skipped unless both APP_DB_USER and APP_DB_PASSWORD are set, so local and e2e runs are unchanged.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import type { DataSource } from 'typeorm';

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const SCRAM_ITERATIONS = 4096;

/**
 * The database the migrate task is connected to. TypeORM leaves `options.database` empty when it connects
 * through a URL (the container entrypoint always builds DATABASE_URL), so fall back to DB_NAME and then to
 * the URL's path.
 */
export function resolveDatabaseName(
  configured: string | undefined,
  env: NodeJS.ProcessEnv,
): string {
  if (configured) return configured;
  const fromEnv = env['DB_NAME']?.trim();
  if (fromEnv) return fromEnv;
  const url = env['DATABASE_URL'];
  if (!url) return '';
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    return '';
  }
}

/**
 * PostgreSQL SCRAM-SHA-256 verifier (RFC 5802/7677, the format `pg_authid.rolpassword` stores). Sending the
 * verifier instead of the password means the plaintext never appears in SQL text, so query logging (the
 * migrate data source logs every statement) and error messages cannot leak it.
 */
export function scramSha256Verifier(password: string, salt: Buffer = randomBytes(16)): string {
  const salted = pbkdf2Sync(password.normalize('NFKC'), salt, SCRAM_ITERATIONS, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${SCRAM_ITERATIONS.toString()}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

export interface AppRoleConfig {
  user: string;
  password: string;
  database: string;
  schema: string;
}

export function readAppRoleConfig(env: NodeJS.ProcessEnv, database: string): AppRoleConfig | null {
  const user = env['APP_DB_USER']?.trim();
  const password = env['APP_DB_PASSWORD'];
  if (!user || !password) return null;
  return { user, password, database, schema: env['DB_SCHEMA']?.trim() || 'public' };
}

function quoteIdentifier(value: string, label: string): string {
  if (!IDENTIFIER.test(value)) {
    throw new Error(`${label} must match ${IDENTIFIER.source}; refusing to build SQL with it`);
  }
  return `"${value}"`;
}

function quoteLiteral(value: string): string {
  if (value.includes('\0')) throw new Error('APP_DB_PASSWORD contains a NUL byte');
  // standard_conforming_strings is on in every supported Postgres: only the quote needs doubling.
  return `'${value.replaceAll("'", "''")}'`;
}

/** Statements that run after the role exists. Pure, so the exact SQL is unit-tested. */
export function buildGrantStatements(config: AppRoleConfig): string[] {
  const role = quoteIdentifier(config.user, 'APP_DB_USER');
  const database = quoteIdentifier(config.database, 'database name');
  const schema = quoteIdentifier(config.schema, 'schema name');
  return [
    `GRANT CONNECT ON DATABASE ${database} TO ${role}`,
    `GRANT USAGE ON SCHEMA ${schema} TO ${role}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`,
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} TO ${role}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT USAGE, SELECT ON SEQUENCES TO ${role}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT EXECUTE ON FUNCTIONS TO ${role}`,
  ];
}

export function buildRoleStatement(config: AppRoleConfig, exists: boolean): string {
  const role = quoteIdentifier(config.user, 'APP_DB_USER');
  const password = quoteLiteral(scramSha256Verifier(config.password));
  return exists
    ? // Attributes are set at creation; re-stating them would need extra privileges, the password does not.
      `ALTER ROLE ${role} WITH PASSWORD ${password}`
    : `CREATE ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${password}`;
}

export async function ensureAppRole(
  dataSource: Pick<DataSource, 'query'>,
  config: AppRoleConfig,
  log: (message: string) => void = () => undefined,
): Promise<void> {
  quoteIdentifier(config.user, 'APP_DB_USER');
  const found = (await dataSource.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [
    config.user,
  ])) as unknown[];
  await dataSource.query(buildRoleStatement(config, found.length > 0));
  for (const statement of buildGrantStatements(config)) await dataSource.query(statement);
  log(`Application role "${config.user}" is ready (DML only, no DDL).`);
}
