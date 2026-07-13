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
): false | { rejectUnauthorized: boolean } {
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

  return { rejectUnauthorized: process.env['SSL_REJECT_UNAUTHORIZED'] !== 'false' };
}
