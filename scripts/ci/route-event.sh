#!/usr/bin/env bash
# The ONE mapping from a GitHub event to what .github/workflows/ci-cd.yml runs (the `control` job's outputs).
#
#   EVENT=push REF=refs/heads/main bash scripts/ci/route-event.sh >> "$GITHUB_OUTPUT"
#
# Input (environment): EVENT, REF, and for workflow_dispatch ACTION + ENVIRONMENT.
# Output: ci, deploy, deploy_staging, deploy_production, rollback, environment, manual (key=value lines).
#
#   pull_request         ci only. Never deploys (the push of the merge commit does, exactly once).
#   push main            ci, then deploy STAGING, then PRODUCTION (production `needs` the staging rollout of the same
#                        run, so main is the only branch anything is promoted from).
#                        Every such push routes to the rollouts: whether anything is rebuilt is decided THERE, from what
#                        the environment runs (scripts/ci/release-decision.sh), never here from the push's diff.
#   push other branches  nothing (ci-cd.yml only listens to main pushes; the PR covers the rest).
#   schedule             nothing (ci-cd.yml has no schedule).
#   workflow_dispatch    deploy | rollback, for the chosen environment. A manual deploy only runs from main.
# Exits non-zero on an unknown event, action or environment.
set -euo pipefail

ci=false deploy=false deploy_staging=false deploy_production=false rollback=false manual=false target=''
case "${EVENT:-}" in
  pull_request) ci=true ;;
  push)
    case "${REF:-}" in
      refs/heads/main) ci=true deploy=true deploy_staging=true deploy_production=true ;;
      *) ;;
    esac ;;
  schedule) ;;
  workflow_dispatch)
    manual=true
    case "${ACTION:-}" in
      deploy) deploy=true target="${ENVIRONMENT:-}" ;;
      rollback) rollback=true target="${ENVIRONMENT:-}" ;;
      *) echo "::error::unknown action '${ACTION:-}'" >&2; exit 1 ;;
    esac
    if [ "$deploy" = true ] || [ "$rollback" = true ]; then
      case "$target" in staging|production) ;; *) echo "::error::unknown environment '$target'" >&2; exit 1 ;; esac
    fi
    if [ "$deploy" = true ]; then
      [ "${REF:-}" = refs/heads/main ] || { echo "::error::deploys run from main only (ref is '${REF:-}')" >&2; exit 1; }
      case "$target" in staging) deploy_staging=true ;; production) deploy_production=true ;; esac
    fi ;;
  *) echo "::error::unexpected event '${EVENT:-}'" >&2; exit 1 ;;
esac

echo "ci=$ci"
echo "deploy=$deploy"
echo "deploy_staging=$deploy_staging"
echo "deploy_production=$deploy_production"
echo "rollback=$rollback"
echo "environment=$target"
echo "manual=$manual"
