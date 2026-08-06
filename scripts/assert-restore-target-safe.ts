/**
 * Restore-target safety check — used by `scripts/db-restore.sh` before it
 * runs `pg_restore` against anything.
 *
 * Reuses `assertSafeTarget` from `src/database/seed-staging.ts` rather than
 * re-implementing the three guards (APP_ENV identity, production host
 * denylist, staging-shaped database name) a second time in a different
 * language. A restore is at least as dangerous as a seed run — both write
 * wholesale over a database's contents — so they share one guard, one set of
 * denylists, and one place to fix a gap if one is ever found.
 *
 * USAGE: ts-node -r tsconfig-paths/register scripts/assert-restore-target-safe.ts <database-url>
 * Exits 0 (silently) if the target is safe, non-zero with a message otherwise.
 */

import { assertSafeTarget } from '../src/database/seed-staging';

const targetUrl = process.argv[2] ?? process.env['DATABASE_URL'];

try {
  assertSafeTarget(process.env, targetUrl);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
