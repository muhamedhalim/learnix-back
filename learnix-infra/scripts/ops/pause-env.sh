#!/usr/bin/env bash
# Pause a Learnix environment to cut AWS cost. Manual, run from AWS Console CloudShell. Nothing is deleted.
#
#   pause-env.sh --env staging|production            # DRY-RUN (default): prints the plan, changes nothing
#   pause-env.sh --env production --execute          # asks for typed confirmation, then pauses
#   pause-env.sh --env staging --status              # read-only: what is paused / running now
#   Options: [--region eu-central-1] [--snapshot|--no-snapshot] [--no-mute-alarms] [--state-dir DIR] [--timeout 900]
#
# What it does (in this order):
#   preflight -> mute alarm actions -> stop canary (only if RUNNING) -> clamp auto-scaling targets to 0
#   -> ECS api=0 -> ECS worker=0 -> RDS stop (production: with a manual pre-pause snapshot) -> post-verify -> state
# What it never does: delete anything, run terraform, touch DNS, IAM, KMS, Secrets, S3 objects, Backup, schemas,
#   ElastiCache, NAT, ALB, CloudFront or WAF. Those keep billing (see docs/PAUSE-RESUME-RUNBOOK.md).
# Exit codes: 0 ok/dry-run, 2 refused (guard/preflight), 3 a non-critical step failed, 4 a critical step failed,
#   5 post-verification failed.
# Restore with resume-env.sh. RDS restarts BY ITSELF after 7 days: re-run this script before then.
SCRIPT="pause-env"

#@COMMON@

# ---------------------------------------------------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_NAME="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --execute) EXECUTE=1; shift ;;
    --snapshot) SNAPSHOT_MODE=yes; shift ;;
    --no-snapshot) SNAPSHOT_MODE=no; shift ;;
    --no-mute-alarms) MUTE_ALARMS=0; shift ;;
    --state-dir) STATE_DIR="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --status) STATUS_ONLY=1; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
setup_env
verify_identity
log "identity: $CALLER_ARN"

status_report() {
  verify_environment
  local s
  for s in "${SERVICE_LIST[@]}"; do
    log "ecs $CLUSTER/$s desired=$(svc_field "$s" desired) running=$(svc_field "$s" running) scaling_target=[$(scalable_target "$s")]"
  done
  log "rds $DB_ID status=$(rds_field Status)"
  log "valkey $VALKEY_ID status=$(valkey_status)"
  [ -z "$CANARY" ] || log "canary $CANARY state=$(canary_state)"
  log "alarms with actions enabled: $(aws_ cloudwatch describe-alarms --alarm-name-prefix "$ALARM_PREFIX" --query 'length(MetricAlarms[?ActionsEnabled==`true`])') / $(aws_ cloudwatch describe-alarms --alarm-name-prefix "$ALARM_PREFIX" --query 'length(MetricAlarms)')"
  local last; last=$(ls -1t "$STATE_DIR/$ENV_NAME-"*.state 2>/dev/null | head -1 || true)
  [ -z "$last" ] || log "latest pause state file: $last ($(grep '^RDS_AUTO_RESTART_BY' "$last" | cut -d' ' -f2-))"
}
if [ "$STATUS_ONLY" = 1 ]; then status_report; exit 0; fi

# ---- Phase 1: environment proof + preflight ------------------------------------------------------------------
verify_environment
PRE_FAIL=0
pre() { log "preflight FAIL: $*"; PRE_FAIL=1; }

