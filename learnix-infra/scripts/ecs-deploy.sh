#!/usr/bin/env bash
# Deploy one image to Learnix ECS services, with migration gate and automatic rollback.
#
#   ecs-deploy.sh --cluster learnix-production --image <ecr-url>:<sha> \
#       --services api,worker [--migrate-family learnix-production-migrate] \
#       [--network '<awsvpcConfiguration JSON>'] [--alarm-names a,b,c] [--timeout 900]
#   ecs-deploy.sh --cluster learnix-production --rollback --services api,worker --to-file previous.json
#
# Steps (deploy):
#   1. Register a new revision per service from the LATEST ACTIVE revision of the service's task family
#      (Terraform owns the shape and registers a new revision when it changes; the pipeline only swaps the
#      app container's image). The service's currently running ARN is recorded in
#      ./previous-task-definitions.json (the rollback input, kept as a workflow artifact).
#   2. If --migrate-family is given: register it with the same image, run it once (awsvpc config from
#      --network = terraform output task_network), wait, and require exit code 0. Migrations are
#      advisory-locked, so a concurrent run cannot race.
#   3. update-service for each service, then wait until every deployment reaches COMPLETED. ECS's
#      circuit breaker rolls a failing deployment back by itself; this script detects that as FAILED.
#   4. Optional --alarm-names: the deploy refuses to start while one of these alarms is already in ALARM
#      (it could not tell a regression from an old problem), and rolls back if one is in ALARM afterwards.
#      Only name alarms that react to a bad release (5xx, unhealthy targets, error logs), never ones that
#      treat missing data as breaching.
#   Any failure after step 3 started -> every service is pointed back at its previous revision.
#
# Needs: aws CLI v2, jq. Credentials: the GitHub OIDC deploy role (modules/deploy-role).
set -euo pipefail

CLUSTER="" IMAGE="" SERVICES="" MIGRATE_FAMILY="" NETWORK="" ALARM_NAMES="" TIMEOUT=900
ROLLBACK=false TO_FILE="" STATE_FILE="previous-task-definitions.json"

die() { echo "::error::$*" >&2; exit 1; }
log() { echo "[ecs-deploy] $*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --cluster) CLUSTER="$2"; shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;
    --services) SERVICES="$2"; shift 2 ;;
    --migrate-family) MIGRATE_FAMILY="$2"; shift 2 ;;
    --network) NETWORK="$2"; shift 2 ;;
    --alarm-names) ALARM_NAMES="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --rollback) ROLLBACK=true; shift ;;
    --to-file) TO_FILE="$2"; shift 2 ;;
    --state-file) STATE_FILE="$2"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$CLUSTER" ] || die "--cluster is required"
[ -n "$SERVICES" ] || die "--services is required"
command -v jq >/dev/null || die "jq is required"
IFS=',' read -r -a SERVICE_LIST <<< "$SERVICES"

current_task_definition() {
  aws ecs describe-services --cluster "$CLUSTER" --services "$1" \
    --query 'services[0].taskDefinition' --output text
}

# Copy a task definition with the image of container $3 (default: the family's own app container,
# i.e. the first essential container) replaced. Prints the new ARN.
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
    --query 'taskDefinition.taskDefinitionArn' --output text
}

wait_for_services() {
  local deadline=$(( $(date +%s) + TIMEOUT ))
  while :; do
    local pending=0
    for svc in "${SERVICE_LIST[@]}"; do
      local state
      state=$(aws ecs describe-services --cluster "$CLUSTER" --services "$svc" \
        --query 'services[0].deployments[?status==`PRIMARY`]|[0].rolloutState' --output text)
      case "$state" in
        COMPLETED) ;;
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
    [ -n "$previous" ] || { log "$svc: no previous revision recorded, skipped"; continue; }
    aws ecs update-service --cluster "$CLUSTER" --service "$svc" --task-definition "$previous" \
      --query 'service.taskDefinition' --output text
  done
  wait_for_services || die "rollback did not stabilise; investigate in the ECS console"
  log "rollback complete"
}

if [ "$ROLLBACK" = true ]; then
  [ -n "$TO_FILE" ] || die "--rollback needs --to-file (the previous-task-definitions.json of the deploy)"
  rollback_to "$TO_FILE"
  exit 0
fi

[ -n "$IMAGE" ] || die "--image is required"
case "$IMAGE" in *:latest|*:) die "refusing a mutable or empty tag: $IMAGE" ;; esac

# 0. Do not deploy on top of an alarm that is already firing.
firing_alarms() {
  [ -n "$ALARM_NAMES" ] || return 0
  # shellcheck disable=SC2046
  aws cloudwatch describe-alarms --alarm-names $(echo "$ALARM_NAMES" | tr ',' ' ') --state-value ALARM     --query 'MetricAlarms[].AlarmName' --output text
}
if [ -n "$ALARM_NAMES" ]; then
  already=$(firing_alarms)
  [ -z "$already" ] || die "alarms already firing before the deploy: $already. Resolve them first; nothing was changed."
fi

# 1. Register new revisions (previous running ones are recorded for rollback).
echo '{}' > "$STATE_FILE"
declare -A NEW_TD
for svc in "${SERVICE_LIST[@]}"; do
  current=$(current_task_definition "$svc")
  [ "$current" != "None" ] || die "service $svc not found in $CLUSTER"
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
    --query 'tasks[0].taskArn' --output text)
  [ -n "$task_arn" ] && [ "$task_arn" != "None" ] || die "migrate task did not start"
  aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$task_arn"
  exit_code=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$task_arn" \
    --query 'tasks[0].containers[?name==`migrate`]|[0].exitCode' --output text)
  [ "$exit_code" = "0" ] || die "migrations failed (exit $exit_code); services were NOT updated. Logs: task $task_arn"
  log "migrations applied"
fi

# 3. Roll services; roll back on failure.
for svc in "${SERVICE_LIST[@]}"; do
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

log "deployed $IMAGE to ${SERVICES}"
