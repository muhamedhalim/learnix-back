#!/usr/bin/env bash
# Pause a Learnix environment to cut AWS cost. Manual, run from AWS Console CloudShell. Nothing is deleted.
#   pause-env.sh --env staging|production              # DRY-RUN (default): prints the plan, changes nothing
#   pause-env.sh --env production --execute --confirm-owner-checks
#   pause-env.sh --env staging --status                # read-only: services, RDS, lock, manifest, 7-day clock
# Options: [--snapshot|--no-snapshot] [--no-mute-alarms] [--state-dir DIR] [--state MANIFEST] [--timeout 900]
#   [--max-age-days 8] [--break-lock RUN_ID] [--allow-maintenance-window] [--ignore-mediaconvert] [--ignore-queues]
# Order: lock -> preflight (services steady, RDS backups fresh, DR replication, MediaConvert/SQS idle, maintenance window)
#   -> recovery manifest written, uploaded and verified BEFORE any change -> mute alarm actions -> stop canary if RUNNING
#   -> clamp auto-scaling targets -> ECS api=0, worker=0 -> explicit RDS snapshot (production; waited + verified) -> stop RDS
#   -> post-verify. Every action is journalled INTENT/DONE in the manifest; a crashed or failed run is continued by
#   running the same command again (it reuses the open manifest, so the real pre-pause values are never lost).
# Never: delete anything, terraform, DNS, IAM, KMS, secrets, S3 objects, Backup, ElastiCache, NAT, ALB, CloudFront, WAF.
# Exit: 0 ok/dry-run, 2 refused (guard/preflight/manifest), 3 non-critical step failed, 4 critical failure, 5 post-verify failed.
# RDS restarts BY ITSELF after 7 stopped days: the manifest records the deadline; --status warns under 48 h.
SCRIPT="pause-env"

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
declare -A PRIOR_DESIRED PRIOR_TD PRIOR_MIN PRIOR_MAX HAS_TARGET
PAUSE_OK=0 ALARMS_MUTED=0 CONTINUE=0 ALARM_PRE_LINES="" CANARY_STATE="" RDS_STATUS="" SNAP_ID=""

while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_NAME="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --execute) EXECUTE=1; shift ;;
    --snapshot) SNAPSHOT_MODE=yes; shift ;;
    --no-snapshot) SNAPSHOT_MODE=no; shift ;;
    --no-mute-alarms) MUTE_ALARMS=0; shift ;;
    --state-dir) STATE_DIR="$2"; shift 2 ;;
    --state) STATE_FILE_ARG="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --max-age-days) MAX_AGE_DAYS="$2"; shift 2 ;;
    --break-lock) BREAK_LOCK="$2"; shift 2 ;;
    --allow-maintenance-window) ALLOW_MAINT=1; shift ;;
    --ignore-mediaconvert) IGNORE_MC=1; shift ;;
    --ignore-queues) IGNORE_QUEUES=1; shift ;;
    --confirm-owner-checks) CONFIRM_OWNER=1; shift ;;
    --status) STATUS_ONLY=1; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
setup_env
verify_identity
log "identity: $CALLER_ARN"
if [ "$STATUS_ONLY" = 1 ]; then status_report; exit 0; fi

# ---- Phase 1: environment proof, guards, lock, manifest selection ----------------------------------------------
verify_environment
maintenance_guard
if [ "$ENV_NAME" = production ] && [ "$EXECUTE" = 1 ] && [ "$CONFIRM_OWNER" != 1 ]; then
  cat >&2 <<OWNER
Production pause needs the owner to confirm what no AWS API can show. Re-run with --confirm-owner-checks only after:
  - no BullMQ job you care about is delayed/active (Valkey is not observable from AWS APIs)
  - payment gateway webhooks (EasyKash/Paymob) may fail while api.learnix.school is down - accepted
  - no scheduled live session / campaign / release deploy is running or due
OWNER
  exit 2
