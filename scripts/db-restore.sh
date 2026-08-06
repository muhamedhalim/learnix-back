#!/usr/bin/env bash
#
# Database restore — Phase 2 (Database and Redis), resolves finding R8.
#
# Refuses to run unless the target passes the SAME three guards
# `seed-staging.ts` uses (APP_ENV must not resolve to production; the target
# host must not be a known production host; the target database name must
# positively identify itself as staging) — see
# `scripts/assert-restore-target-safe.ts`. Restoring is at least as
# destructive as seeding: both overwrite a database's contents wholesale.
# Restoring *onto* production must never be a one-command operation, and
# this script makes it structurally impossible rather than merely
# discouraged.
#
# USAGE:
#   DATABASE_URL=postgres://... ./scripts/db-restore.sh <path-to-backup.dump>
#
# The restore target is always DATABASE_URL — this script never accepts a
# second, separate "target" URL, so there is no way to safety-check one
# database and then restore into another.

set -euo pipefail

if [[ -z "${1:-}" ]]; then
  echo "Usage: DATABASE_URL=postgres://... ./scripts/db-restore.sh <path-to-backup.dump>" >&2
  exit 1
fi

ARCHIVE_PATH="$1"

if [[ ! -f "$ARCHIVE_PATH" ]]; then
  echo "Backup archive not found: ${ARCHIVE_PATH}" >&2
  exit 1
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is not set. Point it at the restore target." >&2
  exit 1
fi

if ! command -v pg_restore >/dev/null 2>&1; then
  echo "pg_restore is not on PATH. Install the PostgreSQL client tools." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Verifying the restore target is safe..."
if ! (cd "$SCRIPT_DIR/.." && npx ts-node -r tsconfig-paths/register scripts/assert-restore-target-safe.ts "$DATABASE_URL"); then
  echo "REFUSING TO RESTORE: the target failed the safety check above." >&2
  exit 1
fi

echo "Verifying the archive is readable..."
pg_restore --list "$ARCHIVE_PATH" >/dev/null

echo "Restoring ${ARCHIVE_PATH} into the verified staging target..."
pg_restore --clean --if-exists --no-owner --no-privileges --dbname="$DATABASE_URL" "$ARCHIVE_PATH"

echo "OK: restore complete. Run 'npm run migration:show' against this database next to confirm its migration history matches what you expect."