declare -A PRIOR_DESIRED PRIOR_TD PRIOR_MIN PRIOR_MAX HAS_TARGET
for s in "${SERVICE_LIST[@]}"; do
  PRIOR_DESIRED[$s]=$(svc_field "$s" desired); PRIOR_TD[$s]=$(svc_field "$s" td)
  t=$(scalable_target "$s")
  if [ -n "$t" ]; then HAS_TARGET[$s]=1; PRIOR_MIN[$s]=${t%%$'\t'*}; PRIOR_MAX[$s]=${t##*$'\t'}; else HAS_TARGET[$s]=0; PRIOR_MIN[$s]=""; PRIOR_MAX[$s]=""; fi
  if [ "${PRIOR_DESIRED[$s]}" != 0 ]; then
    [ "$(svc_field "$s" deployments)" = 1 ] || pre "service $s has a deployment in progress"
    [ "$(svc_field "$s" running)" = "${PRIOR_DESIRED[$s]}" ] || pre "service $s running != desired (not steady)"
  fi
done
standalone=$(aws_ ecs list-tasks --cluster "$CLUSTER" --desired-status RUNNING --query 'taskArns' | wc -w)
total_service_tasks=0; for s in "${SERVICE_LIST[@]}"; do total_service_tasks=$((total_service_tasks + $(svc_field "$s" running))); done
[ "$standalone" -le "$total_service_tasks" ] || pre "extra RUNNING tasks in $CLUSTER (a migrate task or other service?): $standalone vs $total_service_tasks"

RDS_STATUS=$(rds_field Status)
case "$RDS_STATUS" in
  available) [ "$(rds_field Pending)" = 0 ] || pre "RDS has pending modifications"
             rt=$(rds_field Restorable)
             if [ -n "$rt" ] && [ $(( $(date -u +%s) - $(date -u -d "$rt" +%s) )) -gt 900 ]; then pre "RDS latest restorable time is older than 15 min ($rt)"; fi ;;
  stopped|stopping) log "RDS already $RDS_STATUS" ;;
  *) pre "RDS status is $RDS_STATUS" ;;
esac
if [ "$RDS_STATUS" = available ]; then
  nb=$(aws_ rds describe-db-instance-automated-backups --db-instance-identifier "$DB_ID" --query 'length(DBInstanceAutomatedBackups)')
  [ "$nb" -ge 1 ] || pre "no automated backup found for $DB_ID"
fi
if [ "$ENV_NAME" = production ]; then
  repl=$(none_to_empty "$(aws --region "$DR_REGION" rds describe-db-instance-automated-backups --query "DBInstanceAutomatedBackups[?DBInstanceIdentifier=='$DB_ID']|[0].Status" --output text | tr -d '\r')")
  [ "$repl" = replicating ] || pre "cross-region backup replication status is '$repl' (expected replicating)"
fi
[ "$(valkey_status)" = available ] || pre "Valkey $VALKEY_ID is not available (it stays untouched, but queued jobs matter)"
if [ "$PRE_FAIL" = 1 ]; then record preflight failed "see log"; summary_json; exit 2; fi
record preflight ok "env=$ENV_NAME cluster=$CLUSTER db=$DB_ID"

# ---- Plan ----------------------------------------------------------------------------------------------------
if [ "$SNAPSHOT_MODE" = default ]; then [ "$ENV_NAME" = production ] && SNAPSHOT_MODE=yes || SNAPSHOT_MODE=no; fi
SNAP_ID="pre-pause-$RUN_ID"; SNAP_ID=$(echo "$SNAP_ID" | tr 'A-Z' 'a-z')
mapfile -t TO_MUTE < <([ "$MUTE_ALARMS" = 1 ] && aws_ cloudwatch describe-alarms --alarm-name-prefix "$ALARM_PREFIX" \
  --query 'MetricAlarms[?ActionsEnabled==`true`].AlarmName' --output text | tr '\t' '\n' | sed '/^$/d' || true)