fi
acquire_lock
select_manifest
if [ -n "$SEL_FILE" ]; then
  CONTINUE=1; MANIFEST="$SEL_FILE"; load_manifest "$MANIFEST"
  log "CONTINUING open manifest $MANIFEST (status $M_STATUS, created $(fmt_epoch "$M_CREATED")); prior values come from it, not from live state"
fi

# ---- Phase 2: preflight (read-only) --------------------------------------------------------------------------
PRE_FAIL=0
pre() { log "preflight FAIL: $*"; PRE_FAIL=1; }
for s in "${SERVICE_LIST[@]}"; do
  live_desired=$(svc_field "$s" desired)
  if [ "$CONTINUE" = 1 ]; then
    PRIOR_DESIRED[$s]=${M_DESIRED[$s]}; PRIOR_TD[$s]=${M_TD[$s]}; HAS_TARGET[$s]=${M_TARGET[$s]}
    PRIOR_MIN[$s]=$([ "${M_MIN[$s]}" = - ] && echo "" || echo "${M_MIN[$s]}"); PRIOR_MAX[$s]=$([ "${M_MAX[$s]}" = - ] && echo "" || echo "${M_MAX[$s]}")
  else
    PRIOR_DESIRED[$s]=$live_desired; PRIOR_TD[$s]=$(svc_field "$s" td)
    t=$(scalable_target "$s")
    if [ -n "$t" ]; then HAS_TARGET[$s]=1; PRIOR_MIN[$s]=${t%%$'\t'*}; PRIOR_MAX[$s]=${t##*$'\t'}; else HAS_TARGET[$s]=0; PRIOR_MIN[$s]=""; PRIOR_MAX[$s]=""; fi
  fi
  if [ "$live_desired" != 0 ]; then
    [ "$(svc_field "$s" deployments)" = 1 ] || pre "service $s has a deployment in progress"
    [ "$(svc_field "$s" running)" = "$live_desired" ] || pre "service $s running != desired (not steady)"
  fi
done
standalone=$(aws_ ecs list-tasks --cluster "$CLUSTER" --desired-status RUNNING --query 'taskArns' | wc -w)
[ "$standalone" -le "$(running_total)" ] || pre "extra RUNNING tasks in $CLUSTER (a migrate task or other service?): $standalone vs $(running_total)"

RDS_STATUS=$(rds_field Status)
case "$RDS_STATUS" in
  available)
    [ "$(rds_field Pending)" = 0 ] || pre "RDS has pending modifications"
    rt=$(rds_field Restorable)
    if [ -n "$rt" ] && [ $(( $(date -u +%s) - $(date -u -d "$rt" +%s) )) -gt 900 ]; then pre "RDS latest restorable time is older than 15 min ($rt)"; fi
    [ "$(aws_ rds describe-db-instance-automated-backups --db-instance-identifier "$DB_ID" --query 'length(DBInstanceAutomatedBackups)')" -ge 1 ] || pre "no automated backup found for $DB_ID"
    if [ "$ENV_NAME" = production ]; then
      lastc=$(none_to_empty "$(aws_ backup list-backup-jobs --by-resource-arn "$DB_ARN" --by-state COMPLETED --query 'max_by(BackupJobs,&CompletionDate).CompletionDate' --output text)")
      if [ -z "$lastc" ]; then pre "no COMPLETED AWS Backup job found for $DB_ID"
      elif [ $(( $(date -u +%s) - $(date -u -d "$lastc" +%s) )) -gt 93600 ]; then pre "last COMPLETED AWS Backup job is older than 26 h ($lastc)"
      else log "last COMPLETED AWS Backup job: $lastc"; fi
    fi ;;
  stopped|stopping) log "RDS already $RDS_STATUS" ;;
  *) pre "RDS status is $RDS_STATUS" ;;
