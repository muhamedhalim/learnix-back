#!/usr/bin/env bash
# shellcheck disable=SC2154,SC2015  # result variables are created by run_capture (printf -v); `a && ok || bad` is intentional
# Tests for scripts/ci/changed-files.sh against real throwaway repositories.
set -uo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/ci/tests/lib.sh
source "$here/lib.sh"
script="$here/../changed-files.sh"

list() { tr '\0' '\n' <"$1" | sort; }

echo "changed-files.sh"

# --- a normal change: supported files only, deletions and other types excluded, hostile names inert
repo=$(new_repo)
commit_file "$repo" src/keep.ts 'a' base
commit_file "$repo" src/gone.ts 'b' base2
base=$(git -C "$repo" rev-parse HEAD)
git -C "$repo" rm -q src/gone.ts
mkdir -p "$repo/docs"
printf 'x\n' >"$repo/docs/with space.md"
printf 'x\n' >"$repo/docs/x; touch pwned.ts"
printf 'x\n' >"$repo/img.png"
printf 'x\n' >"$repo/notes.txt"
printf 'y\n' >"$repo/src/keep.ts"
git -C "$repo" add -A && git -C "$repo" commit -q -m change
head=$(git -C "$repo" rev-parse HEAD)
out="$TMP_ROOT/o1.z"
cd "$repo" || exit 1
run_capture r1 bash "$script" "$base" "$head" "$out"
assert_eq 0 "$r1_status" "exits 0"
assert_eq "count=3" "$r1_out" "reports three supported files"
assert_eq "$(printf 'docs/with space.md\ndocs/x; touch pwned.ts\nsrc/keep.ts')" "$(list "$out")" \
  "keeps spaces and shell metacharacters verbatim; drops deleted and unsupported files"
[ ! -e "$repo/pwned.ts" ] && ok "a hostile file name is never executed" || bad "pwned.ts was created"

# --- only unsupported files changed: legitimately empty, still exit 0
commit_file "$repo" notes.txt 'changed' txt-only
run_capture r2 bash "$script" "$head" "$(git rev-parse HEAD)" "$out"
assert_eq 0 "$r2_status" "an empty change set is not an error"
assert_eq "count=0" "$r2_out" "an empty change set reports count=0"
assert_eq 0 "$(wc -c <"$out" | tr -d ' ')" "the list file is empty and exists"

# --- push of a new branch / forced push: all-zero or unknown before falls back to the first parent
commit_file "$repo" src/new.ts 'n' newfile
tip=$(git rev-parse HEAD)
run_capture r3 bash "$script" 0000000000000000000000000000000000000000 "$tip" "$out"
assert_eq 0 "$r3_status" "all-zero before is accepted"
assert_eq "count=1" "$r3_out" "all-zero before diffs against the first parent"
assert_eq "src/new.ts" "$(list "$out")" "only the last commit's file"
run_capture r4 bash "$script" deadbeefdeadbeefdeadbeefdeadbeefdeadbeef "$tip" "$out"
assert_eq 0 "$r4_status" "a before-sha missing from the checkout is accepted"
assert_contains "$r4_err" "not in this checkout" "and says that it fell back"
assert_eq "count=1" "$r4_out" "unknown before diffs against the first parent"
run_capture r5 bash "$script" '' "$tip" "$out"
assert_eq "count=1" "$r5_out" "empty base behaves like an unknown base"

# --- a merge commit as head, with the event base being the pre-merge tip of the target branch
git checkout -q -b feature
commit_file "$repo" src/feature.ts 'f' feature-commit
git checkout -q main
commit_file "$repo" src/main-only.ts 'm' main-commit
pre_merge=$(git rev-parse HEAD)
git merge -q --no-ff feature -m merge
merge=$(git rev-parse HEAD)
run_capture r6 bash "$script" "$pre_merge" "$merge" "$out"
assert_eq "src/feature.ts" "$(list "$out")" "merge push: exactly what the merge brought in"
run_capture r7 bash "$script" '' "$merge" "$out"
assert_eq "src/feature.ts" "$(list "$out")" "merge commit without a base: first-parent diff is what the merge brought in"

# --- root commit: everything supported counts
root=$(new_repo)
commit_file "$root" a.ts 'a' root
printf 'x\n' >"$root/b.json" && git -C "$root" add -A && git -C "$root" commit -q --amend -m root
cd "$root" || exit 1
run_capture r8 bash "$script" '' "$(git rev-parse HEAD)" "$out"
assert_eq 0 "$r8_status" "root commit succeeds"
assert_eq "a.ts
b.json" "$(list "$out")" "root commit lists every supported file"

# --- fail closed on states that would otherwise yield a silently empty list
run_capture r9 bash "$script" '' 1111111111111111111111111111111111111111 "$out"
[ "$r9_status" -ne 0 ] && ok "unknown head fails" || bad "unknown head must fail"
cd "$repo" || exit 1
run_capture r10 bash "$script" "$base" "$base" "$out"
[ "$r10_status" -ne 0 ] && ok "a head that is not the checked-out commit fails" || bad "stale head must fail"
shallow="$TMP_ROOT/shallow"
git clone -q --depth 1 "file://$repo" "$shallow"
cd "$shallow" || exit 1
run_capture r11 bash "$script" "$base" "$(git rev-parse HEAD)" "$out"
assert_eq 3 "$r11_status" "a shallow clone fails with its own exit code"
assert_contains "$r11_err" "fetch-depth: 0" "and tells the operator how to fix the checkout"

# --- fallback to merge-base with the default branch
cd "$repo" || exit 1
git checkout -q -b topic main
commit_file "$repo" src/topic.ts 't' topic
git update-ref refs/remotes/origin/main main
run_capture r12 env BASE_FALLBACK_REF=origin/main bash "$script" '' "$(git rev-parse HEAD)" "$out"
assert_contains "$r12_err" "merge-base with origin/main" "falls back to the merge-base with the default branch"
assert_eq "src/topic.ts" "$(list "$out")" "the topic branch's own file"

finish
