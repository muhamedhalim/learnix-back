#!/usr/bin/env bash
# Lists the files a change touches that Prettier is expected to cover, NUL-delimited, for the
# `format-check` job of .github/workflows/ci-cd.yml.
#
#   changed-files.sh <base-sha|''> <head-sha> <out-file>
#
# stdout: `count=<n>` (appended to $GITHUB_OUTPUT by the caller). stderr: diagnostics.
# <out-file> receives the NUL-delimited list; file names are never interpreted by a shell.
#
# Base selection (first that exists wins), so an unusual event can never silently shrink the check to
# nothing:
#   1. <base-sha>: PR base tip / push `before`. Empty or all-zero (new branch, forced push) is skipped.
#   2. merge-base of <head-sha> and $BASE_FALLBACK_REF (default origin/main), when that is not <head-sha>.
#   3. the first parent of <head-sha> (a merge commit therefore yields what the merge brought in).
#   4. the empty tree, for a root commit: every supported file counts as added.
#
# Fails (non-zero) instead of reporting "no files" when the answer cannot be trusted: unknown head,
# a head that is not the checked-out commit, a shallow clone, or a failing `git diff`. An empty list
# is only ever the result of a diff that ran and found nothing.
set -euo pipefail

base="${1-}"
head="${2:?usage: changed-files.sh <base-sha|''> <head-sha> <out-file>}"
out="${3:?usage: changed-files.sh <base-sha|''> <head-sha> <out-file>}"
fallback_ref="${BASE_FALLBACK_REF:-origin/main}"

# Same extensions as `npm run format:changed` (scripts/format-changed.ts).
pathspec=('*.ts' '*.tsx' '*.js' '*.jsx' '*.json' '*.md')

fail() {
  echo "::error::changed-files: $*" >&2
  exit "${2:-2}"
}

head_commit=$(git rev-parse --verify --quiet "${head}^{commit}") || fail "head '$head' is not a commit in this checkout"
[ "$head_commit" = "$(git rev-parse HEAD)" ] || fail "head '$head' is not the checked-out commit; Prettier would read different files than the diff names"

if [ "$(git rev-parse --is-shallow-repository)" = true ]; then
  fail "shallow clone: the base cannot be resolved reliably. Check out with fetch-depth: 0." 3
fi

selected=''
resolve_base() {
  local candidate
  if [ -n "$base" ] && ! [[ "$base" =~ ^0+$ ]]; then
    if candidate=$(git rev-parse --verify --quiet "${base}^{commit}"); then
      selected=$candidate
      echo "changed-files: base is the event base ${candidate:0:12}" >&2
      return
    fi
    echo "changed-files: event base '${base:0:12}' is not in this checkout; falling back" >&2
  fi
  if candidate=$(git merge-base "$head_commit" "$fallback_ref" 2>/dev/null) && [ "$candidate" != "$head_commit" ]; then
    selected=$candidate
    echo "changed-files: base is the merge-base with $fallback_ref (${candidate:0:12})" >&2
    return
  fi
  if candidate=$(git rev-parse --verify --quiet "${head_commit}^1"); then
    selected=$candidate
    echo "changed-files: base is the first parent (${candidate:0:12})" >&2
    return
  fi
  selected=$(git hash-object -t tree /dev/null)
  echo "changed-files: root commit, every supported file counts as changed" >&2
}
resolve_base

tmp="${out}.tmp"
# No pipe, no `|| true`: a failing diff must fail this script (set -e), not produce an empty list.
git diff -z --name-only --diff-filter=ACMR "$selected" "$head_commit" -- "${pathspec[@]}" >"$tmp"
mv "$tmp" "$out"

count=$(tr -cd '\0' <"$out" | wc -c | tr -d '[:space:]')
echo "changed-files: $count file(s) between ${selected:0:12} and ${head_commit:0:12}" >&2
echo "count=$count"