CANARY_STATE=$(canary_state)
echo
echo "==================== PAUSE PLAN  env=$ENV_NAME  account=$ALLOWED_ACCOUNT  region=$REGION ===================="
echo "1. mute ${#TO_MUTE[@]} alarm action sets (prefix $ALARM_PREFIX)"
[ -z "$CANARY" ] || echo "2. canary $CANARY: state=$CANARY_STATE -> $([ "$CANARY_STATE" = RUNNING ] && echo stop || echo 'leave')"
for s in "${SERVICE_LIST[@]}"; do
  echo "3. ecs $CLUSTER/$s: desired ${PRIOR_DESIRED[$s]} -> 0$([ "${HAS_TARGET[$s]}" = 1 ] && echo "; scaling target min/max ${PRIOR_MIN[$s]}/${PRIOR_MAX[$s]} -> 0/0")"
done
echo "4. rds $DB_ID: $RDS_STATUS -> stopped $([ "$SNAPSHOT_MODE" = yes ] && echo "(manual snapshot $SNAP_ID first)")"
echo "   NOT touched: Valkey, NAT gateway, ALB, CloudFront, WAF, secrets, KMS, S3, backups, DNS."
[ "$ENV_NAME" != production ] || echo "   WARNING: api.learnix.school will return errors while paused."
echo "   RDS restarts automatically after 7 days (about $(date -u -d '+7 days' +%F)); re-run this script before then."
echo "==========================================================================================================="
if [ "$EXECUTE" != 1 ]; then log "DRY-RUN: nothing was changed. Add --execute to apply."; fi
confirm "pause learnix-$ENV_NAME in $ALLOWED_ACCOUNT"
verify_identity

STATE_FILE="$STATE_DIR/$ENV_NAME-$RUN_ID.state"
if [ "$EXECUTE" = 1 ]; then
  {
    echo "META $ENV_NAME $ALLOWED_ACCOUNT $REGION $RUN_ID"
    echo "RDS_PRIOR_STATUS $RDS_STATUS"
    echo "RDS_AUTO_RESTART_BY $(date -u -d '+7 days' +%FT%TZ)"
    echo "CANARY $CANARY_STATE"
    for s in "${SERVICE_LIST[@]}"; do echo "SVC $s ${PRIOR_DESIRED[$s]} ${HAS_TARGET[$s]} ${PRIOR_MIN[$s]:--} ${PRIOR_MAX[$s]:--} ${PRIOR_TD[$s]}"; done
    for a in "${TO_MUTE[@]:-}"; do [ -n "$a" ] && echo "ALARM $a"; done
  } > "$STATE_FILE"
  log "state saved: $STATE_FILE"
fi

# ---- Phase 2: actions ----------------------------------------------------------------------------------------
if [ "${#TO_MUTE[@]}" -gt 0 ]; then
  verify_identity
  if chunk_alarms disable "${TO_MUTE[@]}"; then record mute-alarms "$([ "$EXECUTE" = 1 ] && echo ok || echo dry-run)" "${#TO_MUTE[@]} alarms"
  else record mute-alarms failed "disable-alarm-actions"; fi
else record mute-alarms skipped "none enabled or --no-mute-alarms"; fi

if [ "$CANARY_STATE" = RUNNING ]; then
  if run aws --region "$REGION" synthetics stop-canary --name "$CANARY"; then record stop-canary "$([ "$EXECUTE" = 1 ] && echo ok || echo dry-run)" "$CANARY"; else record stop-canary failed "$CANARY"; fi
else record stop-canary skipped "state=${CANARY_STATE:-n/a}"; fi

for s in "${SERVICE_LIST[@]}"; do
  verify_identity
  if [ "${HAS_TARGET[$s]}" = 1 ]; then
    if run aws --region "$REGION" application-autoscaling register-scalable-target --service-namespace ecs \
         --scalable-dimension ecs:service:DesiredCount --resource-id "service/$CLUSTER/$s" --min-capacity 0 --max-capacity 0
    then record "clamp-scaling-$s" "$([ "$EXECUTE" = 1 ] && echo ok || echo dry-run)" "was ${PRIOR_MIN[$s]}/${PRIOR_MAX[$s]}"
    else record "clamp-scaling-$s" failed "register-scalable-target" critical; fi
  else record "clamp-scaling-$s" skipped "no scalable target"; fi
