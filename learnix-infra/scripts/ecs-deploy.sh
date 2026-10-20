#!/usr/bin/env bash
# Deploy one image to Learnix ECS services, with migration gate, verification and automatic rollback.
#
#   ecs-deploy.sh --cluster learnix-production --image <ecr-url>:<sha> \
#       --services api,worker [--migrate-family learnix-production-migrate] \
#       [--network '<awsvpcConfiguration JSON>'] [--alarm-names a,b,c] [--timeout 900] \
#       [--verify-url https://api.learnix.school]
#   ecs-deploy.sh --cluster learnix-production --services api,worker --status
#   ecs-deploy.sh --cluster learnix-production --services api,worker --verify-only --image <ecr-url>:<sha> \
#       [--verify-url https://api.learnix.school]
#   ecs-deploy.sh --cluster learnix-production --rollback --services api,worker --to-file previous.json
#
# Steps (deploy):
#   0. The tag must exist in ECR (its digest is what every task must end up running), and none of
#      --alarm-names may already be in ALARM (a regression could not be told apart from an old problem).
#   1. Register a new revision per service from the LATEST ACTIVE revision of the service's task family
#      (Terraform owns the shape and registers a new revision when it changes; the pipeline only swaps the
#      app container's image). The service's currently running ARN is recorded in
#      ./previous-task-definitions.json (the rollback input, kept as a workflow artifact).
#   2. If --migrate-family is given: register it with the same image, run it once (awsvpc config from
#      --network = terraform output task_network), wait, and require exit code 0. Migrations are
#      advisory-locked, so a concurrent run cannot race. A failure stops here: no service is touched.
#   3. update-service for each service, then wait until each service's PRIMARY deployment is the NEW revision,
#      COMPLETED and alone. ECS's circuit breaker rolls a failing deployment back by itself, and that rollback
#      deployment becomes PRIMARY and reaches COMPLETED too: it is a failure here, never a success.
#   4. --alarm-names: rolls back if one of them is in ALARM after the rollout. Only name alarms that react to a
#      bad release (5xx, unhealthy targets, error logs), never ones that treat missing data as breaching.
#   5. Every RUNNING task of every service must run the new revision with the ECR digest of the tag, so no task
#      of an older deployment is still serving.
#   6. --verify-url (the public API origin): GET /api/v1/health/version through the real domain must report the
#      image's commit on VERIFY_REQUESTS consecutive requests (default 10).
#   Any failure after step 3 started -> every service is pointed back at its previous revision.
#
# --status (read-only) prints what the services run, as key=value lines for scripts/ci/release-decision.sh:
#   running_image   the app image all services' PRIMARY revisions share (empty when they differ)
#   stable          true when every service has exactly one deployment and it is COMPLETED
#   latest_revision true when every service runs its family's latest ACTIVE revision (false = Terraform
#                   registered a newer revision that has not been rolled out yet)
# --verify-only (read-only) runs steps 5 and 6 against what is running now, for --image; never changes anything.
# Every AWS error is fatal (non-zero exit), in every mode.
#
# Needs: aws CLI v2, jq, curl (--verify-url). Credentials: the GitHub OIDC deploy role (modules/deploy-role).
set -euo pipefail

CLUSTER="" IMAGE="" SERVICES="" MIGRATE_FAMILY="" NETWORK="" ALARM_NAMES="" TIMEOUT=900
MODE=deploy TO_FILE="" STATE_FILE="previous-task-definitions.json" VERIFY_URL=""

die() { echo "::error::$*" >&2; exit 1; }
log() { echo "[ecs-deploy] $*" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --cluster) CLUSTER="$2"; shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;
    --services) SERVICES="$2"; shift 2 ;;
    --migrate-family) MIGRATE_FAMILY="$2"; shift 2 ;;
    --network) NETWORK="$2"; shift 2 ;;
    --alarm-names) ALARM_NAMES="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --rollback) MODE=rollback; shift ;;
    --status) MODE=status; shift ;;
    --verify-only) MODE=verify; shift ;;
    --to-file) TO_FILE="$2"; shift 2 ;;
    --state-file) STATE_FILE="$2"; shift 2 ;;
    --verify-url) VERIFY_URL="${2%/}"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$CLUSTER" ] || die "--cluster is required"
[ -n "$SERVICES" ] || die "--services is required"
command -v jq >/dev/null || die "jq is required"
IFS=',' read -r -a SERVICE_LIST <<< "$SERVICES"

