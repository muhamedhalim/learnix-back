#!/usr/bin/env bash
# Resume a Learnix environment paused by pause-env.sh. Manual, run from AWS Console CloudShell.
#   resume-env.sh --env staging|production              # DRY-RUN (default): prints the plan, changes nothing
#   resume-env.sh --env production --execute
#   resume-env.sh --env staging --status                # read-only
# Options: [--state MANIFEST] [--state-dir DIR] [--timeout 900] [--max-age-days 8] [--force-baseline]
#   [--break-lock RUN_ID] [--allow-maintenance-window] [--verify-url URL] [--skip-smoke]
# Source of truth: --state, else the OLDEST valid open manifest (local + s3://learnix-<env>-logs-<acct>/ops/pause/<env>/).
#   An open but invalid manifest (checksum, schema, account/env/region mismatch, expired) REFUSES the run (exit 2); repo
#   defaults are used only with --force-baseline and a paused environment. Recorded counts are restored exactly (0 stays 0).
# Order: lock -> start RDS (stable) -> check Valkey -> restore scaling targets -> ECS api -> worker -> ALB/app health
#   -> re-enable the recorded alarm actions ALWAYS (even if health fails) -> restart canary if it was RUNNING.
# Reports three things separately: infra_recovered, app_healthy, alarms_restored (JSON summary).
# Never: migrations, task definition/image changes, DNS, Terraform. Task IPs are new; ALB/CloudFront/NAT were never removed.
# Exit: 0 ok/dry-run, 2 refused, 3 non-critical failure, 4 critical infra failure, 5 application unhealthy,
#   6 alarm actions could not all be restored.
SCRIPT="resume-env"

# ---------------------------------------------------------------------------------------------------------------
# Common section (identical in pause-env.sh and resume-env.sh so each file runs on its own in CloudShell).
# Needs: bash >= 4, aws CLI v2 (S3 conditional writes), GNU date, sha256sum, curl (resume smoke test). No jq.
# ---------------------------------------------------------------------------------------------------------------
set -Eeuo pipefail

readonly ALLOWED_ACCOUNT="486940690416"   # staging AND production share this account: names decide the environment
readonly ALLOWED_REGION="eu-central-1"
readonly DR_REGION="eu-west-1"
readonly SCHEMA_VERSION=1
readonly LOCK_TTL=7200                     # seconds; renewed at every phase

ENV_NAME="" REGION="$ALLOWED_REGION" EXECUTE=0 STATE_FILE_ARG="" STATE_DIR="${HOME:-.}/learnix-pause"
SNAPSHOT_MODE=default MUTE_ALARMS=1 STATUS_ONLY=0 TIMEOUT=900 POLL=15
MAX_AGE_DAYS=8 FORCE_BASELINE=0 BREAK_LOCK="" ALLOW_MAINT=0 IGNORE_MC=0 IGNORE_QUEUES=0 CONFIRM_OWNER=0
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
STEPS=() CRITICAL_FAILED=0 NONCRIT_FAILED=0 EXTRA_JSON="" APP_UNHEALTHY=0 ALARMS_NOT_RESTORED=0
CLEANUP_HOOK="" MANIFEST="" MANIFEST_READY=0 LOCK_HELD=0 LOCK_ETAG="" CALLER_ARN=""

die() { echo "[$SCRIPT] ERROR: $*" >&2; exit "${2:-2}"; }
log() { echo "[$SCRIPT] $(date -u +%H:%M:%S) $*" >&2; }
now_epoch() { echo "${TEST_NOW_EPOCH:-$(date -u +%s)}"; }   # TEST_NOW_EPOCH: test hook for the time-based guards only
fmt_epoch() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }

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
  S3_PREFIX="ops/pause/$ENV_NAME"; LOCK_KEY="$S3_PREFIX/LOCK"
  mkdir -p "$STATE_DIR"
}

# Account check; run before every phase (credentials can change under a long session).
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

