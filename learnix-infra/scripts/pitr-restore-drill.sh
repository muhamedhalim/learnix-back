#!/usr/bin/env bash
# Point-in-time restore drill: restores the database to a NEW scratch instance, measures how long it takes
# (the measured RTO), and optionally deletes only that scratch instance. The source instance is never modified.
#
#   scripts/pitr-restore-drill.sh <source-db-identifier> [--minutes-ago 15] [--keep]
#
# Needs AWS credentials for the target account (operator role) and the aws CLI. Prints timings as JSON.
set -euo pipefail

SOURCE="${1:-}"
MINUTES_AGO=15
KEEP=0
[ -n "$SOURCE" ] || { echo "usage: $0 <source-db-identifier> [--minutes-ago N] [--keep]" >&2; exit 2; }
shift
while [ $# -gt 0 ]; do
  case "$1" in
    --minutes-ago) MINUTES_AGO="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ "$MINUTES_AGO" =~ ^[0-9]+$ ]] || { echo "--minutes-ago must be a number" >&2; exit 2; }

TARGET="${SOURCE}-drill-$(date -u +%Y%m%d%H%M)"
RESTORE_TIME="$(date -u -d "-${MINUTES_AGO} minutes" +%Y-%m-%dT%H:%M:%SZ)"
START=$(date +%s)

echo "Source: $SOURCE  Target (scratch): $TARGET  Restore point: $RESTORE_TIME" >&2

# The scratch instance reuses the source's subnet group and security groups, so the existing app task
# security group can reach it for the verification queries. It is never publicly accessible.
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier "$SOURCE" \
  --target-db-instance-identifier "$TARGET" \
  --restore-time "$RESTORE_TIME" \
  --no-publicly-accessible \
  --no-multi-az \
  --deletion-protection false \
  --tags Key=Purpose,Value=restore-drill Key=Ephemeral,Value=true >/dev/null

aws rds wait db-instance-available --db-instance-identifier "$TARGET"
END=$(date +%s)
ENDPOINT="$(aws rds describe-db-instances --db-instance-identifier "$TARGET" --query 'DBInstances[0].Endpoint.Address' --output text)"

cat <<JSON
{"source":"$SOURCE","target":"$TARGET","restorePoint":"$RESTORE_TIME","endpoint":"$ENDPOINT","restoreSeconds":$((END - START))}
JSON
echo "Run scripts/restore-verification.sql against $ENDPOINT (one-off ECS task or the db-access host), then compare with the source." >&2

if [ "$KEEP" -eq 0 ]; then
  # Only ever delete the instance this run created (name carries the -drill- marker).
  case "$TARGET" in *-drill-*) ;; *) echo "refusing to delete $TARGET" >&2; exit 1 ;; esac
  aws rds delete-db-instance --db-instance-identifier "$TARGET" --skip-final-snapshot --delete-automated-backups >/dev/null
  echo "Scratch instance $TARGET is being deleted." >&2
else
  echo "Kept $TARGET. Delete it when finished: aws rds delete-db-instance --db-instance-identifier $TARGET --skip-final-snapshot" >&2
fi