esac
if [ "$ENV_NAME" = production ]; then
  repl=$(none_to_empty "$(aws --region "$DR_REGION" rds describe-db-instance-automated-backups --query "DBInstanceAutomatedBackups[?DBInstanceIdentifier=='$DB_ID']|[0].Status" --output text | tr -d '\r')")
  [ "$repl" = replicating ] || pre "cross-region backup replication status is '$repl' (expected replicating)"
fi
[ "$(valkey_status)" = available ] || pre "Valkey $VALKEY_ID is not available"

# In-flight work that is reliably observable (MediaConvert is account-wide, so any job blocks).
mc_count() { local n; n=$(aws_ mediaconvert list-jobs --status "$1" --max-results 20 --query 'length(Jobs)' 2>/dev/null) || n=ERR; echo "$n"; }
if [ "$IGNORE_MC" != 1 ]; then
  for st in PROGRESSING SUBMITTED; do
    n=$(mc_count $st)
    if [ "$n" = ERR ]; then pre "cannot read MediaConvert jobs ($st); --ignore-mediaconvert only if you confirmed there are none"
    elif [ "$n" != 0 ]; then pre "$n MediaConvert job(s) $st (account-wide)"; fi
  done
fi
if [ "$IGNORE_QUEUES" != 1 ]; then
  for qn in media-events ses-events sms-events; do
    qurl=$(none_to_empty "$(aws_ sqs get-queue-url --queue-name "learnix-$ENV_NAME-$qn" --query QueueUrl 2>/dev/null || true)")
    [ -n "$qurl" ] || { pre "queue learnix-$ENV_NAME-$qn not readable"; continue; }
    depth=$(aws_ sqs get-queue-attributes --queue-url "$qurl" --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible --query 'Attributes.[ApproximateNumberOfMessages,ApproximateNumberOfMessagesNotVisible]' | awk '{print $1+$2}')
    [ "$depth" = 0 ] || pre "queue learnix-$ENV_NAME-$qn has $depth message(s) (visible + in flight)"
  done
fi
if [ "$PRE_FAIL" = 1 ]; then record preflight failed "see log"; summary_json; exit 2; fi
record preflight ok "env=$ENV_NAME cluster=$CLUSTER db=$DB_ID"

# ---- Plan ----------------------------------------------------------------------------------------------------
if [ "$SNAPSHOT_MODE" = default ]; then [ "$ENV_NAME" = production ] && SNAPSHOT_MODE=yes || SNAPSHOT_MODE=no; fi
SNAP_ID=$(echo "pre-pause-$RUN_ID" | tr 'A-Z' 'a-z')
CANARY_STATE=$([ "$CONTINUE" = 1 ] && echo "$M_CANARY" || canary_state)
if [ "$CONTINUE" != 1 ]; then
  ALARM_PRE_LINES="$(alarm_pre_lines)"; [ -z "$ALARM_PRE_LINES" ] || ALARM_PRE_LINES+=$'\n'
  M_ALARM_TRUE=(); while read -r _ nm en; do if [ "$en" = true ]; then M_ALARM_TRUE+=("$nm"); fi; done <<< "$ALARM_PRE_LINES"
fi
TO_MUTE=()
if [ "$MUTE_ALARMS" = 1 ] && [ "${#M_ALARM_TRUE[@]}" -gt 0 ]; then
  en=" $(enabled_alarms | tr '\n' ' ') "
  for nm in "${M_ALARM_TRUE[@]}"; do case "$en" in *" $nm "*) TO_MUTE+=("$nm") ;; esac; done
