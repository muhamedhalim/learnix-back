#!/usr/bin/env bash
# shellcheck disable=SC2154  # result variables are created by run_capture (printf -v)
# Tests for scripts/ci/route-event.sh: which events can deploy, and to where. One commit reaches an environment
# through exactly one route (its push); pull requests, schedules and other branches never deploy.
set -uo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/ci/tests/lib.sh
source "$here/lib.sh"
script="$here/../route-event.sh"

echo "route-event.sh"

route() { # prefix, then VAR=value pairs
  local prefix=$1
  shift
  run_capture "$prefix" env -i PATH="$PATH" "$@" bash "$script"
}

route p1 EVENT=push REF=refs/heads/main
assert_contains "$p1_out" "deploy=true" "push to main deploys"
assert_contains "$p1_out" "environment=production" "to production"
assert_contains "$p1_out" "ci=true" "after CI"

route p2 EVENT=push REF=refs/heads/develop
assert_contains "$p2_out" "environment=staging" "push to develop deploys staging"

route p3 EVENT=pull_request REF=refs/pull/21/merge
assert_contains "$p3_out" "deploy=false" "a pull request never deploys (no second deploy of the same change)"
assert_contains "$p3_out" "ci=true" "but runs CI"

route p4 EVENT=push REF=refs/heads/feature/x
assert_contains "$p4_out" "deploy=false" "a push to another branch never deploys"

route p5 EVENT=schedule
assert_contains "$p5_out" "deploy=false" "the nightly schedule never deploys"
assert_contains "$p5_out" "branch_sync=true" "it only checks branch sync"

route p6 EVENT=push REF=refs/heads/main
route p6b EVENT=push REF=refs/heads/main
assert_eq "$p6_out" "$p6b_out" "the same push routes identically (no hidden diff-based skip)"

route p7 EVENT=workflow_dispatch ACTION=deploy ENVIRONMENT=production
assert_contains "$p7_out" "manual=true" "manual deploy is marked manual"
assert_contains "$p7_out" "environment=production" "for the chosen environment"

route p8 EVENT=workflow_dispatch ACTION=rollback ENVIRONMENT=staging
assert_contains "$p8_out" "rollback=true" "manual rollback routes to rollback"
assert_contains "$p8_out" "deploy=false" "and not to deploy"

route p9 EVENT=workflow_dispatch ACTION=deploy ENVIRONMENT=learnix-production
assert_eq 1 "$p9_status" "an unknown environment fails"

route p10 EVENT=workflow_dispatch ACTION=destroy ENVIRONMENT=staging
assert_eq 1 "$p10_status" "an unknown action fails"

route p11 EVENT=release
assert_eq 1 "$p11_status" "an unexpected event fails"

finish
