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
      if wait_rds stopped; then record stop-rds ok "stopped$([ "$SNAPSHOT_MODE" = yes ] && echo " snapshot=$SNAP_ID")"; else record stop-rds failed "not stopped within $((TIMEOUT*2))s" critical; fi
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
