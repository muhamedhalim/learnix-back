#!/usr/bin/env bash
# Decides what the `deploy` job of .github/workflows/ci-cd.yml does with commit SHA, from what the environment
# RUNS NOW (the `ecs-deploy.sh --status` snapshot in STATE_FILE), never from GitHub run or deployment history:
# that history misses rollbacks and workstation deploys, and a green run is not proof of a rollout.
#
#   bash scripts/ci/release-decision.sh <state-file> <sha> <ecr-repository-url>
#
# Prints key=value lines (append them to $GITHUB_OUTPUT):
#   action          deploy | verify-running
#   running_image   what the services run now (empty when they do not run one common image)
#   reason          one human-readable line for the run summary
#
#   verify-running  the services already run SHA itself (a retry, or a second run for the same commit), or a
#                   commit whose image inputs (IMAGE_INPUTS) are identical to SHA's, AND the rollout is stable
#                   AND on the family's latest task-definition revision. The job then proves that (every task
#                   on the digest, the domain serving it) instead of rebuilding an identical image.
#   deploy          anything else: another image or repository, a bootstrap tag, an unknown commit, a rollout in
#                   progress, an unshipped Terraform revision, or an image-relevant change since the running commit
#                   (also after a rollback: the running commit is then the older one).
# Exits non-zero, with an ::error::, when the snapshot is missing or malformed, or when the environment already
# runs a NEWER commit of which SHA is an ancestor (re-running an old run must never roll production back; use
# the `rollback` action for that).
set -euo pipefail

# Every path the image is built from (Dockerfile COPY sources, the build context filter, the build args in
# ci-cd.yml). scripts/ci/tests/release-decision.test.sh fails when the Dockerfile copies anything else.
IMAGE_INPUTS=(
  Dockerfile .dockerignore package.json package-lock.json nest-cli.json tsconfig.json tsconfig.build.json
  src scripts/docker-entrypoint.sh .github/workflows/ci-cd.yml
)

state_file=${1:-} sha=${2:-} repository_url=${3:-}
fail() { echo "::error::release decision: $*" >&2; exit 1; }

[ -f "$state_file" ] || fail "no runtime snapshot ($state_file); the ECS status lookup did not run or failed"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fail "invalid commit '$sha'"
[ -n "$repository_url" ] || fail "ECR repository URL is empty"

value() { sed -n "s/^$1=//p" "$state_file" | tail -n 1; }
for key in running_image stable latest_revision; do
  grep -q "^$key=" "$state_file" || fail "malformed runtime snapshot $state_file (no $key)"
done
running_image=$(value running_image) stable=$(value stable) latest_revision=$(value latest_revision)

decide() { # action reason
  echo "action=$1"
  echo "running_image=$running_image"
  echo "reason=$2"
  exit 0
}

[ -n "$running_image" ] || decide deploy "the services do not run one common image"
running_tag=${running_image##*:}
[ "${running_image%:*}" = "$repository_url" ] || decide deploy "running $running_image is not from $repository_url"
[[ "$running_tag" =~ ^[0-9a-f]{40}$ ]] || decide deploy "running tag '$running_tag' is not a commit"

# Never move an environment backwards: a re-run or a stale manual run of an older commit fails loudly.
if [ "$running_tag" != "$sha" ] && git cat-file -e "$running_tag^{commit}" 2>/dev/null \
  && git merge-base --is-ancestor "$sha" "$running_tag"; then
  fail "the environment already runs $running_tag, which is newer than $sha; refusing to deploy an older commit (use action=rollback)"
fi

[ "$stable" = true ] || decide deploy "the current rollout is not stable (in progress, mixed, or several deployments)"
[ "$latest_revision" = true ] || decide deploy "a newer task-definition revision (Terraform) is not running yet"
[ "$running_tag" = "$sha" ] && decide verify-running "already running $sha"
git cat-file -e "$running_tag^{commit}" 2>/dev/null || decide deploy "running commit $running_tag is not in this repository's history"

changed=$(git diff --name-only "$running_tag" "$sha" -- "${IMAGE_INPUTS[@]}")
[ -z "$changed" ] || decide deploy "image inputs changed since $running_tag: $(echo "$changed" | head -n 5 | tr '\n' ' ')"
decide verify-running "running $running_tag has the same image inputs as $sha"