current_task_definition() {
  local td
  td=$(aws ecs describe-services --cluster "$CLUSTER" --services "$1" \
    --query 'services[0].taskDefinition' --output text | tr -d '\r')
  case "$td" in ''|None) die "service $1 not found in $CLUSTER" ;; esac
  echo "$td"
}

# The image of a task definition's app container (its first essential container).
app_image_of() {
  aws ecs describe-task-definition --task-definition "$1" --output json \
    | jq -r '.taskDefinition.containerDefinitions | map(select(.essential == true)) | .[0].image'
}

# Copy a task definition with the app container's image (the first essential container) replaced and GIT_SHA
# set to the tag. Prints the new ARN.
register_with_image() {
  local source_arn="$1" image="$2"
  local definition
  definition=$(aws ecs describe-task-definition --task-definition "$source_arn" --include TAGS --output json)
  echo "$definition" | jq --arg image "$image" '
    .tags as $tags
    | .taskDefinition
    | (.containerDefinitions | map(.essential == true) | index(true)) as $app
    | .containerDefinitions[$app].image = $image
    | .containerDefinitions[$app].environment =
        ((.containerDefinitions[$app].environment // [])
          | map(select(.name != "GIT_SHA")) + [{name: "GIT_SHA", value: ($image | split(":") | last)}])
    | del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities,
          .registeredAt, .registeredBy, .deregisteredAt)
    | if ($tags | length) > 0 then .tags = $tags else . end
  ' > /tmp/ecs-deploy-taskdef.json
  aws ecs register-task-definition --cli-input-json file:///tmp/ecs-deploy-taskdef.json \
    --query 'taskDefinition.taskDefinitionArn' --output text | tr -d '\r'
}

# PRIMARY rolloutState, PRIMARY task definition and number of deployments of one service (tab-separated).
deployment_state() {
  aws ecs describe-services --cluster "$CLUSTER" --services "$1" \
    --query 'services[0].[deployments[?status==`PRIMARY`]|[0].rolloutState, deployments[?status==`PRIMARY`]|[0].taskDefinition, length(deployments)]' \
    --output text | tr -d '\r'
}

# Service -> the task definition ARN its PRIMARY deployment must run (set before every wait).
declare -A EXPECT_TD
# Service -> the task definition ARN every running task must be on (steps 5/6).
declare -A NEW_TD

# Waits until every service's PRIMARY deployment runs EXPECT_TD[svc], is COMPLETED and is the only deployment
# left. A PRIMARY on any other revision means ECS rolled the deploy back (or someone else deployed): failure.
wait_for_services() {
  local deadline=$(( $(date +%s) + TIMEOUT ))
  while :; do
    local pending=0
    for svc in "${SERVICE_LIST[@]}"; do
      local state td count
      read -r state td count < <(deployment_state "$svc") || return 1
      if [ -n "${EXPECT_TD[$svc]:-}" ] && [ "$td" != "${EXPECT_TD[$svc]}" ]; then
        log "$svc: PRIMARY deployment runs $td, expected ${EXPECT_TD[$svc]} (rolled back by ECS or replaced)"
        return 1
      fi
      case "$state" in
        COMPLETED) [ "$count" = "1" ] || pending=1 ;;
        FAILED) log "$svc: deployment FAILED (circuit breaker)"; return 1 ;;
        *) pending=1 ;;
      esac
    done
    [ "$pending" -eq 0 ] && return 0
    [ "$(date +%s)" -ge "$deadline" ] && { log "timed out after ${TIMEOUT}s"; return 1; }
    sleep "${POLL_SECONDS:-15}"
  done
}

rollback_to() {
  local file="$1"
  log "rolling back using $file"
  for svc in "${SERVICE_LIST[@]}"; do
    local previous
    previous=$(jq -r --arg s "$svc" '.[$s] // empty' "$file")
    [ -n "$previous" ] || { log "$svc: no previous revision recorded, skipped"; EXPECT_TD[$svc]=""; continue; }
    EXPECT_TD[$svc]="$previous"
    aws ecs update-service --cluster "$CLUSTER" --service "$svc" --task-definition "$previous" \
      --query 'service.taskDefinition' --output text >/dev/null
  done
  wait_for_services || die "rollback did not stabilise; investigate in the ECS console"
  log "rollback complete"
}

