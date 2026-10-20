#!/usr/bin/env bash
# The ONE mapping from a GitHub event to what .github/workflows/ci-cd.yml runs (the `control` job's outputs).
#
#   EVENT=push REF=refs/heads/main bash scripts/ci/route-event.sh >> "$GITHUB_OUTPUT"
#
# Input (environment): EVENT, REF, and for workflow_dispatch ACTION + ENVIRONMENT.
# Output: ci, deploy, rollback, branch_sync, environment, manual (key=value lines).
#
#   pull_request         ci only. Never deploys (the push of the merge commit does, exactly once).
#   push develop         ci, then deploy STAGING.  push main: ci, then deploy PRODUCTION.
#                        Every such push routes to `deploy`: whether anything is rebuilt is decided THERE, from what
#                        the environment runs (scripts/ci/release-decision.sh), never here from the push's diff.
#   push other branches  nothing (ci-cd.yml only listens to main/develop pushes; the PR covers the rest).
#   schedule             branch-sync only.
#   workflow_dispatch    deploy | rollback | branch-sync, for the chosen environment.
# Exits non-zero on an unknown event, action or environment.
set -euo pipefail

ci=false deploy=false rollback=false branch_sync=false manual=false target=''
case "${EVENT:-}" in
  pull_request) ci=true ;;
  push)
    case "${REF:-}" in
      refs/heads/develop) ci=true branch_sync=true deploy=true target=staging ;;
      refs/heads/main) ci=true branch_sync=true deploy=true target=production ;;
      *) ;;
    esac ;;
  schedule) branch_sync=true ;;
  workflow_dispatch)
    manual=true
    case "${ACTION:-}" in
      deploy) deploy=true target="${ENVIRONMENT:-}" ;;
      rollback) rollback=true target="${ENVIRONMENT:-}" ;;
      branch-sync) branch_sync=true ;;
      *) echo "::error::unknown action '${ACTION:-}'" >&2; exit 1 ;;
    esac
    if [ "$deploy" = true ] || [ "$rollback" = true ]; then
      case "$target" in staging|production) ;; *) echo "::error::unknown environment '$target'" >&2; exit 1 ;; esac
    fi ;;
  *) echo "::error::unexpected event '${EVENT:-}'" >&2; exit 1 ;;
esac

echo "ci=$ci"
echo "deploy=$deploy"
echo "rollback=$rollback"
echo "branch_sync=$branch_sync"
echo "environment=$target"
echo "manual=$manual"
