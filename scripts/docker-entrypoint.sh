#!/bin/sh
# Builds DATABASE_URL (and REDIS_URL) from discrete parts when they are not set. ECS injects DB_USER/DB_PASSWORD from the
# RDS-managed master secret (which holds no URL), plus DB_HOST/DB_PORT/DB_NAME as plain variables.
# Credentials are percent-encoded, and nothing is printed.
set -eu
if [ -z "${DATABASE_URL:-}" ] && [ -n "${DB_HOST:-}" ]; then
  DATABASE_URL="$(node -e '
    const e = process.env;
    const enc = encodeURIComponent;
    for (const k of ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"]) {
      if (!e[k]) { console.error("docker-entrypoint: " + k + " is required when DATABASE_URL is unset"); process.exit(1); }
    }
    process.stdout.write("postgresql://" + enc(e.DB_USER) + ":" + enc(e.DB_PASSWORD) + "@" + e.DB_HOST + ":" + (e.DB_PORT || "5432") + "/" + enc(e.DB_NAME));
  ')"
  export DATABASE_URL
  unset DB_PASSWORD
fi
if [ -z "${REDIS_URL:-}" ] && [ -n "${REDIS_HOST:-}" ]; then
  # ElastiCache with in-transit encryption: rediss:// plus the AUTH token injected from Secrets Manager.
  REDIS_URL="$(node -e '
    const e = process.env;
    if (!e.REDIS_AUTH_TOKEN) { console.error("docker-entrypoint: REDIS_AUTH_TOKEN is required when REDIS_URL is unset"); process.exit(1); }
    process.stdout.write("rediss://:" + encodeURIComponent(e.REDIS_AUTH_TOKEN) + "@" + e.REDIS_HOST + ":" + (e.REDIS_PORT || "6379"));
  ')"
  export REDIS_URL
  unset REDIS_AUTH_TOKEN
fi
exec "$@"
