#!/usr/bin/env bash
# Branch policy check for the `branch-sync` job of .github/workflows/ci-cd.yml.
#
#   branch-sync-check.sh [main-ref] [develop-ref]      (defaults: origin/main origin/develop)
#
# Policy (docs/STAGING_ENVIRONMENT_IMPLEMENTATION_PLAN.md §11, docs/RELEASE_PROCESS_DRAFT.md §2): a hotfix
# lands on `main` and is merged (or cherry-picked) back into `develop` in the same cycle. The check
# therefore looks for CHANGES that exist on main and not on develop:
#   * non-merge commits only: the merge commit that a normal release (develop -> main) leaves on main
#     carries no change of its own and used to make every release look like a violation;
#   * a commit already on develop under another id (cherry-pick) does not count (`--cherry-pick`).
#
# No network access and no credentials: it reads the refs that `actions/checkout` fetched with
# `fetch-depth: 0` (all branches). The job keeps `persist-credentials: false`, so there is nothing to
# authenticate and no token is ever written to .git/config.
#
# Exit: 0 in sync, 1 policy violation (an unmerged hotfix), 2 the refs cannot be evaluated (fail closed).
set -euo pipefail

main_ref="${1:-origin/main}"
develop_ref="${2:-origin/develop}"
drift_warn_after="${DEVELOP_DRIFT_WARN_COMMITS:-100}"

fail_closed() {
  echo "::error::branch-sync: $*" >&2
  exit 2
}

for ref in "$main_ref" "$develop_ref"; do
  git rev-parse --verify --quiet "${ref}^{commit}" >/dev/null ||
    fail_closed "'$ref' is not in this checkout. The job must check out with fetch-depth: 0 so every branch is present; it does not fetch."
done
if [ "$(git rev-parse --is-shallow-repository)" = true ]; then
  fail_closed "shallow clone: commit counts would be wrong. Check out with fetch-depth: 0."
fi

missing=$(git rev-list --count --cherry-pick --right-only --no-merges "${develop_ref}...${main_ref}")
if [ "$missing" -gt 0 ]; then
  echo "::error::main has $missing commit(s) of its own that develop does not contain. A hotfix merged to main must be merged back into develop in the same change (hotfix procedure: docs/RELEASE_PROCESS_DRAFT.md §2)." >&2
  git log --oneline --no-merges --cherry-pick --right-only -n 20 "${develop_ref}...${main_ref}" >&2
  [ "$missing" -le 20 ] || echo "... and $((missing - 20)) more" >&2
  exit 1
fi
echo "main has no changes that are missing from develop."

# Informational: develop running far ahead of main means releases are not being cut.
ahead=$(git rev-list --count "${main_ref}..${develop_ref}")
echo "develop is $ahead commit(s) ahead of main (awaiting release)."
if [ "$ahead" -gt "$drift_warn_after" ]; then
  echo "::warning::develop is $ahead commits ahead of main - consider cutting a release. This is a warning, not a failure: a long-lived develop is a process smell, not a safety issue the way an unmerged hotfix is."
fi
