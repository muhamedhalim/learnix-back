import { readFileSync } from 'node:fs';

/**
 * Decides whether a Postgres connection needs SSL, based on the target host
 * rather than `NODE_ENV`.
 *
 * `NODE_ENV`-gated SSL breaks in both directions: a `localhost` database with
 * `NODE_ENV=production` set (e.g. to exercise other prod-only code paths
 * locally) gets SSL forced on and fails with "The server does not support
 * SSL connections"; conversely a remote database reached with `NODE_ENV`
 * unset/`development` never gets SSL, which most managed Postgres providers
 * (including Railway's public proxy) require. Managed providers are never
 * reachable via `localhost`, so the loopback host is a reliable signal.
 */
export function resolveDatabaseSsl(
  databaseUrl: string | undefined,
  get: (key: string) => string | undefined = (key) => process.env[key],
): false | { rejectUnauthorized: boolean; ca?: string } {
  if (!databaseUrl) return false;

  let hostname: string;
  try {
    hostname = new URL(databaseUrl).hostname;
  } catch {
    return false;
  }

  const isLoopback =
    hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  if (isLoopback) return false;

  const ca = resolveDatabaseCa(get);
  return {
    rejectUnauthorized: get('SSL_REJECT_UNAUTHORIZED') !== 'false',
    ...(ca !== undefined ? { ca } : {}),
  };
}

/**
 * Extra trust anchor for the database server certificate, as PEM text (`DATABASE_SSL_CA`) or a
 * file path (`DATABASE_SSL_CA_FILE`). Amazon RDS certificates chain to the Amazon RDS CA bundle,
 * which is not in Node's default store; the bundle is shipped in the image. An unreadable
 * configured file is a hard error rather than a silent downgrade.
 */
function resolveDatabaseCa(get: (key: string) => string | undefined): string | undefined {
  const inline = get('DATABASE_SSL_CA');
  if (inline !== undefined && inline.trim() !== '') return inline.replace(/\\n/g, '\n');
  const file = get('DATABASE_SSL_CA_FILE');
  if (file === undefined || file.trim() === '') return undefined;
  return readFileSync(file.trim(), 'utf8');
}