# ---- step bookkeeping + JSON summary ----------------------------------------------------------------------------
json_str() { local s=${1//\\/\\\\}; s=${s//\"/\\\"}; printf '"%s"' "$s"; }
record() {   # record <step> <ok|skipped|failed|dry-run> <detail> [critical]
  STEPS+=("{\"step\":$(json_str "$1"),\"result\":$(json_str "$2"),\"detail\":$(json_str "${3:-}")}")
  log "step=$1 result=$2 ${3:-}"
  if [ "$2" = failed ]; then
    if [ "${4:-}" = critical ]; then CRITICAL_FAILED=1; else NONCRIT_FAILED=1; fi
  fi
}
summary_json() {
  local joined="" s
  for s in ${STEPS[@]+"${STEPS[@]}"}; do joined+="${joined:+,}$s"; done
  printf '{"script":"%s","run_id":"%s","env":"%s","account":"%s","region":"%s","mode":"%s","caller":%s,"manifest":%s,"critical_failed":%s,"noncritical_failed":%s%s,"steps":[%s]}\n' \
    "$SCRIPT" "$RUN_ID" "$ENV_NAME" "$ALLOWED_ACCOUNT" "$REGION" "$([ "$EXECUTE" = 1 ] && echo execute || echo dry-run)" \
    "$(json_str "$CALLER_ARN")" "$(json_str "$MANIFEST")" "$CRITICAL_FAILED" "$NONCRIT_FAILED" "$EXTRA_JSON" "$joined"
}
# Exit codes: 0 ok, 3 non-critical failure, 4 critical failure, 5 application unhealthy, 6 alarm actions not restored.
finish() {
  local code=0
  [ "$NONCRIT_FAILED" = 1 ] && code=3
  [ "$APP_UNHEALTHY" = 1 ] && code=5
  [ "$ALARMS_NOT_RESTORED" = 1 ] && code=6
  [ "$CRITICAL_FAILED" = 1 ] && code=4
  summary_json | tee "$STATE_DIR/$ENV_NAME-$SCRIPT-$RUN_ID.json"
  exit "$code"
}

cleanup() {   # runs on every exit: script hook first (alarm safety), then lock release
  local rc=$?
  set +e; trap - ERR
  if [ -n "$CLEANUP_HOOK" ]; then "$CLEANUP_HOOK" "$rc"; fi
  release_lock
  return 0
}
on_error() { echo "[$SCRIPT] unexpected error at line $1" >&2; CRITICAL_FAILED=1; summary_json >&2; exit 4; }
trap cleanup EXIT
trap 'on_error $LINENO' ERR
# Ctrl-C / terminal close / kill: leave through exit so the EXIT trap (alarm safety, lock release) always runs.
trap 'echo "[$SCRIPT] interrupted (INT)" >&2; exit 130' INT
trap 'echo "[$SCRIPT] terminated (TERM)" >&2; exit 143' TERM
trap 'echo "[$SCRIPT] hangup (HUP)" >&2; exit 129' HUP

confirm() {   # confirm <exact text to type>; dry-run needs no confirmation
  [ "$EXECUTE" = 1 ] || return 0
  local typed
  case "$CALLER_ARN" in
    *:root) echo "!!! You are the AWS ROOT user. Root bypasses every guardrail and this account has no CloudTrail trail."
            echo "!!! Prefer the operator role (docs/PAUSE-RESUME-RUNBOOK.md)."
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
rds_field() {  # rds_field <Status|Restorable|Pending|Arn|Window>
  local q
  case "$1" in Status) q='DBInstances[0].DBInstanceStatus' ;; Restorable) q='DBInstances[0].LatestRestorableTime' ;;
    Pending) q='length(keys(DBInstances[0].PendingModifiedValues))' ;; Arn) q='DBInstances[0].DBInstanceArn' ;;
    Window) q='DBInstances[0].PreferredMaintenanceWindow' ;; esac
  none_to_empty "$(aws_ rds describe-db-instances --db-instance-identifier "$DB_ID" --query "$q")"
}
valkey_status() { none_to_empty "$(aws_ elasticache describe-replication-groups --replication-group-id "$VALKEY_ID" --query 'ReplicationGroups[0].Status')"; }
canary_state() { [ -n "$CANARY" ] || return 0; none_to_empty "$(aws_ synthetics get-canary --name "$CANARY" --query 'Canary.Status.State' 2>/dev/null || true)"; }
running_total() { local s t=0; for s in "${SERVICE_LIST[@]}"; do t=$((t + $(svc_field "$s" running))); done; echo "$t"; }

# Environment ownership proof: VPC by Name tag, cluster exists, RDS tagged for this environment.
verify_environment() {
  local vpcs cl tag arn s
  vpcs=$(aws_ ec2 describe-vpcs --filters "Name=tag:Name,Values=learnix-$ENV_NAME" --query 'length(Vpcs)')
  [ "$vpcs" = 1 ] || die "expected exactly one VPC named learnix-$ENV_NAME, found $vpcs"
  cl=$(none_to_empty "$(aws_ ecs describe-clusters --clusters "$CLUSTER" --query 'clusters[?status==`ACTIVE`].clusterName|[0]')")
  [ "$cl" = "$CLUSTER" ] || die "ECS cluster $CLUSTER not found/active"
  arn=$(rds_field Arn); [ -n "$arn" ] || die "RDS instance $DB_ID not found"
  DB_ARN=$arn
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

# ---- maintenance-window guard ----------------------------------------------------------------------------------
# Refuses to start within +-60 minutes of the RDS weekly maintenance window (a stop discards pending maintenance
# and the AWS Backup job fails inside the window). Window format: ddd:hh:mm-ddd:hh:mm (UTC).
maintenance_guard() {
  if [ "$ALLOW_MAINT" = 1 ]; then log "maintenance-window guard skipped (--allow-maintenance-window)"; return 0; fi
  local w sd sh sm ed eh em now off day dow start dur end
  declare -A DOW=([sun]=0 [mon]=1 [tue]=2 [wed]=3 [thu]=4 [fri]=5 [sat]=6)
  w=$(rds_field Window)
  [ -n "$w" ] || { log "WARNING: no maintenance window found for $DB_ID; guard skipped"; return 0; }
  IFS=':-' read -r sd sh sm ed eh em <<< "$w"
  [[ -n "${DOW[$sd]:-}" && -n "${DOW[$ed]:-}" ]] || die "cannot parse maintenance window '$w'"
  now=$(now_epoch)
  for off in -8 -7 -6 -5 -4 -3 -2 -1 0 1 2 3 4 5 6 7 8; do
    day=$(date -u -d "@$((now + off*86400))" +%Y-%m-%d)
    dow=$(date -u -d "$day" +%w)
    [ "$dow" = "${DOW[$sd]}" ] || continue
    start=$(date -u -d "$day $sh:$sm" +%s)
    dur=$(( ((DOW[$ed] - DOW[$sd] + 7) % 7) * 86400 + (10#$eh*60 + 10#$em - 10#$sh*60 - 10#$sm) * 60 ))
    [ "$dur" -gt 0 ] || dur=$((dur + 604800))
    end=$((start + dur))
    if [ "$now" -ge $((start - 3600)) ] && [ "$now" -le $((end + 3600)) ]; then
      die "RDS maintenance window $w UTC ($(fmt_epoch "$start") - $(fmt_epoch "$end")) is within 60 min of now. Retry later, or --allow-maintenance-window."
    fi
  done
  log "maintenance window $w UTC is not within 60 minutes of now"
}

# ---- per-environment lock (S3 conditional write) ---------------------------------------------------------------
lock_body() {  # lock_body <expires-epoch>
  printf '{"run_id":"%s","script":"%s","owner":"%s","host":"%s","started":%s,"expires":%s}\n' \
    "$RUN_ID" "$SCRIPT" "$CALLER_ARN" "$(hostname 2>/dev/null || echo unknown)" "$(now_epoch)" "$1"
}
lock_current() { aws --region "$REGION" s3 cp "s3://$LOGS_BUCKET/$LOCK_KEY" - 2>/dev/null | tr -d '\r' || true; }
lock_field() { printf '%s' "$1" | sed -n "s/.*\"$2\":\"\{0,1\}\([^\",}]*\).*/\1/p"; }
probe_idle() {   # nothing mid-transition: one deployment per service, RDS available or stopped
  local s
  for s in "${SERVICE_LIST[@]}"; do [ "$(svc_field "$s" deployments)" = 1 ] || return 1; done
  case "$(rds_field Status)" in available|stopped) return 0 ;; *) return 1 ;; esac
}
acquire_lock() {
  local f="$STATE_DIR/.lock-$RUN_ID.json" out cur expiry typed
  if [ "$EXECUTE" != 1 ]; then
    cur=$(lock_current)
    [ -z "$cur" ] || log "WARNING: another run holds the $ENV_NAME lock: $cur"
    return 0
  fi
  lock_body $(( $(now_epoch) + LOCK_TTL )) > "$f"
  if out=$(aws --region "$REGION" s3api put-object --bucket "$LOGS_BUCKET" --key "$LOCK_KEY" --body "$f" \
            --if-none-match '*' --query ETag --output text 2>&1); then
    LOCK_ETAG=$(echo "$out" | tr -d '\r"'); LOCK_HELD=1; log "lock acquired ($LOCK_KEY)"; return 0
  fi
  case "$out" in *PreconditionFailed*|*ConditionalRequestConflict*|*412*) ;; *) die "lock acquire failed: $out" 4 ;; esac
  cur=$(lock_current)
  [ -n "$BREAK_LOCK" ] || die "another run holds the $ENV_NAME lock: $cur  (wait for it, or after expiry use --break-lock RUN_ID)" 2
  [ "$(lock_field "$cur" run_id)" = "$BREAK_LOCK" ] || die "--break-lock $BREAK_LOCK does not match the current holder: $cur" 2
  expiry=$(lock_field "$cur" expires)
  [ "$(now_epoch)" -gt "${expiry:-0}" ] || die "lock is not expired yet (expires $(fmt_epoch "${expiry:-0}")): refusing to break it" 2
  probe_idle || die "environment is mid-transition (deployment or RDS state changing): refusing to break the lock" 2
  read -r -p "Type 'break lock $BREAK_LOCK' to continue: " typed; [ "$typed" = "break lock $BREAK_LOCK" ] || die "aborted"
  aws --region "$REGION" s3api delete-object --bucket "$LOGS_BUCKET" --key "$LOCK_KEY" >/dev/null
  out=$(aws --region "$REGION" s3api put-object --bucket "$LOGS_BUCKET" --key "$LOCK_KEY" --body "$f" --if-none-match '*' --query ETag --output text) \
    || die "could not take the lock after breaking it" 4
  LOCK_ETAG=$(echo "$out" | tr -d '\r"'); LOCK_HELD=1; log "stale lock broken; lock acquired"
}
renew_lock() {
  [ "$LOCK_HELD" = 1 ] || return 0
  local f="$STATE_DIR/.lock-$RUN_ID.json" out
  lock_body $(( $(now_epoch) + LOCK_TTL )) > "$f"
  out=$(aws --region "$REGION" s3api put-object --bucket "$LOGS_BUCKET" --key "$LOCK_KEY" --body "$f" \
         --if-match "$LOCK_ETAG" --query ETag --output text 2>&1) || { LOCK_HELD=0; die "lost the $ENV_NAME lock (another run took it?): $out" 4; }
  LOCK_ETAG=$(echo "$out" | tr -d '\r"')
}
release_lock() {
  [ "$LOCK_HELD" = 1 ] || return 0
  local cur; cur=$(lock_current)
  if [ "$(lock_field "$cur" run_id)" = "$RUN_ID" ]; then
    aws --region "$REGION" s3api delete-object --bucket "$LOGS_BUCKET" --key "$LOCK_KEY" >/dev/null 2>&1 && log "lock released" || log "WARNING: could not delete the lock object"
  fi
  LOCK_HELD=0
}