done
# ECS scaling follows (scaling targets are clamped first so auto scaling cannot raise the count again);
# api drains before worker.
for s in "${SERVICE_LIST[@]}"; do
  if [ "${PRIOR_DESIRED[$s]}" = 0 ]; then record "scale-$s" skipped "already 0"; continue; fi
  if [ "$CRITICAL_FAILED" = 1 ]; then record "scale-$s" skipped "earlier critical failure"; continue; fi
  verify_identity
  if run aws --region "$REGION" ecs update-service --cluster "$CLUSTER" --service "$s" --desired-count 0; then
    if [ "$EXECUTE" = 1 ]; then
      if wait_service_idle "$s" 0; then record "scale-$s" ok "0 tasks"; else record "scale-$s" failed "did not reach 0 tasks in ${TIMEOUT}s" critical; fi
    else record "scale-$s" dry-run "-> 0"; fi
  else record "scale-$s" failed "update-service" critical; fi
done

# RDS is stopped only if no task is left that could be using it.
if [ "$RDS_STATUS" != available ]; then
  record stop-rds skipped "status=$RDS_STATUS"
elif [ "$CRITICAL_FAILED" = 1 ]; then
  record stop-rds skipped "earlier critical failure: tasks may still be running"
else
  verify_identity
  args=(--db-instance-identifier "$DB_ID"); [ "$SNAPSHOT_MODE" = yes ] && args+=(--db-snapshot-identifier "$SNAP_ID")
  if run aws --region "$REGION" rds stop-db-instance "${args[@]}"; then
    if [ "$EXECUTE" = 1 ]; then
      [ "$SNAPSHOT_MODE" != yes ] || echo "RDS_SNAPSHOT $SNAP_ID" >> "$STATE_FILE"
      if wait_rds stopped; then record stop-rds ok "stopped${SNAP_ID:+ snapshot=$SNAP_ID}"; else record stop-rds failed "not stopped within $((TIMEOUT*2))s" critical; fi
    else record stop-rds dry-run "snapshot=$SNAPSHOT_MODE"; fi
  else record stop-rds failed "stop-db-instance" critical; fi
fi

# ---- Phase 3: post-verification + state upload ---------------------------------------------------------------
if [ "$EXECUTE" = 1 ]; then
  VERIFY_FAIL=0
  for s in "${SERVICE_LIST[@]}"; do
    [ "$(svc_field "$s" running)" = 0 ] || { log "verify FAIL: $s still has running tasks"; VERIFY_FAIL=1; }
  done
  [ "$(rds_field Status)" = stopped ] || { log "verify FAIL: RDS not stopped (status=$(rds_field Status))"; VERIFY_FAIL=1; }
  if [ "$VERIFY_FAIL" = 1 ]; then record post-verify failed "see log"; else record post-verify ok "tasks=0 rds=stopped"; fi
  if aws --region "$REGION" s3 cp "$STATE_FILE" "s3://$LOGS_BUCKET/ops/pause/$(basename "$STATE_FILE")" --only-show-errors; then
    record state-upload ok "s3://$LOGS_BUCKET/ops/pause/"; else record state-upload failed "local copy kept at $STATE_FILE"; fi
  echo
  echo "Still billing while paused: Valkey, ALB, WAF, CloudFront (+ flat-rate plan if subscribed), secrets, KMS, logs, backups, S3,$([ "$ENV_NAME" = production ] && echo ' NAT gateway + its Elastic IP,') RDS storage."
  echo "RDS auto-restarts around $(date -u -d '+7 days' +%F). Resume with: resume-env.sh --env $ENV_NAME --execute"
  [ "$VERIFY_FAIL" = 0 ] || { summary_json | tee "$STATE_DIR/$ENV_NAME-$SCRIPT-$RUN_ID.json"; exit 5; }
fi
finish