# The digest ECR holds for the image's tag (fatal when the tag is not in ECR).
ecr_digest() {
  local repository tag digest
  repository="${1#*/}"; repository="${repository%:*}"; tag="${1##*:}"
  digest=$(aws ecr describe-images --repository-name "$repository" --image-ids imageTag="$tag" \
    --query 'imageDetails[0].imageDigest' --output text | tr -d '\r')
  case "$digest" in sha256:*) echo "$digest" ;; *) die "image $1 is not in ECR (digest '$digest'); push it first" ;; esac
}

# Step 5: every running task of every service is on NEW_TD[svc] and the digest $1.
verify_tasks() {
  local digest="$1" svc arns bad
  for svc in "${SERVICE_LIST[@]}"; do
    arns=$(aws ecs list-tasks --cluster "$CLUSTER" --service-name "$svc" --desired-status RUNNING \
      --query 'taskArns' --output text | tr -d '\r')
    case "$arns" in ''|None) log "$svc: no running task"; return 1 ;; esac
    # shellcheck disable=SC2086
    bad=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks $arns --output json \
      | jq -r --arg td "${NEW_TD[$svc]}" --arg digest "$digest" '
          .tasks[] | select(.lastStatus != "STOPPED")
          | select(.taskDefinitionArn != $td or ([.containers[] | select(.imageDigest == $digest)] | length) == 0)
          | .taskArn + " " + .taskDefinitionArn') || return 1
    if [ -n "$bad" ]; then log "$svc: tasks not on the release: $bad"; return 1; fi
    log "$svc: every running task is on ${NEW_TD[$svc]} ($digest)"
  done
}

# Step 6: the public domain (CloudFront -> ALB -> tasks) reports commit $1 on several consecutive requests.
verify_domain() {
  local commit="$1" deadline=$(( $(date +%s) + ${VERIFY_TIMEOUT:-300} )) streak=0 served
  while :; do
    served=$(curl -fsS --max-time 10 -H 'Cache-Control: no-cache' "$VERIFY_URL/api/v1/health/version" 2>/dev/null \
      | jq -r '(.commit // .data.commit) // empty' 2>/dev/null || true)
    if [ "$served" = "$commit" ]; then
      streak=$((streak + 1))
      [ "$streak" -ge "${VERIFY_REQUESTS:-10}" ] && { log "$VERIFY_URL serves $commit"; return 0; }
      continue
    fi
    streak=0
    [ "$(date +%s)" -ge "$deadline" ] && { log "$VERIFY_URL serves commit '${served:-unknown}', expected $commit"; return 1; }
    sleep "${POLL_SECONDS:-15}"
  done
}

firing_alarms() {
  [ -n "$ALARM_NAMES" ] || return 0
  # shellcheck disable=SC2046
  aws cloudwatch describe-alarms --alarm-names $(echo "$ALARM_NAMES" | tr ',' ' ') --state-value ALARM \
    --query 'MetricAlarms[].AlarmName' --output text | tr -d '\r'
}

case "$MODE" in
  rollback)
    [ -n "$TO_FILE" ] || die "--rollback needs --to-file (the previous-task-definitions.json of the deploy)"
    rollback_to "$TO_FILE"
    exit 0 ;;

  status)
    running_image="" stable=true latest_revision=true first=true
    for svc in "${SERVICE_LIST[@]}"; do
      read -r state td count < <(deployment_state "$svc") || die "cannot read service $svc"
      case "$td" in ''|None) die "service $svc not found in $CLUSTER" ;; esac
      image=$(app_image_of "$td")
      family="${td##*/}"; family="${family%%:*}"
      latest=$(aws ecs describe-task-definition --task-definition "$family" \
        --query 'taskDefinition.taskDefinitionArn' --output text | tr -d '\r')
      log "$svc: $td ($state, $count deployment(s)) image $image; latest revision $latest"
      { [ "$state" = COMPLETED ] && [ "$count" = 1 ]; } || stable=false
      [ "$latest" = "$td" ] || latest_revision=false
      if [ "$first" = true ]; then running_image="$image"; first=false
      elif [ "$image" != "$running_image" ]; then running_image=""; stable=false; fi
    done
    echo "running_image=$running_image"
    echo "stable=$stable"
    echo "latest_revision=$latest_revision"
    exit 0 ;;

  verify)
    [ -n "$IMAGE" ] || die "--verify-only needs --image"
    digest=$(ecr_digest "$IMAGE")
    for svc in "${SERVICE_LIST[@]}"; do
      NEW_TD[$svc]=$(current_task_definition "$svc")
      [ "$(app_image_of "${NEW_TD[$svc]}")" = "$IMAGE" ] || die "$svc runs ${NEW_TD[$svc]}, which is not $IMAGE"
    done
    verify_tasks "$digest" || die "running tasks are not all on $IMAGE ($digest)"
    if [ -n "$VERIFY_URL" ]; then verify_domain "${IMAGE##*:}" || die "$VERIFY_URL does not serve ${IMAGE##*:}"; fi
    log "verified: ${SERVICES} run $IMAGE ($digest)"
    exit 0 ;;