# ---- recovery manifest ------------------------------------------------------------------------------------------
# One file per pause, "<env>-<run id>.manifest":
#   immutable header (SCHEMA, ACCOUNT, ENV, REGION, CLUSTER, DB_ID, RUN_ID, CREATED_EPOCH, CREATED_BY, SVC.., ALARM_PRE..,
#   CANARY, RDS_PRIOR_STATUS) closed by "HEADER_SHA256 <sum of every line above>", then an append-only journal
#   (STATUS / INTENT / DONE / NOTE / RDS_* lines). It is uploaded and verified before the first mutation and
#   re-uploaded after every phase. STATUS: IN_PROGRESS PAUSED FAILED_PARTIAL RESUMING RESUMED.
declare -A M_DESIRED M_TARGET M_MIN M_MAX M_TD M_DONE
M_ALARM_TRUE=() M_STATUS="" M_CANARY="" M_RDS_PRIOR="" M_SNAPSHOT="" M_STOPPED_AT="" M_DEADLINE="" M_CREATED=0 M_RUN=""
VAL_ERR="" SEL_FILE="" SEL_SOFT=0 DB_ARN=""

m_append() { [ "$EXECUTE" = 1 ] && [ -n "$MANIFEST" ] && printf '%s\n' "$*" >> "$MANIFEST"; return 0; }
m_intent() { m_append "INTENT $1 $(now_epoch)"; }
m_done() { m_append "DONE $1 $(now_epoch)"; }
manifest_size() { wc -c < "$MANIFEST" | tr -d ' '; }
sync_manifest() {   # upload + verify; returns non-zero on failure
  [ "$EXECUTE" = 1 ] && [ -n "$MANIFEST" ] || return 0
  local key="$S3_PREFIX/$(basename "$MANIFEST")" size
  aws --region "$REGION" s3 cp "$MANIFEST" "s3://$LOGS_BUCKET/$key" --only-show-errors || return 1
  size=$(aws_ s3api head-object --bucket "$LOGS_BUCKET" --key "$key" --query ContentLength) || return 1
  [ "$size" = "$(manifest_size)" ] || return 1
}
mfield() { sed -n "s/^$2 //p" "$1" | head -1; }

