#!/usr/bin/env bash
# Runs every test of the CI helper scripts in scripts/ci. No dependencies beyond bash, git and node.
#   bash scripts/ci/run-tests.sh
set -uo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
status=0

for test_file in "$here"/tests/*.test.sh; do
  bash "$test_file" || status=1
done
node --test "$here"/tests/*.test.mjs || status=1

exit "$status"
