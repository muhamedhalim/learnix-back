#!/usr/bin/env bash
#
# Database backup — Phase 2 (Database and Redis), resolves finding R8
# ("no backup or restore script exists in either repo").
#
# Produces a timestamped pg_dump custom-format archive and verifies its
# integrity with `pg_restore --list` before considering it valid — an
# archive that cannot even be listed is not a backup, whatever its file size
# says. Writes locally; uploading the artefact to object storage is Phase 3
# work (it needs the R2 bucket/credentials Phase 3 provisions) and is
# deliberately not done here.
#
# USAGE:
#   DATABASE_URL=postgres://... ./scripts/db-backup.sh [output-directory]
#
# Output directory defaults to ./backups. Filename:
#   <output-directory>/learnix-<database-name>-<UTC timestamp>.dump

set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is not set. Point it at the database to back up." >&2
  exit 1
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "pg_dump is not on PATH. Install the PostgreSQL client tools." >&2
  exit 1
fi

OUTPUT_DIR="${1:-./backups}"
mkdir -p "$OUTPUT_DIR"

# Extract the database name from DATABASE_URL without printing the URL
# itself anywhere (it carries credentials).
DB_NAME=$(node -e "try { console.log(new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '')); } catch { console.log('database'); }")
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
ARCHIVE_PATH="${OUTPUT_DIR}/learnix-${DB_NAME}-${TIMESTAMP}.dump"

echo "Backing up database \"${DB_NAME}\" to ${ARCHIVE_PATH}..."
pg_dump --format=custom --file="$ARCHIVE_PATH" --dbname="$DATABASE_URL"

echo "Verifying archive integrity with pg_restore --list..."
if ! pg_restore --list "$ARCHIVE_PATH" >/dev/null; then
  echo "INTEGRITY CHECK FAILED: pg_restore could not list the contents of ${ARCHIVE_PATH}." >&2
  echo "This archive is not a valid backup. Removing it." >&2
  rm -f "$ARCHIVE_PATH"
  exit 1
fi

ENTRY_COUNT=$(pg_restore --list "$ARCHIVE_PATH" | grep -c -v '^;' || true)
echo "OK: backup written and verified (${ENTRY_COUNT} catalogue entries): ${ARCHIVE_PATH}"