fi
MANIFEST_NEW="$STATE_DIR/$ENV_NAME-$RUN_ID.manifest"
echo
echo "==================== PAUSE PLAN  env=$ENV_NAME  account=$ALLOWED_ACCOUNT  region=$REGION ===================="
echo "0. manifest: $([ "$CONTINUE" = 1 ] && echo "continue $MANIFEST" || echo "create $MANIFEST_NEW"), uploaded + verified in s3://$LOGS_BUCKET/$S3_PREFIX/ BEFORE any change"
echo "1. mute ${#TO_MUTE[@]} alarm action sets (prefix $ALARM_PREFIX; ${#M_ALARM_TRUE[@]} recorded as enabled)"
[ -z "$CANARY" ] || echo "2. canary $CANARY: state=$CANARY_STATE -> $([ "$CANARY_STATE" = RUNNING ] && echo stop || echo leave)"
for s in "${SERVICE_LIST[@]}"; do
  echo "3. ecs $CLUSTER/$s: live desired $(svc_field "$s" desired) -> 0 (recorded prior ${PRIOR_DESIRED[$s]})$([ "${HAS_TARGET[$s]}" = 1 ] && echo "; scaling target ${PRIOR_MIN[$s]}/${PRIOR_MAX[$s]} -> 0/0")"
done
echo "4. rds $DB_ID: $RDS_STATUS -> stopped$([ "$SNAPSHOT_MODE" = yes ] && echo ", after explicit snapshot $SNAP_ID (waited until available, encrypted)")"
echo "   NOT touched: Valkey, NAT gateway, ALB, CloudFront, WAF, secrets, KMS, S3, backups, DNS."
[ "$ENV_NAME" != production ] || echo "   WARNING: api.learnix.school will return errors while paused."
echo "   RDS restarts by itself after 7 stopped days (about $(date -u -d '+7 days' +%F)); re-run this script before then."
echo "==========================================================================================================="
if [ "$EXECUTE" != 1 ]; then log "DRY-RUN: nothing was changed (no manifest, no lock). Add --execute to apply."; fi
confirm "pause learnix-$ENV_NAME in $ALLOWED_ACCOUNT"
verify_identity

# ---- Phase 3: durable manifest BEFORE the first mutation ---------------------------------------------------------
phase_checkpoint() { renew_lock; sync_manifest || record manifest-sync failed "upload of $MANIFEST failed (local copy kept)"; }
pause_cleanup() {
  local rc=$1
  [ "$EXECUTE" = 1 ] && [ "$MANIFEST_READY" = 1 ] && [ "$PAUSE_OK" != 1 ] || return 0
  m_append "STATUS FAILED_PARTIAL"
  if [ "$ALARMS_MUTED" = 1 ]; then
    if [ "$(running_total)" -gt 0 ]; then
      echo "[$SCRIPT] pause failed while tasks are still running: re-enabling the muted alarm actions" >&2; restore_alarms
    else
      echo "[$SCRIPT] !!! ALARM ACTIONS ARE STILL MUTED (environment is partly paused). Re-run pause-env.sh to finish, or resume-env.sh to restore." >&2
    fi
  fi
  sync_manifest || echo "[$SCRIPT] WARNING: manifest not uploaded; local copy: $MANIFEST" >&2
  echo "[$SCRIPT] PAUSE INCOMPLETE (exit $rc). Continue: pause-env.sh --env $ENV_NAME --execute   Roll back: resume-env.sh --env $ENV_NAME --execute" >&2
}
CLEANUP_HOOK=pause_cleanup
if [ "$EXECUTE" = 1 ]; then
  if [ "$CONTINUE" = 1 ]; then
    m_append "NOTE continued by $RUN_ID"; m_append "STATUS IN_PROGRESS"
  else
    MANIFEST="$MANIFEST_NEW"; write_manifest_header; m_append "STATUS IN_PROGRESS"
  fi
  validate_manifest "$MANIFEST" || die "freshly written manifest failed validation: $VAL_ERR" 4
  sync_manifest || die "manifest upload/verification failed - nothing was changed" 4
  MANIFEST_READY=1; log "manifest durable: $MANIFEST"
fi

