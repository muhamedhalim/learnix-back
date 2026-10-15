#!/usr/bin/env bash
# shellcheck disable=SC2154,SC2015  # result variables are created by run_capture (printf -v); `a && ok || bad` is intentional
# Tests for scripts/ci/branch-sync-check.sh: normal sync, a release merge, a main-only hotfix, a valid
# merge-back (merge and cherry-pick), drift warning, and the fail-closed paths.
set -uo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/ci/tests/lib.sh
source "$here/lib.sh"
script="$here/../branch-sync-check.sh"

echo "branch-sync-check.sh"

# A repository whose local branches are exposed the way a fetch-depth: 0 checkout exposes them.
sync_refs() {
  git -C "$1" update-ref refs/remotes/origin/main main
  git -C "$1" update-ref refs/remotes/origin/develop develop
}
check() { (cd "$1" && run_capture "$2" bash "$script"); }

repo=$(new_repo)
commit_file "$repo" a.ts 1 init
git -C "$repo" branch develop
sync_refs "$repo"
cd "$repo" || exit 1

run_capture s1 bash "$script"
assert_eq 0 "$s1_status" "identical branches pass"
assert_contains "$s1_out" "no changes that are missing" "and say why"

# develop ahead (normal feature work) is fine
git checkout -q develop
commit_file "$repo" f1.ts 1 feature-1
commit_file "$repo" f2.ts 1 feature-2
sync_refs "$repo"
run_capture s2 bash "$script"
assert_eq 0 "$s2_status" "develop ahead of main passes"
assert_contains "$s2_out" "develop is 2 commit(s) ahead" "reports how far ahead"

# a normal release: develop merged into main leaves one merge commit on main that develop lacks
git checkout -q main
git merge -q --no-ff develop -m "release"
sync_refs "$repo"
run_capture s3 bash "$script"
assert_eq 0 "$s3_status" "a release merge commit alone is not a violation"

# a hotfix committed on main only: genuine violation
commit_file "$repo" hotfix.ts 1 "hotfix: fix prod"
sync_refs "$repo"
run_capture s4 bash "$script"
assert_eq 1 "$s4_status" "an unmerged hotfix fails"
assert_contains "$s4_err" "1 commit(s) of its own" "counts the hotfix"
assert_contains "$s4_err" "hotfix: fix prod" "lists the offending commit"

# merge-back: main merged into develop
git checkout -q develop
git merge -q --no-ff main -m "merge back"
sync_refs "$repo"
run_capture s5 bash "$script"
assert_eq 0 "$s5_status" "merging main back into develop passes"

# a hotfix PR merged into main with a merge commit, branch commits not yet on develop
git checkout -q main
git checkout -q -b hotfix/x
commit_file "$repo" h2.ts 1 "hotfix 2"
git checkout -q main
git merge -q --no-ff hotfix/x -m "Merge hotfix/x"
sync_refs "$repo"
run_capture s6 bash "$script"
assert_eq 1 "$s6_status" "a hotfix merged into main through a merge commit still fails until merged back"

# cherry-pick merge-back (the plan allows "cherry-picked/merged back")
git checkout -q develop
git cherry-pick "$(git rev-parse hotfix/x)" >/dev/null 2>&1
sync_refs "$repo"
run_capture s7 bash "$script"
assert_eq 0 "$s7_status" "a cherry-picked merge-back passes"

# a squash-merged hotfix on main with a different change
git checkout -q main
commit_file "$repo" h3.ts 1 "hotfix 3"
sync_refs "$repo"
run_capture s8 bash "$script"
assert_eq 1 "$s8_status" "a second, different hotfix fails again"

# drift warning is advisory
git checkout -q develop
git merge -q --no-ff main -m "merge back 2"
sync_refs "$repo"
run_capture s9 env DEVELOP_DRIFT_WARN_COMMITS=1 bash "$script"
assert_eq 0 "$s9_status" "drift only warns"
assert_contains "$s9_out" "::warning::develop is" "and emits a warning annotation"

# fail closed
git update-ref -d refs/remotes/origin/develop
run_capture s10 bash "$script"
assert_eq 2 "$s10_status" "a missing ref fails closed"
assert_contains "$s10_err" "does not fetch" "and explains that checkout must provide the refs"
sync_refs "$repo"
shallow="$TMP_ROOT/shallow"
git clone -q --depth 1 --no-single-branch "file://$repo" "$shallow"
cd "$shallow" || exit 1
run_capture s11 bash "$script"
assert_eq 2 "$s11_status" "a shallow clone fails closed"

finish
