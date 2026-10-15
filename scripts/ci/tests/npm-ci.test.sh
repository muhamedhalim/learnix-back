#!/usr/bin/env bash
# shellcheck disable=SC2154,SC2015  # result variables are created by run_capture (printf -v); `a && ok || bad` is intentional
# Tests for scripts/ci/npm-ci.sh with a fake npm: bounded retries, transient vs persistent failures,
# preserved exit status, masked credentials, and the npm flags actually passed.
set -uo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/ci/tests/lib.sh
source "$here/lib.sh"
script="$here/../npm-ci.sh"

echo "npm-ci.sh"

# fake_npm <dir> <status-per-attempt...>: attempt N exits with its status; failing attempts print
# $FAKE_NPM_MESSAGE. Counts calls and records arguments and the retry environment.
fake_npm() {
  local dir=$1
  shift
  mkdir -p "$dir"
  printf '%s\n' "$@" >"$dir/statuses"
  : >"$dir/calls"
  cat >"$dir/npm" <<FAKE
#!/usr/bin/env bash
n=\$(wc -l <"$dir/calls" | tr -d ' ')
echo "\$*" >>"$dir/calls"
echo "retries=\$npm_config_fetch_retries timeout=\$npm_config_fetch_timeout" >"$dir/env"
status=\$(sed -n "\$((n + 1))p" "$dir/statuses")
status=\${status:-0}
if [ "\$status" -ne 0 ]; then printf '%s\n' "\$FAKE_NPM_MESSAGE"; fi
exit "\$status"
FAKE
  chmod +x "$dir/npm"
}
calls() { wc -l <"$1/calls" | tr -d ' '; }

fast=(env NPM_CI_BACKOFF_SECONDS=0)

# 1. success first time
fake_npm "$TMP_ROOT/a" 0
run_capture t1 "${fast[@]}" NPM_BIN="$TMP_ROOT/a/npm" bash "$script"
assert_eq 0 "$t1_status" "success passes through"
assert_eq 1 "$(calls "$TMP_ROOT/a")" "and runs npm exactly once"
assert_contains "$(cat "$TMP_ROOT/a/calls")" "ci --no-audit --no-fund --prefer-offline" "npm ci is the command, without the extra network calls"
assert_contains "$(cat "$TMP_ROOT/a/env")" "retries=4 timeout=120000" "npm fetch retry and timeout are configured"

# 2. transient failure twice, then success
fake_npm "$TMP_ROOT/b" 1 1 0
run_capture t2 "${fast[@]}" NPM_BIN="$TMP_ROOT/b/npm" FAKE_NPM_MESSAGE="npm error code ECONNRESET" bash "$script"
assert_eq 0 "$t2_status" "recovers after transient ECONNRESET"
assert_eq 3 "$(calls "$TMP_ROOT/b")" "using three attempts"
assert_contains "$t2_out" "succeeded on attempt 3" "and reports which attempt worked"

# 3. transient failure on every attempt: bounded, original status preserved
fake_npm "$TMP_ROOT/c" 7 7 7 7 7
run_capture t3 "${fast[@]}" NPM_BIN="$TMP_ROOT/c/npm" FAKE_NPM_MESSAGE="npm error network request failed ETIMEDOUT" bash "$script"
assert_eq 7 "$t3_status" "keeps npm's own exit status when every attempt fails"
assert_eq 3 "$(calls "$TMP_ROOT/c")" "and never exceeds the attempt bound"
assert_contains "$t3_out" "after 3 attempts" "with an actionable message"

# 4. attempts are configurable
fake_npm "$TMP_ROOT/d" 1 1 1 1 1
run_capture t4 "${fast[@]}" NPM_CI_ATTEMPTS=2 NPM_BIN="$TMP_ROOT/d/npm" FAKE_NPM_MESSAGE="ECONNRESET" bash "$script"
assert_eq 2 "$(calls "$TMP_ROOT/d")" "NPM_CI_ATTEMPTS bounds the retries"

# 5. persistent failures are not retried
messages=(
  "npm error code EUSAGE"
  "npm error npm ci can only install packages when your package.json and package-lock.json are in sync"
  "npm error code E404"
  "npm error code ETARGET"
  "npm error code E403 ECONNRESET"
  "npm error code EINTEGRITY"
)
for msg in "${messages[@]}"; do
  fake_npm "$TMP_ROOT/e" 1 0
  run_capture t5 "${fast[@]}" NPM_BIN="$TMP_ROOT/e/npm" FAKE_NPM_MESSAGE="$msg" bash "$script"
  assert_eq 1 "$t5_status" "persistent failure fails at once: $msg"
  assert_eq 1 "$(calls "$TMP_ROOT/e")" "and is not retried"
done

# 6. an unclassified failure is not retried either
fake_npm "$TMP_ROOT/f" 1 0
run_capture t6 "${fast[@]}" NPM_BIN="$TMP_ROOT/f/npm" FAKE_NPM_MESSAGE="npm error something unexpected" bash "$script"
assert_eq 1 "$t6_status" "an unrecognised failure fails"
assert_eq 1 "$(calls "$TMP_ROOT/f")" "without retry"

# 7. credentials never reach the log; the debug-log path does
fake_npm "$TMP_ROOT/g" 1
secret_message='npm error code E401
npm error //registry.example/:_authToken=npm_SECRETSECRET123
npm error fetch https://user:hunter2@registry.example/pkg.tgz
npm error Authorization: Bearer abc.def.ghi
npm error A complete log of this run can be found in: /home/runner/.npm/_logs/2026-10-15-debug-0.log'
run_capture t7 "${fast[@]}" NPM_BIN="$TMP_ROOT/g/npm" FAKE_NPM_MESSAGE="$secret_message" bash "$script"
assert_not_contains "$t7_out" "npm_SECRETSECRET123" "npm auth tokens are masked"
assert_not_contains "$t7_out" "hunter2" "URL credentials are masked"
assert_not_contains "$t7_out" "abc.def.ghi" "bearer tokens are masked"
assert_contains "$t7_out" "/home/runner/.npm/_logs/2026-10-15-debug-0.log" "the runner's npm log path is printed"

# 8. extra arguments are forwarded
fake_npm "$TMP_ROOT/h" 0
run_capture t8 "${fast[@]}" NPM_BIN="$TMP_ROOT/h/npm" bash "$script" --ignore-scripts
assert_contains "$(cat "$TMP_ROOT/h/calls")" "--ignore-scripts" "extra arguments reach npm ci"

finish
