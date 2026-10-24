#!/usr/bin/env bash
# Resume a Learnix environment paused by pause-env.sh. Manual, run from AWS Console CloudShell.
#
#   resume-env.sh --env staging|production            # DRY-RUN (default): prints the plan, changes nothing
#   resume-env.sh --env production --execute          # asks for typed confirmation, then resumes
#   resume-env.sh --env staging --status              # read-only
#   Options: [--state FILE] [--region eu-central-1] [--state-dir DIR] [--timeout 900]
#            [--verify-url https://api.learnix.school] [--skip-smoke]
#
# Order: start RDS -> check Valkey -> restore auto-scaling min/max -> ECS api -> ECS worker -> health checks
#   -> re-enable the alarm actions pause-env.sh muted -> restart the canary if it was RUNNING.
# State comes from --state, else the newest local ~/learnix-pause/<env>-*.state that recorded running services,
#   else the newest one in s3://learnix-<env>-logs-<account>/ops/pause/, else the repo baseline (api 1, worker 1).
# It never runs migrations, changes task definitions/images, touches DNS or Terraform. Task IPs are new after a
# resume; the ALB, CloudFront and NAT gateway were never removed, so endpoints are unchanged.
# Exit codes: 0 ok/dry-run, 2 refused, 3 non-critical failure, 4 critical failure, 5 health verification failed.
SCRIPT="resume-env"

#@COMMON@

# ---------------------------------------------------------------------------------------------------------------
VERIFY_URL="" SKIP_SMOKE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_NAME="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --execute) EXECUTE=1; shift ;;
    --state) STATE_FILE_ARG="$2"; shift 2 ;;
    --state-dir) STATE_DIR="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --verify-url) VERIFY_URL="${2%/}"; shift 2 ;;
    --skip-smoke) SKIP_SMOKE=1; shift ;;
    --status) STATUS_ONLY=1; shift ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
setup_env
verify_identity
log "identity: $CALLER_ARN"
[ -n "$VERIFY_URL" ] || { [ "$ENV_NAME" = production ] && VERIFY_URL="https://api.learnix.school" || true; }

if [ "$STATUS_ONLY" = 1 ]; then
  verify_environment
  for s in "${SERVICE_LIST[@]}"; do log "ecs $CLUSTER/$s desired=$(svc_field "$s" desired) running=$(svc_field "$s" running) scaling_target=[$(scalable_target "$s")]"; done
  log "rds $DB_ID status=$(rds_field Status)"; log "valkey $VALKEY_ID status=$(valkey_status)"
  [ -z "$CANARY" ] || log "canary $CANARY state=$(canary_state)"
  exit 0
fi
verify_environment

# ---- State selection -------------------------------------------------------------------------------------------
state_has_running() { grep -Eq '^SVC [a-z]+ [1-9][0-9]* ' "$1"; }
STATE_SOURCE=""
if [ -n "$STATE_FILE_ARG" ]; then
  [ -f "$STATE_FILE_ARG" ] || die "--state file not found: $STATE_FILE_ARG"
  PICKED="$STATE_FILE_ARG"; STATE_SOURCE="--state"
else
  PICKED=""
  for f in $(ls -1t "$STATE_DIR/$ENV_NAME-"*.state 2>/dev/null || true); do
    if state_has_running "$f"; then PICKED="$f"; STATE_SOURCE="local"; break; fi
  done
  if [ -z "$PICKED" ]; then
    key=$(aws --region "$REGION" s3 ls "s3://$LOGS_BUCKET/ops/pause/" 2>/dev/null | awk '{print $4}' | grep "^$ENV_NAME-.*\.state$" | sort -r | head -50 | while read -r k; do
      aws --region "$REGION" s3 cp "s3://$LOGS_BUCKET/ops/pause/$k" "$STATE_DIR/$k" --only-show-errors && state_has_running "$STATE_DIR/$k" && { echo "$k"; break; }
    done || true)
    [ -z "$key" ] || { PICKED="$STATE_DIR/$key"; STATE_SOURCE="s3"; }
  fi
fi

