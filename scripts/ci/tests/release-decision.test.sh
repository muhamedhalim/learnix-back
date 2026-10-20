#!/usr/bin/env bash
# shellcheck disable=SC2154  # result variables are created by run_capture (printf -v)
# Tests for scripts/ci/release-decision.sh: the deploy job's runtime-based decision. Covers the retry and
# duplicate-run cases, a docs-only push after a rollback, a skipped deploy while an older version runs, missing
# or broken runtime snapshots, Terraform revisions, and the "never move backwards" guard.
set -uo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/ci/tests/lib.sh
source "$here/lib.sh"
script="$here/../release-decision.sh"
repo_root=$(cd "$here/../../.." && pwd)
ECR=111122223333.dkr.ecr.eu-central-1.amazonaws.com/learnix-production/api

echo "release-decision.sh"

state() { # running_image stable latest_revision -> path of a snapshot file
  local f
  f=$(mktemp -p "$TMP_ROOT")
  printf 'running_image=%s\nstable=%s\nlatest_revision=%s\n' "$1" "$2" "$3" >"$f"
  echo "$f"
}
decide() { run_capture "$1" bash "$script" "$2" "$3" "$ECR"; }

repo=$(new_repo)
commit_file "$repo" src/main.ts 1 "app v1"
v1=$(git -C "$repo" rev-parse HEAD)
commit_file "$repo" docs/notes.md 1 "docs only"
docs1=$(git -C "$repo" rev-parse HEAD)
commit_file "$repo" src/main.ts 2 "app v2"
v2=$(git -C "$repo" rev-parse HEAD)
commit_file "$repo" learnix-infra/main.tf 1 "infra only"
infra=$(git -C "$repo" rev-parse HEAD)
cd "$repo" || exit 1

decide r1 "$(state "$ECR:$v2" true true)" "$v2"
assert_eq 0 "$r1_status" "same commit already running exits 0"
assert_contains "$r1_out" "action=verify-running" "a retry or a second run of the running commit only verifies (no duplicate deploy)"

decide r2 "$(state "$ECR:$v1" true true)" "$v2"
assert_contains "$r2_out" "action=deploy" "an older version running means deploy, never skip"
assert_contains "$r2_out" "src/main.ts" "and the reason names the changed image input"

decide r3 "$(state "$ECR:$v1" true true)" "$docs1"
assert_contains "$r3_out" "action=verify-running" "a docs-only commit on top of the running commit is image-equivalent"

# Rollback: v2 was deployed, then rolled back to v1. A docs-only push afterwards (tip = infra, which contains v2)
# must deploy, because what RUNS is v1.
decide r4 "$(state "$ECR:$v1" true true)" "$infra"
assert_contains "$r4_out" "action=deploy" "a docs/infra-only push after a rollback deploys (runtime is older)"

decide r5 "$(state "$ECR:$v2" true true)" "$infra"
assert_contains "$r5_out" "action=verify-running" "an infra-only push on top of the running commit verifies"

decide r6 "$(state "$ECR:$v2" true false)" "$infra"
assert_contains "$r6_out" "action=deploy" "a newer task-definition revision (Terraform) still deploys"

decide r7 "$(state "$ECR:$v2" false true)" "$v2"
assert_contains "$r7_out" "action=deploy" "an unstable rollout of the same commit is redeployed, not trusted"

decide r8 "$(state "" false true)" "$v2"
assert_contains "$r8_out" "action=deploy" "api and worker on different images deploy"

decide r9 "$(state "$ECR:ae719a9-r1" true true)" "$v2"
assert_contains "$r9_out" "action=deploy" "a bootstrap (non-commit) tag deploys"

decide r10 "$(state "other.registry/api:$v2" true true)" "$v2"
assert_contains "$r10_out" "action=deploy" "an image from another repository deploys"

decide r11 "$(state "$ECR:$(printf 'f%.0s' {1..40})" true true)" "$v2"
assert_contains "$r11_out" "action=deploy" "an unknown running commit deploys"

decide r12 "$(state "$ECR:$v2" true true)" "$v1"
assert_eq 1 "$r12_status" "re-running an OLDER commit while a newer one runs fails"
assert_contains "$r12_err" "refusing to deploy an older commit" "and says why"

decide r13 "$TMP_ROOT/missing" "$v2"
assert_eq 1 "$r13_status" "a missing runtime snapshot (failed AWS lookup) is a failure, not a skip"

broken=$(mktemp -p "$TMP_ROOT"); echo "garbage" >"$broken"
decide r14 "$broken" "$v2"
assert_eq 1 "$r14_status" "a malformed snapshot is a failure"

decide r15 "$(state "$ECR:$v2" true true)" "not-a-sha"
assert_eq 1 "$r15_status" "an invalid commit is a failure"

# IMAGE_INPUTS must cover every source the Dockerfile copies from the build context.
inputs=$(sed -n '/^IMAGE_INPUTS=(/,/^)/p' "$script" | tr -s ' \n' '\n' | grep -v '^IMAGE_INPUTS=(\|^)$\|^$')
missing=""
while read -r src; do
  src=${src%/}; src=${src#./}
  printf '%s\n' "$inputs" | grep -qx "$src" || missing="$missing $src"
done < <(grep -E '^COPY ' "$repo_root/Dockerfile" | grep -v -- '--from=' \
  | sed -E 's/^COPY( --[^ ]+)* //' | awk '{ for (i = 1; i < NF; i++) print $i }')
assert_eq "" "$missing" "IMAGE_INPUTS covers every Dockerfile COPY source"

finish
