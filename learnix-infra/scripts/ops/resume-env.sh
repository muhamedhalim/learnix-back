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

# ---------------------------------------------------------------------------------------------------------------
# Common section (identical in pause-env.sh and resume-env.sh so each file runs on its own in CloudShell).
# Needs: bash, aws CLI v2, curl (resume smoke test), GNU date. No jq.
# ---------------------------------------------------------------------------------------------------------------
set -Eeuo pipefail

readonly ALLOWED_ACCOUNT="486940690416"   # staging AND production share this account: names decide the environment
readonly ALLOWED_REGION="eu-central-1"
readonly DR_REGION="eu-west-1"

ENV_NAME="" REGION="$ALLOWED_REGION" EXECUTE=0 STATE_FILE_ARG="" STATE_DIR="${HOME:-.}/learnix-pause"
SNAPSHOT_MODE=default MUTE_ALARMS=1 STATUS_ONLY=0 TIMEOUT=900 POLL=15
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
STEPS=() CRITICAL_FAILED=0 NONCRIT_FAILED=0

die() { echo "[$SCRIPT] ERROR: $*" >&2; exit "${2:-2}"; }
log() { echo "[$SCRIPT] $(date -u +%H:%M:%S) $*" >&2; }

# AWS CLI: retry/throttle handling; never prompts; no pager.
export AWS_RETRY_MODE=adaptive AWS_MAX_ATTEMPTS=10 AWS_PAGER="" AWS_DEFAULT_OUTPUT=text
aws_() { aws --region "$REGION" "$@" | tr -d '\r'; }
none_to_empty() { case "$1" in None|null) echo "" ;; *) echo "$1" ;; esac; }

# Environment allowlist. Anything not derived from these names is never touched.
setup_env() {
  case "$ENV_NAME" in
    staging)    SERVICE_LIST=(api);        CANARY="" ;;
    production) SERVICE_LIST=(api worker); CANARY="learnix-production-he" ;;
    *) die "--env staging|production is required" ;;
  esac
  [ "$REGION" = "$ALLOWED_REGION" ] || die "region $REGION refused (only $ALLOWED_REGION)"
  CLUSTER="learnix-$ENV_NAME"; DB_ID="learnix-$ENV_NAME-pg"; VALKEY_ID="learnix-$ENV_NAME-valkey"
  ALARM_PREFIX="learnix-$ENV_NAME-"; LOGS_BUCKET="learnix-$ENV_NAME-logs-$ALLOWED_ACCOUNT"
  mkdir -p "$STATE_DIR"
}

# Account check; run before every phase (credentials can change under a long session).
CALLER_ARN=""
verify_identity() {
  local out acct
  out=$(aws --region "$REGION" sts get-caller-identity --query '[Account,Arn]' --output text | tr -d '\r') \
    || die "cannot call sts get-caller-identity (no credentials?)" 2
  acct=${out%%$'\t'*}; CALLER_ARN=${out#*$'\t'}
  [ "$acct" = "$ALLOWED_ACCOUNT" ] || die "account $acct is not $ALLOWED_ACCOUNT - refusing" 2
}

# Dry-run aware mutation. Reads always run; run() only executes with --execute.
run() {
  if [ "$EXECUTE" = 1 ]; then "$@" >/dev/null; else log "DRY-RUN would run: $*"; fi
}

# Step bookkeeping: record <step> <ok|skipped|failed|dry-run> <detail> [critical]
json_str() { local s=${1//\\/\\\\}; s=${s//\"/\\\"}; printf '"%s"' "$s"; }
record() {
  STEPS+=("{\"step\":$(json_str "$1"),\"result\":$(json_str "$2"),\"detail\":$(json_str "${3:-}")}")
  log "step=$1 result=$2 ${3:-}"
  if [ "$2" = failed ]; then
    if [ "${4:-}" = critical ]; then CRITICAL_FAILED=1; else NONCRIT_FAILED=1; fi
  fi
}
summary_json() {
  local joined="" s
  for s in "${STEPS[@]:-}"; do [ -n "$s" ] && joined+="${joined:+,}$s"; done
  printf '{"script":"%s","run_id":"%s","env":"%s","account":"%s","region":"%s","mode":"%s","caller":%s,"critical_failed":%s,"noncritical_failed":%s,"steps":[%s]}\n' \
    "$SCRIPT" "$RUN_ID" "$ENV_NAME" "$ALLOWED_ACCOUNT" "$REGION" "$([ "$EXECUTE" = 1 ] && echo execute || echo dry-run)" \
    "$(json_str "$CALLER_ARN")" "$CRITICAL_FAILED" "$NONCRIT_FAILED" "$joined"
}
finish() {
  local code=0
  [ "$NONCRIT_FAILED" = 1 ] && code=3
  [ "$CRITICAL_FAILED" = 1 ] && code=4
  summary_json | tee "$STATE_DIR/$ENV_NAME-$SCRIPT-$RUN_ID.json"
  exit "$code"
}
on_error() { local rc=$?; echo "[$SCRIPT] unexpected error (exit $rc) at line $1" >&2; CRITICAL_FAILED=1; summary_json >&2; exit 4; }
trap 'on_error $LINENO' ERR

confirm() {   # confirm <exact text to type>; dry-run needs no confirmation
  [ "$EXECUTE" = 1 ] || return 0
  local typed
  case "$CALLER_ARN" in
    *:root) echo "!!! You are the AWS ROOT user. Root bypasses every guardrail and this account has no CloudTrail trail."
            echo "!!! Prefer an operator role (docs/PAUSE-RESUME-RUNBOOK.md)."
            read -r -p "Type I AM ROOT to continue: " typed; [ "$typed" = "I AM ROOT" ] || die "aborted" ;;
  esac
  read -r -p "Type '$1' to continue: " typed; [ "$typed" = "$1" ] || die "confirmation mismatch - nothing was changed"
}

# ---- read helpers ----------------------------------------------------------------------------------------------
svc_field() {  # svc_field <service> <desired|running|deployments|rollout|td>
  local q
  case "$2" in
    desired) q='services[0].desiredCount' ;; running) q='services[0].runningCount' ;;
    deployments) q='length(services[0].deployments)' ;;
    rollout) q='services[0].deployments[?status==`PRIMARY`]|[0].rolloutState' ;;
    td) q='services[0].taskDefinition' ;;
  esac
  none_to_empty "$(aws_ ecs describe-services --cluster "$CLUSTER" --services "$1" --query "$q")"
}
scalable_target() {  # prints "min<TAB>max" or empty
  none_to_empty "$(aws_ application-autoscaling describe-scalable-targets --service-namespace ecs \
    --resource-ids "service/$CLUSTER/$1" --scalable-dimension ecs:service:DesiredCount \
    --query 'ScalableTargets[0].[MinCapacity,MaxCapacity]')"
}
rds_field() {  # rds_field <Status|Restorable|Pending>
  local q
  case "$1" in Status) q='DBInstances[0].DBInstanceStatus' ;; Restorable) q='DBInstances[0].LatestRestorableTime' ;;
    Pending) q='length(keys(DBInstances[0].PendingModifiedValues))' ;; esac
  none_to_empty "$(aws_ rds describe-db-instances --db-instance-identifier "$DB_ID" --query "$q")"
}
valkey_status() { none_to_empty "$(aws_ elasticache describe-replication-groups --replication-group-id "$VALKEY_ID" --query 'ReplicationGroups[0].Status')"; }
canary_state() { [ -n "$CANARY" ] || return 0; none_to_empty "$(aws_ synthetics get-canary --name "$CANARY" --query 'Canary.Status.State' 2>/dev/null || true)"; }