declare -A WANT_DESIRED WANT_TARGET WANT_MIN WANT_MAX
MUTED=() CANARY_WAS="" RDS_SNAPSHOT=""
# Repo baseline (terraform: launch.tfvars / variables.tf) used where the state has nothing usable.
declare -A BASE_MIN=([api]=1 [worker]=1) BASE_MAX=([api]=$([ "$ENV_NAME" = production ] && echo 6 || echo 1) [worker]=4)
for s in "${SERVICE_LIST[@]}"; do WANT_DESIRED[$s]=1; WANT_TARGET[$s]=-; WANT_MIN[$s]=${BASE_MIN[$s]}; WANT_MAX[$s]=${BASE_MAX[$s]}; done
if [ -n "$PICKED" ]; then
  while read -r kind a b c d e f; do
    case "$kind" in
      SVC) # name desired has_target min max td
           [[ " ${SERVICE_LIST[*]} " == *" $a "* ]] || continue
           [ "$b" -gt 0 ] && WANT_DESIRED[$a]=$b
           WANT_TARGET[$a]=$c
           if [ "$c" = 1 ]; then
             [ "$d" != "-" ] && [ "$d" -gt 0 ] && WANT_MIN[$a]=$d
             [ "$e" != "-" ] && [ "$e" -gt 0 ] && WANT_MAX[$a]=$e
           fi ;;
      ALARM) MUTED+=("$a") ;;
      CANARY) CANARY_WAS="$a" ;;
      RDS_SNAPSHOT) RDS_SNAPSHOT="$a" ;;
    esac
  done < "$PICKED"
  STATE_SOURCE="$STATE_SOURCE:$PICKED"
else
  STATE_SOURCE="baseline (no usable state file; alarms are NOT re-enabled and the canary is NOT restarted)"
fi

RDS_STATUS=$(rds_field Status)
echo
echo "==================== RESUME PLAN  env=$ENV_NAME  account=$ALLOWED_ACCOUNT  region=$REGION ===================="
echo "state: $STATE_SOURCE"
echo "1. rds $DB_ID: $RDS_STATUS -> available"
echo "2. valkey $VALKEY_ID: $(valkey_status) (must be available)"
for s in "${SERVICE_LIST[@]}"; do
  echo "3. ecs $CLUSTER/$s: desired $(svc_field "$s" desired) -> ${WANT_DESIRED[$s]}$([ "$(scalable_target "$s")" ] && echo "; scaling target -> ${WANT_MIN[$s]}/${WANT_MAX[$s]}")"
done
echo "4. health: ALB target health$([ -n "$VERIFY_URL" ] && [ "$SKIP_SMOKE" = 0 ] && echo ", GET $VERIFY_URL/api/v1/health and /health/readiness")"
echo "5. alarms: re-enable ${#MUTED[@]} saved alarm action sets"
[ -z "$CANARY" ] || echo "6. canary $CANARY: $([ "$CANARY_WAS" = RUNNING ] && echo start || echo "leave (was ${CANARY_WAS:-unknown})")"
echo "==========================================================================================================="
if [ "$EXECUTE" != 1 ]; then log "DRY-RUN: nothing was changed. Add --execute to apply."; fi
confirm "resume learnix-$ENV_NAME in $ALLOWED_ACCOUNT"
verify_identity

# ---- Actions ---------------------------------------------------------------------------------------------------
# 1. RDS
case "$RDS_STATUS" in
  available) record start-rds skipped "already available" ;;
  stopping) if [ "$EXECUTE" = 1 ]; then wait_rds stopped || true; fi
            ;&
  stopped)  if [ "$(rds_field Status)" = available ]; then record start-rds skipped "already available"
            elif run aws --region "$REGION" rds start-db-instance --db-instance-identifier "$DB_ID"; then
              if [ "$EXECUTE" = 1 ]; then wait_rds available && record start-rds ok "available" || record start-rds failed "not available in time" critical
              else record start-rds dry-run "start"; fi
            else record start-rds failed "start-db-instance" critical; fi ;;
  starting|backing-up|configuring-enhanced-monitoring) if [ "$EXECUTE" = 1 ]; then wait_rds available && record start-rds ok "became available" || record start-rds failed "timeout" critical; else record start-rds dry-run "wait"; fi ;;
  *) record start-rds failed "unexpected status $RDS_STATUS" critical ;;
esac
# 2. Valkey (never stopped, just verified)
if [ "$(valkey_status)" = available ]; then record check-valkey ok "available"; else record check-valkey failed "status=$(valkey_status)" critical; fi