validate_manifest() {   # validate_manifest <file>; sets VAL_ERR; returns 1 when unusable
  local f=$1 want calc s n line status age bad
  VAL_ERR=""
  [ -r "$f" ] || { VAL_ERR="unreadable"; return 1; }
  [ "$(head -1 "$f" | tr -d '\r')" = "SCHEMA $SCHEMA_VERSION" ] || { VAL_ERR="schema is not $SCHEMA_VERSION"; return 1; }
  case "$(basename "$f")" in "$ENV_NAME"-*.manifest) ;; *) VAL_ERR="file name does not start with '$ENV_NAME-'"; return 1 ;; esac
  want=$(sed -n 's/^HEADER_SHA256 //p' "$f" | head -1)
  [ -n "$want" ] || { VAL_ERR="no HEADER_SHA256 line (truncated?)"; return 1; }
  calc=$(sed '/^HEADER_SHA256 /,$d' "$f" | sha256sum | cut -d' ' -f1)
  [ "$calc" = "$want" ] || { VAL_ERR="header checksum mismatch (edited or corrupted)"; return 1; }
  [ "$(mfield "$f" ACCOUNT)" = "$ALLOWED_ACCOUNT" ] || { VAL_ERR="ACCOUNT is '$(mfield "$f" ACCOUNT)', expected $ALLOWED_ACCOUNT"; return 1; }
  [ "$(mfield "$f" ENV)" = "$ENV_NAME" ] || { VAL_ERR="ENV is '$(mfield "$f" ENV)', expected $ENV_NAME"; return 1; }
  [ "$(mfield "$f" REGION)" = "$REGION" ] || { VAL_ERR="REGION is '$(mfield "$f" REGION)', expected $REGION"; return 1; }
  [ "$(mfield "$f" CLUSTER)" = "$CLUSTER" ] || { VAL_ERR="CLUSTER mismatch"; return 1; }
  [ "$(mfield "$f" DB_ID)" = "$DB_ID" ] || { VAL_ERR="DB_ID mismatch"; return 1; }
  [[ "$(mfield "$f" RUN_ID)" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || { VAL_ERR="bad RUN_ID"; return 1; }
  [ "$(mfield "$f" RUN_ID)" = "$(basename "$f" .manifest | sed "s/^$ENV_NAME-//")" ] || { VAL_ERR="RUN_ID does not match the file name"; return 1; }
  n=$(mfield "$f" CREATED_EPOCH)
  [[ "$n" =~ ^[0-9]+$ ]] || { VAL_ERR="bad CREATED_EPOCH"; return 1; }
  [ "$n" -le $(( $(now_epoch) + 300 )) ] || { VAL_ERR="CREATED_EPOCH is in the future"; return 1; }
  for s in "${SERVICE_LIST[@]}"; do
    [ "$(grep -c "^SVC $s " "$f")" = 1 ] || { VAL_ERR="SVC line for '$s' missing or duplicated"; return 1; }
  done
  while read -r line; do
    set -- $line
    [ "$1" = SVC ] || continue
    [[ " ${SERVICE_LIST[*]} " == *" $2 "* ]] || { VAL_ERR="unexpected service '$2'"; return 1; }
    [[ "${3:-}" =~ ^[0-9]+$ && "${4:-}" =~ ^[01]$ && "${5:-}" =~ ^([0-9]+|-)$ && "${6:-}" =~ ^([0-9]+|-)$ && -n "${7:-}" ]] \
      || { VAL_ERR="malformed SVC line: $line"; return 1; }
    if [ "$4" = 1 ] && { [ "$5" = - ] || [ "$6" = - ] || [ "$5" -gt "$6" ]; }; then VAL_ERR="bad scaling min/max in: $line"; return 1; fi
  done < <(sed '/^HEADER_SHA256 /,$d' "$f")
  bad=$(grep -E '^ALARM_PRE ' "$f" | grep -vcE "^ALARM_PRE ${ALARM_PREFIX}[^ ]+ (true|false)$" || true)
  [ "${bad:-0}" = 0 ] || { VAL_ERR="malformed or foreign ALARM_PRE line"; return 1; }
  [ "$(sed '/^HEADER_SHA256 /,$d' "$f" | grep -c '^CANARY ')" = 1 ] || { VAL_ERR="CANARY line missing"; return 1; }
  # journal: only known line shapes
  bad=$(sed -n '/^HEADER_SHA256 /,$p' "$f" | tail -n +2 | grep -vcE '^(INTENT [a-z0-9-]+ [0-9]+|DONE [a-z0-9-]+ [0-9]+|STATUS (IN_PROGRESS|PAUSED|FAILED_PARTIAL|RESUMING|RESUMED)|NOTE .*|RDS_SNAPSHOT [a-z0-9-]+|RDS_STOPPED_AT [0-9TZ:-]+|RDS_RESTART_DEADLINE [0-9TZ:-]+|)$' || true)
  [ "${bad:-0}" = 0 ] || { VAL_ERR="unrecognised journal line"; return 1; }
  status=$(grep '^STATUS ' "$f" | tail -1 | cut -d' ' -f2)
  [ -n "$status" ] || { VAL_ERR="no STATUS in journal"; return 1; }
  if [ "$status" != RESUMED ]; then
    age=$(( ($(now_epoch) - n) / 86400 ))
    [ "$age" -le "$MAX_AGE_DAYS" ] || { VAL_ERR="expired: created $age days ago (limit $MAX_AGE_DAYS; --max-age-days to override)"; return 1; }
  fi
  return 0
}

load_manifest() {   # load_manifest <file> (already validated)
  local kind a b c d e g
  M_DESIRED=(); M_TARGET=(); M_MIN=(); M_MAX=(); M_TD=(); M_DONE=()
  M_ALARM_TRUE=(); M_STATUS=""; M_CANARY=""; M_RDS_PRIOR=""; M_SNAPSHOT=""; M_STOPPED_AT=""; M_DEADLINE=""; M_CREATED=0; M_RUN=""
  while read -r kind a b c d e g; do
    case "$kind" in
      RUN_ID) M_RUN=$a ;; CREATED_EPOCH) M_CREATED=$a ;;
      SVC) M_DESIRED[$a]=$b; M_TARGET[$a]=$c; M_MIN[$a]=$d; M_MAX[$a]=$e; M_TD[$a]=$g ;;
      ALARM_PRE) if [ "$b" = true ]; then M_ALARM_TRUE+=("$a"); fi ;;
      CANARY) M_CANARY=$a ;; RDS_PRIOR_STATUS) M_RDS_PRIOR=$a ;;
      STATUS) M_STATUS=$a ;; RDS_SNAPSHOT) M_SNAPSHOT=$a ;; RDS_STOPPED_AT) M_STOPPED_AT=$a ;; RDS_RESTART_DEADLINE) M_DEADLINE=$a ;;
      DONE) M_DONE[$a]=1 ;;
    esac
  done < "$1"
}

