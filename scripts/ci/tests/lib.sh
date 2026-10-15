#!/usr/bin/env bash
# Tiny assertion helpers shared by the CI script tests. Source it; do not execute it.
# shellcheck shell=bash

PASS=0
FAIL=0
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

ok() { PASS=$((PASS + 1)); echo "  ok   - $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL - $1" >&2; }

assert_eq() { # expected actual message
  if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (expected '$1', got '$2')"; fi
}

assert_contains() { # haystack needle message
  case "$1" in *"$2"*) ok "$3" ;; *) bad "$3 (missing '$2' in: $1)" ;; esac
}

assert_not_contains() { # haystack needle message
  case "$1" in *"$2"*) bad "$3 (unexpected '$2' in: $1)" ;; *) ok "$3" ;; esac
}

# run_capture <var-prefix> <command...>: runs the command, never aborts the test on failure.
# Sets <prefix>_status, <prefix>_out (stdout) and <prefix>_err (stderr).
run_capture() {
  local prefix=$1
  shift
  local out_file="$TMP_ROOT/$prefix.out" err_file="$TMP_ROOT/$prefix.err" status=0
  "$@" >"$out_file" 2>"$err_file" || status=$?
  printf -v "${prefix}_status" '%s' "$status"
  printf -v "${prefix}_out" '%s' "$(cat "$out_file")"
  printf -v "${prefix}_err" '%s' "$(cat "$err_file")"
}

finish() {
  echo "  $PASS passed, $FAIL failed"
  [ "$FAIL" -eq 0 ]
}

# A throwaway repository with deterministic identity; echoes its path.
new_repo() {
  local dir
  dir=$(mktemp -d -p "$TMP_ROOT")
  git init -q -b main "$dir"
  git -C "$dir" config user.email ci@example.test
  git -C "$dir" config user.name ci
  git -C "$dir" config commit.gpgsign false
  git -C "$dir" config core.autocrlf false
  echo "$dir"
}

commit_file() { # repo path content message
  mkdir -p "$(dirname "$1/$2")"
  printf '%s\n' "$3" >"$1/$2"
  git -C "$1" add -A
  git -C "$1" commit -q -m "$4"
}