# 3. ECS (only if the database is up)
for s in "${SERVICE_LIST[@]}"; do
  if [ "$CRITICAL_FAILED" = 1 ]; then record "resume-$s" skipped "earlier critical failure"; continue; fi
  verify_identity
  if [ -n "$(scalable_target "$s")" ]; then
    if run aws --region "$REGION" application-autoscaling register-scalable-target --service-namespace ecs \
         --scalable-dimension ecs:service:DesiredCount --resource-id "service/$CLUSTER/$s" \
         --min-capacity "${WANT_MIN[$s]}" --max-capacity "${WANT_MAX[$s]}"
    then record "restore-scaling-$s" "$([ "$EXECUTE" = 1 ] && echo ok || echo dry-run)" "${WANT_MIN[$s]}/${WANT_MAX[$s]}"
    else record "restore-scaling-$s" failed "register-scalable-target" critical; continue; fi
  fi
  if run aws --region "$REGION" ecs update-service --cluster "$CLUSTER" --service "$s" --desired-count "${WANT_DESIRED[$s]}"; then
    if [ "$EXECUTE" = 1 ]; then
      if wait_service_idle "$s" "${WANT_DESIRED[$s]}"; then record "resume-$s" ok "${WANT_DESIRED[$s]} task(s) steady"
      else record "resume-$s" failed "not steady at ${WANT_DESIRED[$s]} within ${TIMEOUT}s" critical; fi
    else record "resume-$s" dry-run "-> ${WANT_DESIRED[$s]}"; fi
  else record "resume-$s" failed "update-service" critical; fi
done

# 4. Health
VERIFY_FAIL=0
if [ "$EXECUTE" = 1 ] && [ "$CRITICAL_FAILED" = 0 ]; then
  tg=$(none_to_empty "$(aws_ ecs describe-services --cluster "$CLUSTER" --services api --query 'services[0].loadBalancers[0].targetGroupArn')")
  if [ -n "$tg" ]; then
    deadline=$((SECONDS+300)); healthy=0
    while [ $SECONDS -lt $deadline ]; do
      healthy=$(aws_ elbv2 describe-target-health --target-group-arn "$tg" --query 'length(TargetHealthDescriptions[?TargetHealth.State==`healthy`])')
      [ "$healthy" -ge 1 ] && break; sleep "$POLL"
    done
    if [ "$healthy" -ge 1 ]; then record alb-target-health ok "$healthy healthy"; else record alb-target-health failed "no healthy target" ; VERIFY_FAIL=1; fi
  fi
  if [ -n "$VERIFY_URL" ] && [ "$SKIP_SMOKE" = 0 ]; then
    for p in /api/v1/health /api/v1/health/readiness; do
      code=000; for _ in 1 2 3 4 5 6; do
        code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$VERIFY_URL$p" || true); [ "$code" = 200 ] && break; sleep 10
      done
      if [ "$code" = 200 ]; then record "smoke$p" ok "200"; else record "smoke$p" failed "http $code"; VERIFY_FAIL=1; fi
    done
  fi
fi

# 5. Alarms and canary (restore exactly what pause muted/stopped)
if [ "${#MUTED[@]}" -gt 0 ] && [ "$CRITICAL_FAILED" = 0 ]; then
  if chunk_alarms enable "${MUTED[@]}"; then record enable-alarms "$([ "$EXECUTE" = 1 ] && echo ok || echo dry-run)" "${#MUTED[@]} alarms"; else record enable-alarms failed "enable-alarm-actions"; fi
else record enable-alarms skipped "nothing saved or earlier failure"; fi
if [ "$CANARY_WAS" = RUNNING ] && [ "$CRITICAL_FAILED" = 0 ]; then
  if run aws --region "$REGION" synthetics start-canary --name "$CANARY"; then record start-canary "$([ "$EXECUTE" = 1 ] && echo ok || echo dry-run)" "$CANARY"; else record start-canary failed "$CANARY"; fi
else record start-canary skipped "was ${CANARY_WAS:-n/a}"; fi

if [ "$EXECUTE" = 1 ] && [ "$VERIFY_FAIL" = 1 ]; then summary_json | tee "$STATE_DIR/$ENV_NAME-$SCRIPT-$RUN_ID.json"; exit 5; fi
finish