sync_from_s3() {   # fetch manifests this environment's prefix holds; keep the longer journal of equal headers
  local keys k b tmp
  keys=$(none_to_empty "$(aws --region "$REGION" s3api list-objects-v2 --bucket "$LOGS_BUCKET" --prefix "$S3_PREFIX/" \
          --query 'Contents[?ends_with(Key,`.manifest`)].Key' --output text 2>/dev/null | tr -d '\r' || true)")
  for k in $keys; do
    b=${k##*/}
    case "$b" in "$ENV_NAME"-*.manifest) ;; *) continue ;; esac
    tmp="$STATE_DIR/.dl-$b"
    aws --region "$REGION" s3 cp "s3://$LOGS_BUCKET/$k" "$tmp" --only-show-errors 2>/dev/null || { log "WARNING: could not download $k"; continue; }
    if [ ! -f "$STATE_DIR/$b" ]; then mv "$tmp" "$STATE_DIR/$b"
    elif [ "$(wc -l < "$tmp")" -gt "$(wc -l < "$STATE_DIR/$b")" ] && \
         [ "$(sed '/^HEADER_SHA256 /,$d' "$tmp" | sha256sum)" = "$(sed '/^HEADER_SHA256 /,$d' "$STATE_DIR/$b" | sha256sum)" ]; then
      mv "$tmp" "$STATE_DIR/$b"
    else rm -f "$tmp"; fi
  done
}

# Deterministic selection: --state wins (and must validate); else the OLDEST valid manifest that is not RESUMED
# (the first pause holds the true pre-pause values). Any invalid open manifest blocks the run: never a silent baseline.
select_manifest() {
  SEL_FILE=""
  local f st created best_created=0 invalid=() openvalid=()
  if [ -n "$STATE_FILE_ARG" ]; then
    [ -f "$STATE_FILE_ARG" ] || die "--state file not found: $STATE_FILE_ARG"
    validate_manifest "$STATE_FILE_ARG" || die "--state manifest rejected: $VAL_ERR ($STATE_FILE_ARG)"
    SEL_FILE="$STATE_FILE_ARG"; return 0
  fi
  sync_from_s3
  for f in "$STATE_DIR/$ENV_NAME-"*.manifest; do
    [ -f "$f" ] || continue
    st=$(grep '^STATUS ' "$f" | tail -1 | cut -d' ' -f2 || true)
    if validate_manifest "$f"; then
      [ "$st" = RESUMED ] && continue
      created=$(mfield "$f" CREATED_EPOCH)
      if [ -z "$SEL_FILE" ] || [ "$created" -lt "$best_created" ]; then SEL_FILE=$f; best_created=$created; fi
      openvalid+=("$f")
    else
      [ "$st" = RESUMED ] || invalid+=("$f: $VAL_ERR")
    fi
  done
  if [ "${#invalid[@]}" -gt 0 ]; then
    printf '[%s] invalid open manifest: %s\n' "$SCRIPT" "${invalid[@]}" >&2
    if [ "$SEL_SOFT" = 1 ]; then SEL_FILE=""; return 0; fi
    if [ "$FORCE_BASELINE" != 1 ]; then die "refusing to continue with an unusable recovery manifest (fix, remove after review, or use --force-baseline)" 2; fi
  fi
  [ "${#openvalid[@]}" -le 1 ] || log "WARNING: ${#openvalid[@]} open manifests; using the oldest ($SEL_FILE)"
  return 0
}

write_manifest_header() {   # write_manifest_header  (uses SERVICE_LIST, PRIOR_*, ALARM_PRE_LINES, CANARY_STATE, RDS_STATUS)
  local tmp="$MANIFEST.tmp" s sum
  {
    echo "SCHEMA $SCHEMA_VERSION"; echo "ACCOUNT $ALLOWED_ACCOUNT"; echo "ENV $ENV_NAME"; echo "REGION $REGION"
    echo "CLUSTER $CLUSTER"; echo "DB_ID $DB_ID"; echo "RUN_ID $RUN_ID"; echo "CREATED_EPOCH $(now_epoch)"
    echo "CREATED_BY $CALLER_ARN"
    for s in "${SERVICE_LIST[@]}"; do echo "SVC $s ${PRIOR_DESIRED[$s]} ${HAS_TARGET[$s]} ${PRIOR_MIN[$s]:--} ${PRIOR_MAX[$s]:--} ${PRIOR_TD[$s]}"; done
    printf '%s' "$ALARM_PRE_LINES"
    echo "CANARY ${CANARY_STATE:--}"; echo "RDS_PRIOR_STATUS $RDS_STATUS"
  } > "$tmp"
  sum=$(sha256sum "$tmp" | cut -d' ' -f1)
  echo "HEADER_SHA256 $sum" >> "$tmp"
  mv "$tmp" "$MANIFEST"
}

# ---- alarm actions -----------------------------------------------------------------------------------------------
alarm_pre_lines() {   # "ALARM_PRE <name> <true|false>" for every alarm with this environment's prefix
  aws_ cloudwatch describe-alarms --alarm-name-prefix "$ALARM_PREFIX" --query 'MetricAlarms[].[AlarmName,ActionsEnabled]' --output text \
    | awk 'NF==2 {print "ALARM_PRE " $1 " " tolower($2)}'
}
disabled_alarms() { aws_ cloudwatch describe-alarms --alarm-name-prefix "$ALARM_PREFIX" --query 'MetricAlarms[?ActionsEnabled==`false`].AlarmName' --output text | tr '\t' '\n' | sed '/^$/d'; }
enabled_alarms() { aws_ cloudwatch describe-alarms --alarm-name-prefix "$ALARM_PREFIX" --query 'MetricAlarms[?ActionsEnabled==`true`].AlarmName' --output text | tr '\t' '\n' | sed '/^$/d'; }