# Environment ownership proof: VPC by Name tag, cluster exists, RDS tagged for this environment.
verify_environment() {
  local vpcs cl tag arn s
  vpcs=$(aws_ ec2 describe-vpcs --filters "Name=tag:Name,Values=learnix-$ENV_NAME" --query 'length(Vpcs)')
  [ "$vpcs" = 1 ] || die "expected exactly one VPC named learnix-$ENV_NAME, found $vpcs"
  cl=$(none_to_empty "$(aws_ ecs describe-clusters --clusters "$CLUSTER" --query 'clusters[?status==`ACTIVE`].clusterName|[0]')")
  [ "$cl" = "$CLUSTER" ] || die "ECS cluster $CLUSTER not found/active"
  arn=$(none_to_empty "$(aws_ rds describe-db-instances --db-instance-identifier "$DB_ID" --query 'DBInstances[0].DBInstanceArn')")
  [ -n "$arn" ] || die "RDS instance $DB_ID not found"
  tag=$(none_to_empty "$(aws_ rds list-tags-for-resource --resource-name "$arn" --query 'TagList[?Key==`Environment`].Value|[0]')")
  if [ -n "$tag" ] && [ "$tag" != "$ENV_NAME" ]; then die "RDS $DB_ID is tagged Environment=$tag, expected $ENV_NAME"; fi
  [ -n "$tag" ] || log "WARNING: $DB_ID has no Environment tag; ownership rests on the name and VPC only"
  for s in "${SERVICE_LIST[@]}"; do
    [ -n "$(svc_field "$s" td)" ] || die "service $s not found in $CLUSTER"
  done
}

wait_service_idle() {  # wait_service_idle <service> <count>: desired==running==count and a single deployment
  local deadline=$((SECONDS+TIMEOUT)) d r n
  while :; do
    d=$(svc_field "$1" desired); r=$(svc_field "$1" running); n=$(svc_field "$1" deployments)
    if [ "$d" = "$2" ] && [ "$r" = "$2" ] && [ "$n" = 1 ]; then return 0; fi
    [ $SECONDS -lt $deadline ] || return 1
    sleep "$POLL"
  done
}
wait_rds() {  # wait_rds <status>
  local deadline=$((SECONDS+TIMEOUT*2))
  while [ "$(rds_field Status)" != "$1" ]; do
    [ $SECONDS -lt $deadline ] || return 1
    sleep "$POLL"
  done
}
chunk_alarms() {  # chunk_alarms <enable|disable> names...   (API limit is 100 names per call)
  local action=$1 n; shift
  while [ $# -gt 0 ]; do
    n=$(( $# < 50 ? $# : 50 ))
    run aws --region "$REGION" cloudwatch "${action}-alarm-actions" --alarm-names "${@:1:$n}"
    shift "$n"
  done
}
# ---- end common section ---------------------------------------------------------------------------------------

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