# ---- Phase 4: actions (each journalled INTENT/DONE; every step re-reads live state, so a re-run continues) -----
if [ "${#TO_MUTE[@]}" -gt 0 ]; then
  verify_identity; m_intent mute-alarms; ALARM_FAIL=(); [ "$EXECUTE" != 1 ] || ALARMS_MUTED=1
  alarm_batches disable "${TO_MUTE[@]}"
  if [ "${#ALARM_FAIL[@]}" -gt 0 ]; then record mute-alarms failed "could not mute: ${ALARM_FAIL[*]}"
  else record mute-alarms "$([ "$EXECUTE" = 1 ] && echo ok || echo dry-run)" "${#TO_MUTE[@]} alarms"; fi
  m_done mute-alarms; phase_checkpoint
else record mute-alarms skipped "none enabled or --no-mute-alarms"; fi

if [ "$CANARY_STATE" = RUNNING ] && [ "$(canary_state)" = RUNNING ]; then
  m_intent stop-canary
  if run aws --region "$REGION" synthetics stop-canary --name "$CANARY"; then record stop-canary "$([ "$EXECUTE" = 1 ] && echo ok || echo dry-run)" "$CANARY"; else record stop-canary failed "$CANARY"; fi
  m_done stop-canary
else record stop-canary skipped "state=${CANARY_STATE:-n/a}"; fi