ALARM_FAIL=()
alarm_batches() {   # alarm_batches <enable|disable> names...; falls back to single calls on a batch failure
  local action=$1 n name; shift
  while [ $# -gt 0 ]; do
    n=$(( $# < 50 ? $# : 50 ))
    if ! run aws --region "$REGION" cloudwatch "${action}-alarm-actions" --alarm-names "${@:1:$n}"; then
      for name in "${@:1:$n}"; do
        run aws --region "$REGION" cloudwatch "${action}-alarm-actions" --alarm-names "$name" || ALARM_FAIL+=("$name")
      done
    fi
    shift "$n"
  done
}
# Re-enable every alarm the manifest recorded as enabled. Idempotent; reports each failure and re-checks afterwards.
ALARMS_RESTORED=0
restore_alarms() {
  ALARM_FAIL=(); ALARMS_RESTORED=0
  if [ "${#M_ALARM_TRUE[@]}" = 0 ]; then record restore-alarms skipped "manifest recorded none"; ALARMS_RESTORED=1; return 0; fi
  local dis want=() name left=()
  dis=" $(disabled_alarms | tr '\n' ' ') "
  for name in "${M_ALARM_TRUE[@]}"; do case "$dis" in *" $name "*) want+=("$name") ;; esac; done
  if [ "${#want[@]}" = 0 ]; then record restore-alarms skipped "already enabled"; ALARMS_RESTORED=1; return 0; fi
  alarm_batches enable "${want[@]}"
  if [ "$EXECUTE" = 1 ]; then
    dis=" $(disabled_alarms | tr '\n' ' ') "
    for name in "${M_ALARM_TRUE[@]}"; do case "$dis" in *" $name "*) left+=("$name") ;; esac; done
    ALARM_FAIL=(${left[@]+"${left[@]}"})
  fi
  if [ "${#ALARM_FAIL[@]}" -gt 0 ]; then
    record restore-alarms failed "STILL DISABLED: ${ALARM_FAIL[*]}"; ALARMS_NOT_RESTORED=1
  else
    record restore-alarms "$([ "$EXECUTE" = 1 ] && echo ok || echo dry-run)" "${#want[@]} alarm(s)"; ALARMS_RESTORED=1
  fi
}

# ---- status (read-only) ------------------------------------------------------------------------------------------
status_report() {
  local s last dl rem now st
  verify_environment
  for s in "${SERVICE_LIST[@]}"; do
    log "ecs $CLUSTER/$s desired=$(svc_field "$s" desired) running=$(svc_field "$s" running) scaling_target=[$(scalable_target "$s")]"
  done
  st=$(rds_field Status)
  log "rds $DB_ID status=$st window=$(rds_field Window)"
  log "valkey $VALKEY_ID status=$(valkey_status)"
  [ -z "$CANARY" ] || log "canary $CANARY state=$(canary_state)"
  log "alarms: $(enabled_alarms | wc -l) enabled / $(disabled_alarms | wc -l) disabled (prefix $ALARM_PREFIX)"
  last=$(lock_current); log "lock: ${last:-none}"
  SEL_SOFT=1; select_manifest
  if [ -n "$SEL_FILE" ]; then
    load_manifest "$SEL_FILE"
    log "manifest: $SEL_FILE status=$M_STATUS created=$(fmt_epoch "$M_CREATED") rds_stopped_at=${M_STOPPED_AT:-n/a} restart_deadline=${M_DEADLINE:-n/a}"
    if [ -n "$M_DEADLINE" ]; then
      dl=$(date -u -d "$M_DEADLINE" +%s); now=$(now_epoch); rem=$(( (dl - now) / 3600 ))
      if [ "$st" = stopped ]; then
        log "RDS auto-restarts in about ${rem}h ($M_DEADLINE)"
        [ "$rem" -ge 48 ] || log "WARNING: less than 48h until RDS restarts by itself - run pause-env.sh again to re-stop it, or resume"
      fi
    fi
    if [ "$M_STATUS" = PAUSED ] && [ "$st" = available ] && [ "$(running_total)" = 0 ]; then
      log "WARNING: manifest says PAUSED but RDS is available with no tasks: RDS probably restarted by itself (7-day limit) and is billing compute. Re-run pause-env.sh --execute to stop it again."
    fi
  else log "manifest: none open"; fi
}
# ---- end common section ---------------------------------------------------------------------------------------

# ---------------------------------------------------------------------------------------------------------------
VERIFY_URL="" SKIP_SMOKE=0 BASELINE=0 RESUME_STARTED=0 RDS_STABLE=150
declare -A WANT_DESIRED WANT_RESTORE_TARGET WANT_MIN WANT_MAX

while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_NAME="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --execute) EXECUTE=1; shift ;;
    --state) STATE_FILE_ARG="$2"; shift 2 ;;
    --state-dir) STATE_DIR="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --max-age-days) MAX_AGE_DAYS="$2"; shift 2 ;;
    --force-baseline) FORCE_BASELINE=1; shift ;;
    --break-lock) BREAK_LOCK="$2"; shift 2 ;;
    --allow-maintenance-window) ALLOW_MAINT=1; shift ;;
    --verify-url) VERIFY_URL="${2%/}"; shift 2 ;;
    --skip-smoke) SKIP_SMOKE=1; shift ;;
    --status) STATUS_ONLY=1; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
setup_env
verify_identity
log "identity: $CALLER_ARN"
[ -n "$VERIFY_URL" ] || { [ "$ENV_NAME" = production ] && VERIFY_URL="https://api.learnix.school" || true; }
if [ "$STATUS_ONLY" = 1 ]; then status_report; exit 0; fi

