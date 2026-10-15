#!/usr/bin/env bash
# `npm ci` with a bounded retry for TRANSIENT registry/network failures only.
#
#   npm-ci.sh [extra npm ci args...]
#
# * `npm ci` stays the installer: deterministic, lockfile-exact, integrity-checked. Nothing is relaxed.
# * Only failures whose output names a network condition (ECONNRESET, ETIMEDOUT, 5xx from the registry,
#   ...) are retried. A lockfile out of sync (EUSAGE), 404/ETARGET, auth errors (E401/E403), integrity
#   mismatches (EINTEGRITY) and engine errors fail on the first attempt: retrying cannot fix them and
#   would only hide them.
# * At most NPM_CI_ATTEMPTS (default 3) attempts, NPM_CI_BACKOFF_SECONDS * attempt apart (default 10 s).
# * The exit status is npm's own status of the LAST attempt; a retry can never turn a failure into success.
# * npm's own fetch retry/timeouts are set explicitly (supported npm config, via the environment).
# * On failure it prints the last lines of npm's output with credentials masked, plus the path of the
#   runner's npm debug log. It never prints that log: it can contain registry configuration.
#
# Test seam: NPM_BIN (default `npm`).
set -uo pipefail

attempts="${NPM_CI_ATTEMPTS:-3}"
backoff="${NPM_CI_BACKOFF_SECONDS:-10}"
npm_bin="${NPM_BIN:-npm}"

export npm_config_fetch_retries="${npm_config_fetch_retries:-4}"
export npm_config_fetch_retry_mintimeout="${npm_config_fetch_retry_mintimeout:-15000}"
export npm_config_fetch_retry_maxtimeout="${npm_config_fetch_retry_maxtimeout:-90000}"
export npm_config_fetch_timeout="${npm_config_fetch_timeout:-120000}"

# The audit and funding calls are extra requests that never influence what gets installed (the audit
# runs as its own CI job); --prefer-offline lets setup-node's cache answer integrity-pinned tarballs.
npm_args=(ci --no-audit --no-fund --prefer-offline "$@")

transient='ECONNRESET|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNREFUSED|ECONNABORTED|EAI_AGAIN|ENOTFOUND|EPIPE|ENETUNREACH|socket hang up|network (timeout|socket|aborted)|fetch failed|ERR_SOCKET_TIMEOUT|Client network socket disconnected|(HTTP|status code|status) (429|500|502|503|504)|ERR_SSL'
persistent='EUSAGE|EINTEGRITY|E401|E403|E404|ETARGET|EBADENGINE|EBADPLATFORM|ELOCKVERIFY|can only install packages when your package.json and package-lock.json'

mask() {
  sed -E \
    -e 's#(_authToken|_auth|_password)=[^[:space:]]+#\1=***#g' \
    -e 's#(https?://)[^/@[:space:]]+@#\1***@#g' \
    -e 's#([Bb]earer )[A-Za-z0-9._~+/=-]+#\1***#g'
}

log=$(mktemp)
trap 'rm -f "$log"' EXIT

attempt=1
while :; do
  echo "npm ci: attempt $attempt of $attempts"
  "$npm_bin" "${npm_args[@]}" >"$log" 2>&1
  status=$?
  if [ "$status" -eq 0 ]; then
    tail -n 5 "$log" | mask
    echo "npm ci: succeeded on attempt $attempt"
    exit 0
  fi

  echo "::group::npm ci failed (attempt $attempt, exit $status), last output with credentials masked"
  tail -n 25 "$log" | mask
  debug_log=$(grep -Eo 'A complete log of this run can be found in: .*' "$log" | tail -n 1 || true)
  [ -z "$debug_log" ] || echo "npm debug log on this runner: ${debug_log#A complete log of this run can be found in: }"
  echo "::endgroup::"

  if grep -Eq "$persistent" "$log"; then
    echo "::error::npm ci failed with a non-transient error (dependency, lockfile, auth or platform problem); not retrying."
    exit "$status"
  fi
  if ! grep -Eq "$transient" "$log"; then
    echo "::error::npm ci failed and the output does not look like a network problem; not retrying."
    exit "$status"
  fi
  if [ "$attempt" -ge "$attempts" ]; then
    echo "::error::npm ci still failing with network errors after $attempts attempts; the registry or the runner's connectivity is unavailable."
    exit "$status"
  fi
  echo "::warning::npm ci hit a transient network error; retrying in $((backoff * attempt)) s"
  sleep "$((backoff * attempt))"
  attempt=$((attempt + 1))
done
