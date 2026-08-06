#!/usr/bin/env bash
#
# Post-deploy smoke test — Phase 4/5 (STAGING_ENVIRONMENT_IMPLEMENTATION_PLAN.md §13.3).
#
# Read-only except for the login+refresh pair, which is required to prove the
# auth flow actually works and only ever uses a seeded smoke-test account —
# never a real user's credentials. Never runs a payment, refund, or send.
#
# USAGE:
#   ./scripts/smoke-test.sh <base-url> [--with-login]
#
# Examples:
#   ./scripts/smoke-test.sh https://api-staging.learnix.school --with-login
#   SMOKE_EMAIL=... SMOKE_PASSWORD=... ./scripts/smoke-test.sh https://api-staging.learnix.school --with-login
#   ./scripts/smoke-test.sh https://web-production-7bd6e.up.railway.app   # read-only subset only
#
# --with-login requires SMOKE_EMAIL and SMOKE_PASSWORD to be set to a seeded,
# non-privileged account's credentials. Without --with-login, only the
# unauthenticated checks run — this is the mode to use against Production.
#
# Exits non-zero on the first failing check. Intended runtime: well under 60s.

set -uo pipefail

BASE_URL="${1:-}"
WITH_LOGIN=false
[[ "${2:-}" == "--with-login" ]] && WITH_LOGIN=true

if [[ -z "$BASE_URL" ]]; then
  echo "Usage: $0 <base-url> [--with-login]" >&2
  exit 1
fi
BASE_URL="${BASE_URL%/}"

FAILURES=0
COOKIE_JAR="$(mktemp)"
trap 'rm -f "$COOKIE_JAR"' EXIT

check() {
  local description="$1" method="$2" path="$3" expected_status="$4"
  shift 4
  local status
  status=$(curl -sS -m 15 -o /dev/null -w '%{http_code}' -X "$method" -b "$COOKIE_JAR" -c "$COOKIE_JAR" "$@" "${BASE_URL}${path}")
  if [[ "$status" == "$expected_status" ]]; then
    echo "PASS  ${description} (${status})"
  else
    echo "FAIL  ${description} — expected ${expected_status}, got ${status}" >&2
    FAILURES=$((FAILURES + 1))
  fi
}

echo "Smoke testing ${BASE_URL}"
echo "---"

check "GET /api/v1/health"            GET "/api/v1/health"            200
check "GET /api/v1/health/readiness"  GET "/api/v1/health/readiness"  200
check "GET /api/v1/packages (public)" GET "/api/v1/packages"          200

# CSRF token issuance — also seeds the cookie jar with XSRF-TOKEN for the
# login/refresh checks below.
check "GET /api/v1/auth/csrf-token" GET "/api/v1/auth/csrf-token" 200

if $WITH_LOGIN; then
  if [[ -z "${SMOKE_EMAIL:-}" || -z "${SMOKE_PASSWORD:-}" ]]; then
    echo "FAIL  --with-login requires SMOKE_EMAIL and SMOKE_PASSWORD" >&2
    FAILURES=$((FAILURES + 1))
  else
    CSRF_TOKEN=$(grep -i 'XSRF-TOKEN' "$COOKIE_JAR" | tail -1 | awk '{print $NF}')
    LOGIN_STATUS=$(curl -sS -m 15 -o /dev/null -w '%{http_code}' -X POST \
      -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
      -H "Content-Type: application/json" -H "X-CSRF-Token: ${CSRF_TOKEN}" \
      -d "{\"email\":\"${SMOKE_EMAIL}\",\"password\":\"${SMOKE_PASSWORD}\"}" \
      "${BASE_URL}/api/v1/auth/login")
    if [[ "$LOGIN_STATUS" == "200" ]]; then
      echo "PASS  POST /api/v1/auth/login (${LOGIN_STATUS})"
    else
      echo "FAIL  POST /api/v1/auth/login — expected 200, got ${LOGIN_STATUS}" >&2
      FAILURES=$((FAILURES + 1))
    fi
    check "POST /api/v1/auth/refresh" POST "/api/v1/auth/refresh" 200 \
      -H "X-CSRF-Token: ${CSRF_TOKEN}"
  fi
else
  echo "SKIP  login/refresh (pass --with-login with SMOKE_EMAIL/SMOKE_PASSWORD to include)"
fi

echo "---"
if [[ "$FAILURES" -eq 0 ]]; then
  echo "All checks passed."
  exit 0
else
  echo "${FAILURES} check(s) failed."
  exit 1
fi