# ---- Phase 1: environment proof, guards, lock, manifest ----------------------------------------------------------
verify_environment
maintenance_guard
acquire_lock
select_manifest
RDS_STATUS=$(rds_field Status)
if [ -n "$SEL_FILE" ]; then
  MANIFEST="$SEL_FILE"; load_manifest "$MANIFEST"
  for s in "${SERVICE_LIST[@]}"; do
    WANT_DESIRED[$s]=${M_DESIRED[$s]}; WANT_RESTORE_TARGET[$s]=${M_TARGET[$s]}; WANT_MIN[$s]=${M_MIN[$s]}; WANT_MAX[$s]=${M_MAX[$s]}
  done
  STATE_SOURCE="manifest $MANIFEST (status $M_STATUS, created $(fmt_epoch "$M_CREATED"))"
else
  paused=0
  if [ "$RDS_STATUS" != available ]; then paused=1; fi
  for s in "${SERVICE_LIST[@]}"; do if [ "$(svc_field "$s" desired)" = 0 ]; then paused=1; fi; done
  if [ "$paused" = 0 ]; then
    record resume skipped "environment is not paused and no open manifest exists: nothing to resume"; finish
  fi
  [ "$FORCE_BASELINE" = 1 ] || die "environment looks paused but no valid open manifest exists. Fix/restore the manifest (--state FILE), or --force-baseline to use repo defaults (api 1, worker 1)." 2
  BASELINE=1
  declare -A BASE_MAX=([api]=$([ "$ENV_NAME" = production ] && echo 6 || echo 1) [worker]=4)
  for s in "${SERVICE_LIST[@]}"; do WANT_DESIRED[$s]=1; WANT_RESTORE_TARGET[$s]=1; WANT_MIN[$s]=1; WANT_MAX[$s]=${BASE_MAX[$s]}; done
  STATE_SOURCE="REPO BASELINE (--force-baseline): alarms and canary are NOT restored automatically"
fi

# ---- Plan ----------------------------------------------------------------------------------------------------
echo
echo "==================== RESUME PLAN  env=$ENV_NAME  account=$ALLOWED_ACCOUNT  region=$REGION ===================="
echo "state: $STATE_SOURCE"
echo "1. rds $DB_ID: $RDS_STATUS -> available (stable)"
echo "2. valkey $VALKEY_ID: $(valkey_status) (must be available)"
for s in "${SERVICE_LIST[@]}"; do
  echo "3. ecs $CLUSTER/$s: desired $(svc_field "$s" desired) -> ${WANT_DESIRED[$s]}$([ -n "$(scalable_target "$s")" ] && [ "${WANT_RESTORE_TARGET[$s]}" = 1 ] && echo "; scaling target -> ${WANT_MIN[$s]}/${WANT_MAX[$s]}")"
done
echo "4. health: ALB target health$([ -n "$VERIFY_URL" ] && [ "$SKIP_SMOKE" = 0 ] && echo ", GET $VERIFY_URL/api/v1/health and /health/readiness")"
echo "5. alarms: re-enable ${#M_ALARM_TRUE[@]} recorded alarm action sets (ALWAYS, even if health checks fail)"
[ -z "$CANARY" ] || echo "6. canary $CANARY: $([ "$M_CANARY" = RUNNING ] && echo start || echo "leave (was ${M_CANARY:-unknown})")"
echo "==========================================================================================================="
if [ "$EXECUTE" != 1 ]; then log "DRY-RUN: nothing was changed (no lock, manifest untouched). Add --execute to apply."; fi
confirm "resume learnix-$ENV_NAME in $ALLOWED_ACCOUNT"
verify_identity

resume_cleanup() {
  local rc=$1
  [ "$EXECUTE" = 1 ] && [ "$RESUME_STARTED" = 1 ] && [ "$ALARMS_RESTORED" != 1 ] || return 0
  echo "[$SCRIPT] resume ended early (exit $rc): restoring muted alarm actions" >&2
  restore_alarms
  [ "$ALARMS_RESTORED" = 1 ] || echo "[$SCRIPT] !!! ALARM ACTIONS STILL DISABLED: ${ALARM_FAIL[*]:-unknown}" >&2
}
CLEANUP_HOOK=resume_cleanup
if [ "$EXECUTE" = 1 ]; then
  RESUME_STARTED=1
  if [ "$BASELINE" != 1 ]; then m_append "NOTE resume started by $RUN_ID"; m_append "STATUS RESUMING"; sync_manifest || record manifest-sync failed "upload failed (local copy kept)"; fi
fi
phase_checkpoint() { renew_lock; sync_manifest || record manifest-sync failed "upload of $MANIFEST failed (local copy kept)"; }

wait_rds_stable() {   # available, and CONTINUOUSLY available for RDS_STABLE seconds (RDS bounces ~2 min after a start)
  local deadline=$((SECONDS+TIMEOUT*2)) since=0
  while [ $SECONDS -lt $deadline ]; do
    if [ "$(rds_field Status)" = available ]; then
      if [ "$since" = 0 ]; then since=$SECONDS; fi
      if [ $((SECONDS - since)) -ge "$RDS_STABLE" ]; then return 0; fi
    else
      since=0
    fi
    sleep "$POLL"
  done
  return 1
}

# ---- Phase 2: actions --------------------------------------------------------------------------------------------
# 1. RDS
m_intent start-rds
if [ "$RDS_STATUS" = stopping ] && [ "$EXECUTE" = 1 ]; then wait_rds stopped || true; RDS_STATUS=$(rds_field Status); fi
case "$RDS_STATUS" in
  available) record start-rds skipped "already available" ;;
  stopped)
    if run aws --region "$REGION" rds start-db-instance --db-instance-identifier "$DB_ID"; then
      if [ "$EXECUTE" = 1 ]; then
        if wait_rds_stable; then record start-rds ok "available (stable)"; else record start-rds failed "not stably available in time" critical; fi
      else record start-rds dry-run "start"; fi
    else record start-rds failed "start-db-instance" critical; fi ;;
  stopping|starting|backing-up|configuring-enhanced-monitoring|rebooting|modifying)
    if [ "$EXECUTE" = 1 ]; then
      if wait_rds_stable; then record start-rds ok "became available (was $RDS_STATUS)"; else record start-rds failed "timeout waiting from $RDS_STATUS" critical; fi
    else record start-rds dry-run "wait from $RDS_STATUS"; fi ;;
  *) record start-rds failed "unexpected status $RDS_STATUS" critical ;;