for s in "${SERVICE_LIST[@]}"; do
  verify_identity
  t=$(scalable_target "$s"); t_min=${t%%$'\t'*}; t_max=${t##*$'\t'}
  if [ -n "$t" ] && { [ "$t_min" != 0 ] || [ "$t_max" != 0 ]; }; then
    m_intent "clamp-$s"
    if run aws --region "$REGION" application-autoscaling register-scalable-target --service-namespace ecs \
         --scalable-dimension ecs:service:DesiredCount --resource-id "service/$CLUSTER/$s" --min-capacity 0 --max-capacity 0
    then record "clamp-scaling-$s" "$([ "$EXECUTE" = 1 ] && echo ok || echo dry-run)" "was $t_min/$t_max"
    else record "clamp-scaling-$s" failed "register-scalable-target" critical; fi
    m_done "clamp-$s"
  else record "clamp-scaling-$s" skipped "$([ -n "$t" ] && echo "already 0/0" || echo "no scalable target")"; fi
done
for s in "${SERVICE_LIST[@]}"; do   # api drains before worker
  if [ "$CRITICAL_FAILED" = 1 ]; then record "scale-$s" skipped "earlier critical failure"; continue; fi
  if [ "$(svc_field "$s" desired)" = 0 ] && [ "$(svc_field "$s" running)" = 0 ]; then record "scale-$s" skipped "already 0"; continue; fi
  verify_identity; m_intent "scale-$s"
  if run aws --region "$REGION" ecs update-service --cluster "$CLUSTER" --service "$s" --desired-count 0 >/dev/null; then
    if [ "$EXECUTE" = 1 ]; then
      if wait_service_idle "$s" 0; then record "scale-$s" ok "0 tasks"; m_done "scale-$s"
      else record "scale-$s" failed "did not reach 0 tasks in ${TIMEOUT}s" critical; fi
    else record "scale-$s" dry-run "-> 0"; fi
  else record "scale-$s" failed "update-service" critical; fi
done
phase_checkpoint

# RDS: only when nothing can still be using it. Explicit snapshot first (verified), then stop.
RDS_NOW=$(rds_field Status)
if [ "$RDS_NOW" = stopped ]; then
  record stop-rds skipped "already stopped"
elif [ "$CRITICAL_FAILED" = 1 ]; then
  record stop-rds skipped "earlier critical failure: tasks may still be running"
elif [ "$RDS_NOW" != available ] && [ "$RDS_NOW" != stopping ]; then
  record stop-rds failed "unexpected RDS status $RDS_NOW" critical
else
  verify_identity
  SNAP_OK=1
  if [ "$RDS_NOW" = available ] && [ "$SNAPSHOT_MODE" = yes ]; then
    m_intent snapshot
    if run aws --region "$REGION" rds create-db-snapshot --db-instance-identifier "$DB_ID" --db-snapshot-identifier "$SNAP_ID" \
         --tags Key=Project,Value=learnix Key=Environment,Value="$ENV_NAME" Key=Purpose,Value=pre-pause; then
      if [ "$EXECUTE" = 1 ]; then
        if aws --region "$REGION" rds wait db-snapshot-available --db-snapshot-identifier "$SNAP_ID" \
           && [ "$(aws_ rds describe-db-snapshots --db-snapshot-identifier "$SNAP_ID" --query 'DBSnapshots[0].[Status,Encrypted]' | tr '\t' ' ')" = "available True" ]; then
          m_append "RDS_SNAPSHOT $SNAP_ID"; m_done snapshot; record snapshot ok "$SNAP_ID available + encrypted"
        else SNAP_OK=0; record snapshot failed "$SNAP_ID not available/encrypted: RDS will NOT be stopped" critical; fi
      else record snapshot dry-run "$SNAP_ID"; fi
    else SNAP_OK=0; record snapshot failed "create-db-snapshot: RDS will NOT be stopped" critical; fi
  fi
  if [ "$SNAP_OK" = 1 ]; then
    m_intent stop-rds
    if [ "$RDS_NOW" = available ] && ! run aws --region "$REGION" rds stop-db-instance --db-instance-identifier "$DB_ID"; then
      record stop-rds failed "stop-db-instance" critical
    elif [ "$EXECUTE" = 1 ]; then
      if wait_rds stopped; then
        ev=$(none_to_empty "$(aws_ rds describe-events --source-type db-instance --source-identifier "$DB_ID" --duration 120 --query 'Events[?Message==`DB instance stopped`]|[-1].Date' --output text)")
        stopped_epoch=$( [ -n "$ev" ] && date -u -d "$ev" +%s || now_epoch )
        m_append "RDS_STOPPED_AT $(fmt_epoch "$stopped_epoch")"; m_append "RDS_RESTART_DEADLINE $(fmt_epoch $((stopped_epoch + 7*86400)))"
        m_done stop-rds; record stop-rds ok "stopped; auto-restart deadline $(fmt_epoch $((stopped_epoch + 7*86400)))"
      else record stop-rds failed "not stopped within $((TIMEOUT*2))s" critical; fi
    else record stop-rds dry-run "snapshot=$SNAPSHOT_MODE"; fi
  fi
fi

# ---- Phase 5: post-verification -------------------------------------------------------------------------------
if [ "$EXECUTE" = 1 ]; then
  VERIFY_FAIL=0
  for s in "${SERVICE_LIST[@]}"; do [ "$(svc_field "$s" running)" = 0 ] || { log "verify FAIL: $s still has running tasks"; VERIFY_FAIL=1; }; done
  [ "$(rds_field Status)" = stopped ] || { log "verify FAIL: RDS not stopped (status=$(rds_field Status))"; VERIFY_FAIL=1; }
  if [ "$VERIFY_FAIL" = 0 ] && [ "$CRITICAL_FAILED" = 0 ]; then
    record post-verify ok "tasks=0 rds=stopped"; m_append "STATUS PAUSED"; PAUSE_OK=1
  else record post-verify failed "see log" critical; fi
  phase_checkpoint
  echo
  echo "Still billing while paused: Valkey, ALB, WAF, CloudFront (+ flat-rate plan if subscribed), secrets, KMS, logs, backups, S3,$([ "$ENV_NAME" = production ] && echo ' NAT gateway + its Elastic IP,') RDS storage."
  echo "RDS auto-restarts at the deadline in the manifest. Check: pause-env.sh --env $ENV_NAME --status. Resume: resume-env.sh --env $ENV_NAME --execute"
  [ "$PAUSE_OK" = 1 ] || { summary_json | tee "$STATE_DIR/$ENV_NAME-$SCRIPT-$RUN_ID.json"; exit 5; }
fi
finish