esac

# ---- deploy ----
[ -n "$IMAGE" ] || die "--image is required"
case "$IMAGE" in *:latest|*:) die "refusing a mutable or empty tag: $IMAGE" ;; esac
tag="${IMAGE##*:}"

# 0. The image must be in ECR, and no deploy alarm may already be firing. Nothing has changed yet.
if [ -n "$ALARM_NAMES" ]; then
  already=$(firing_alarms)
  [ -z "$already" ] || die "alarms already firing before the deploy: $already. Resolve them first; nothing was changed."
fi
EXPECT_DIGEST=$(ecr_digest "$IMAGE")
log "image digest $EXPECT_DIGEST"

# 1. Register new revisions (previous running ones are recorded for rollback).
echo '{}' > "$STATE_FILE"
for svc in "${SERVICE_LIST[@]}"; do
  current=$(current_task_definition "$svc")
  jq --arg s "$svc" --arg td "$current" '.[$s] = $td' "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
  # The service ignores task_definition changes in Terraform, so its running revision can be older than
  # the family's latest one. Build from the latest, or Terraform's env/secret/sidecar changes never ship.
  family="${current##*/}"; family="${family%%:*}"
  NEW_TD[$svc]=$(register_with_image "$family" "$IMAGE")
  log "$svc: $current -> ${NEW_TD[$svc]} (from the latest revision of $family)"
done

# 2. Migrations (one-shot task, must exit 0).
if [ -n "$MIGRATE_FAMILY" ]; then
  [ -n "$NETWORK" ] || die "--migrate-family needs --network (terraform output -json task_network)"
  migrate_td=$(register_with_image "$MIGRATE_FAMILY" "$IMAGE")
  log "running migrations with $migrate_td"
  task_arn=$(aws ecs run-task --cluster "$CLUSTER" --task-definition "$migrate_td" --launch-type FARGATE \
    --network-configuration "{\"awsvpcConfiguration\": $NETWORK}" --started-by "ecs-deploy" \
    --query 'tasks[0].taskArn' --output text | tr -d '\r')
  case "$task_arn" in ''|None) die "migrate task did not start" ;; esac
  aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$task_arn"
  exit_code=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$task_arn" \
    --query 'tasks[0].containers[?name==`migrate`]|[0].exitCode' --output text | tr -d '\r')
  [ "$exit_code" = "0" ] || die "migrations failed (exit $exit_code); services were NOT updated. Logs: task $task_arn"
  log "migrations applied"
fi

# 3. Roll services; roll back on failure.
for svc in "${SERVICE_LIST[@]}"; do
  EXPECT_TD[$svc]="${NEW_TD[$svc]}"
  aws ecs update-service --cluster "$CLUSTER" --service "$svc" --task-definition "${NEW_TD[$svc]}" \
    --query 'service.taskDefinition' --output text >/dev/null
done

if ! wait_for_services; then
  rollback_to "$STATE_FILE"
  die "deployment failed and was rolled back"
fi

# 4. Post-deploy alarm check.
if [ -n "$ALARM_NAMES" ]; then
  sleep "${ALARM_SETTLE_SECONDS:-60}"
  firing=$(firing_alarms)
  if [ -n "$firing" ]; then
    log "alarms firing after deploy: $firing"
    rollback_to "$STATE_FILE"
    die "rolled back because alarms were firing"
  fi
fi

# 5. Every running task runs the new revision and digest.
if ! verify_tasks "$EXPECT_DIGEST"; then
  rollback_to "$STATE_FILE"
  die "running tasks did not match the release; rolled back"
fi

# 6. The public domain serves this commit.
if [ -n "$VERIFY_URL" ] && ! verify_domain "$tag"; then
  rollback_to "$STATE_FILE"
  die "the public domain did not serve the release; rolled back"
fi

log "deployed $IMAGE ($EXPECT_DIGEST) to ${SERVICES}"