esac
m_done start-rds

# 2. Valkey (never stopped, just verified)
if [ "$(valkey_status)" = available ]; then record check-valkey ok "available"; else record check-valkey failed "status=$(valkey_status)" critical; fi

# 3. ECS, only when the database is up. Exactly the recorded counts; 0 stays 0.
for s in "${SERVICE_LIST[@]}"; do
  if [ "$CRITICAL_FAILED" = 1 ]; then record "resume-$s" skipped "earlier critical failure"; continue; fi
  verify_identity
  if [ "${WANT_DESIRED[$s]}" = 0 ]; then record "resume-$s" skipped "was 0 before the pause"; continue; fi
  m_intent "resume-$s"
  if [ "${WANT_RESTORE_TARGET[$s]}" = 1 ] && [ -n "$(scalable_target "$s")" ]; then
    if run aws --region "$REGION" application-autoscaling register-scalable-target --service-namespace ecs \
         --scalable-dimension ecs:service:DesiredCount --resource-id "service/$CLUSTER/$s" \
         --min-capacity "${WANT_MIN[$s]}" --max-capacity "${WANT_MAX[$s]}"
    then record "restore-scaling-$s" "$([ "$EXECUTE" = 1 ] && echo ok || echo dry-run)" "${WANT_MIN[$s]}/${WANT_MAX[$s]}"
    else record "restore-scaling-$s" failed "register-scalable-target" critical; continue; fi
  elif [ "${WANT_RESTORE_TARGET[$s]}" = 1 ]; then log "note: $s had a scaling target when paused but none exists now (Terraform-owned); not recreating it"
  fi
  if run aws --region "$REGION" ecs update-service --cluster "$CLUSTER" --service "$s" --desired-count "${WANT_DESIRED[$s]}"; then
    if [ "$EXECUTE" = 1 ]; then
      if wait_service_idle "$s" "${WANT_DESIRED[$s]}"; then record "resume-$s" ok "${WANT_DESIRED[$s]} task(s) steady"; m_done "resume-$s"
      else record "resume-$s" failed "not steady at ${WANT_DESIRED[$s]} within ${TIMEOUT}s" critical; fi
    else record "resume-$s" dry-run "-> ${WANT_DESIRED[$s]}"; fi
  else record "resume-$s" failed "update-service" critical; fi
done
phase_checkpoint

# 4. Application health: reported separately from infrastructure recovery.
HEALTH_CHECKED=0
if [ "$EXECUTE" = 1 ] && [ "$CRITICAL_FAILED" = 0 ]; then
  HEALTH_CHECKED=1
  tg=$(none_to_empty "$(aws_ ecs describe-services --cluster "$CLUSTER" --services api --query 'services[0].loadBalancers[0].targetGroupArn')")
  if [ -n "$tg" ] && [ "${WANT_DESIRED[api]}" != 0 ]; then
    deadline=$((SECONDS+300)); healthy=0
    while [ $SECONDS -lt $deadline ]; do
      healthy=$(aws_ elbv2 describe-target-health --target-group-arn "$tg" --query 'length(TargetHealthDescriptions[?TargetHealth.State==`healthy`])')
      if [ "$healthy" -ge 1 ]; then break; fi; sleep "$POLL"
    done
    if [ "$healthy" -ge 1 ]; then record alb-target-health ok "$healthy healthy"; else record alb-target-health failed "no healthy target"; APP_UNHEALTHY=1; fi
  fi
  if [ -n "$VERIFY_URL" ] && [ "$SKIP_SMOKE" = 0 ] && [ "${WANT_DESIRED[api]}" != 0 ]; then
    for p in /api/v1/health /api/v1/health/readiness; do
      code=000
      for _ in 1 2 3 4 5 6; do
        code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$VERIFY_URL$p" || true)
        if [ "$code" = 200 ]; then break; fi; sleep 10
      done
      if [ "$code" = 200 ]; then record "smoke$p" ok "200"; else record "smoke$p" failed "http $code"; APP_UNHEALTHY=1; fi
    done
  fi
fi

# 5. Alarm actions: ALWAYS restored (health result does not matter), each failure reported.
restore_alarms
if [ "$BASELINE" = 1 ] && [ "$EXECUTE" = 1 ]; then
  d=$(disabled_alarms | tr '\n' ' '); [ -z "$d" ] || log "BASELINE mode: alarms with actions disabled (re-enable if you muted them): $d"
fi

# 6. Canary
if [ "${M_CANARY:-}" = RUNNING ] && [ "$CRITICAL_FAILED" = 0 ]; then
  m_intent start-canary
  if run aws --region "$REGION" synthetics start-canary --name "$CANARY"; then record start-canary "$([ "$EXECUTE" = 1 ] && echo ok || echo dry-run)" "$CANARY"; else record start-canary failed "$CANARY"; fi
  m_done start-canary
else record start-canary skipped "was ${M_CANARY:-n/a}"; fi

# ---- Phase 3: outcome --------------------------------------------------------------------------------------------
INFRA_OK=$([ "$CRITICAL_FAILED" = 0 ] && echo true || echo false)
APP_OK=$([ "$HEALTH_CHECKED" = 1 ] && [ "$APP_UNHEALTHY" = 0 ] && echo true || echo false)
EXTRA_JSON=",\"infra_recovered\":$INFRA_OK,\"app_healthy\":$APP_OK,\"alarms_restored\":$([ "$ALARMS_RESTORED" = 1 ] && echo true || echo false)"
if [ "$EXECUTE" = 1 ]; then
  if [ "$INFRA_OK" = true ] && [ "$ALARMS_RESTORED" = 1 ] && [ "$BASELINE" != 1 ]; then m_append "STATUS RESUMED"; fi
  sync_manifest || record manifest-sync failed "final upload failed (local copy kept)"
  echo
  echo "infrastructure recovered: $INFRA_OK | application healthy: $APP_OK | alarm actions restored: $([ "$ALARMS_RESTORED" = 1 ] && echo true || echo false)"
fi
finish
