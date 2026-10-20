#!/usr/bin/env bash
# Offline test of scripts/ecs-deploy.sh against a fake aws CLI (scripts/tests/fake-aws).
# Run from the repository root:
#   docker run --rm -v "$PWD/scripts/tests:/fake" -v "$PWD/scripts:/src:ro" alpine:3.20 sh -c
#   "apk add --no-cache bash jq >/dev/null && mkdir -p /work && install -m 755 /fake/fake-aws /usr/local/bin/aws
#    && install -m 755 /fake/fake-curl /usr/local/bin/curl && bash /fake/ecs-deploy.test.sh"
set -u
cp /src/ecs-deploy.sh /work/d.sh; export POLL_SECONDS=0 ALARM_SETTLE_SECONDS=0 VERIFY_TIMEOUT=0
fresh() { rm -f /work/td-* /work/rolledback /work/registered-* /work/calls.log /work/curl.log /work/previous-task-definitions.json; cd /work; }
NET='{"subnets":["subnet-1"],"securityGroups":["sg-1"],"assignPublicIp":"ENABLED"}'
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }

fresh; out=$(bash d.sh --cluster c --services api,worker --image repo:abc123 --migrate-family learnix-staging-migrate --network "$NET" --alarm-names learnix-staging-alb-5xx 2>&1); rc=$?
check "happy path exits 0" "[ $rc -eq 0 ]"
check "new image on app container only" "[ \$(jq -r '.containerDefinitions[0].image' registered-learnix-staging-api.json) = repo:abc123 ] && [ \$(jq -r '.containerDefinitions[1].image' registered-learnix-staging-api.json) = adot ]"
check "GIT_SHA replaced, not duplicated" "[ \$(jq '[.containerDefinitions[0].environment[]|select(.name==\"GIT_SHA\")]|length' registered-learnix-staging-api.json) = 1 ] && [ \$(jq -r '.containerDefinitions[0].environment[]|select(.name==\"GIT_SHA\").value' registered-learnix-staging-api.json) = abc123 ]"
check "read-only fields stripped, tags kept" "! jq -e 'has(\"revision\") or has(\"taskDefinitionArn\") or has(\"compatibilities\")' registered-learnix-staging-api.json >/dev/null && jq -e '.tags[0].key==\"Project\"' registered-learnix-staging-api.json >/dev/null"
check "migrate ran before services were updated" "[ \$(grep -n 'run-task' calls.log | cut -d: -f1) -lt \$(grep -n 'update-service' calls.log | head -1 | cut -d: -f1) ]"
check "rollback point recorded" "jq -e '.api and .worker' previous-task-definitions.json >/dev/null"

fresh; out=$(MIGRATE_EXIT=1 bash d.sh --cluster c --services api --image repo:abc123 --migrate-family learnix-staging-migrate --network "$NET" 2>&1); rc=$?
check "failed migration stops the deploy" "[ $rc -ne 0 ] && ! grep -q update-service calls.log"

fresh; out=$(ROLLOUT=FAILED bash d.sh --cluster c --services api --image repo:abc123 --timeout 30 2>&1); rc=$?
check "circuit-breaker failure rolls back to the previous revision" "[ $rc -ne 0 ] && grep -q 'update-service.*learnix-staging-api:7' calls.log"

fresh; out=$(ALARMS=learnix-staging-alb-5xx bash d.sh --cluster c --services api --image repo:abc123 --alarm-names learnix-staging-alb-5xx 2>&1); rc=$?
check "alarm that starts firing after deploy rolls back" "[ $rc -ne 0 ] && grep -q 'update-service.*learnix-staging-api:7' calls.log"

fresh; out=$(PRE_ALARMS=learnix-staging-alb-5xx bash d.sh --cluster c --services api --image repo:abc123 --alarm-names learnix-staging-alb-5xx 2>&1); rc=$?
check "alarm already firing blocks the deploy untouched" "[ $rc -ne 0 ] && ! grep -q 'register-task-definition\|update-service' calls.log"

fresh; out=$(ALARMS=learnix-staging-canary-failed bash d.sh --cluster c --services api --image repo:abc123 --alarm-names learnix-staging-alb-5xx 2>&1); rc=$?
check "alarms outside the deploy list are ignored" "[ $rc -eq 0 ]"

fresh; out=$(LATEST_NEWER=1 bash d.sh --cluster c --services api --image repo:abc123 2>&1); rc=$?
check "new revision is built from the family's latest revision" "[ $rc -eq 0 ] && jq -e '.containerDefinitions[0].environment[]|select(.name==\"TF_NEW\")' registered-learnix-staging-api.json >/dev/null && grep -q 'describe-task-definition --task-definition learnix-staging-api ' calls.log"

fresh; out=$(bash d.sh --cluster c --services api --image repo:latest 2>&1); rc=$?
check "refuses :latest" "[ $rc -ne 0 ] && echo \"$out\" | grep -q refusing"

fresh; out=$(ECS_AUTO_ROLLBACK=1 bash d.sh --cluster c --services api --image repo:abc123 --timeout 30 2>&1); rc=$?
check "ECS circuit-breaker rollback that COMPLETES is a failure, not a success" "[ $rc -ne 0 ] && echo \"\$out\" | grep -q 'expected .*learnix-staging-api:8' && ! echo \"\$out\" | grep -q '] deployed'"

fresh; out=$(DEPLOYMENTS=2 bash d.sh --cluster c --services api --image repo:abc123 --timeout 0 2>&1); rc=$?
check "an old deployment still draining is not done" "[ $rc -ne 0 ] && grep -q 'update-service.*learnix-staging-api:7' calls.log"

fresh; out=$(ECR_DIGEST=None bash d.sh --cluster c --services api --image repo:abc123 2>&1); rc=$?
check "an image missing from ECR stops the deploy before any service changes" "[ $rc -ne 0 ] && ! grep -q update-service calls.log"

fresh; out=$(STALE_TASK=1 bash d.sh --cluster c --services api,worker --image repo:abc123 2>&1); rc=$?
check "a running task on the old revision rolls back" "[ $rc -ne 0 ] && grep -q 'update-service.*learnix-staging-api:7' calls.log && grep -q 'update-service.*learnix-staging-worker:7' calls.log"

fresh; out=$(TASK_DIGEST=sha256:old bash d.sh --cluster c --services api --image repo:abc123 2>&1); rc=$?
check "a running task on another image digest rolls back" "[ $rc -ne 0 ] && grep -q 'update-service.*learnix-staging-api:7' calls.log"

fresh; out=$(bash d.sh --cluster c --services api --image repo:abc123 --verify-url https://api.example.test/ 2>&1); rc=$?
check "domain serving the release passes after 10 consecutive matches" "[ $rc -eq 0 ] && [ \$(grep -c 'https://api.example.test/api/v1/health/version' curl.log) -eq 10 ]"

fresh; out=$(SERVED_COMMIT=cf91a61 bash d.sh --cluster c --services api --image repo:abc123 --verify-url https://api.example.test 2>&1); rc=$?
check "domain still serving the old commit rolls back" "[ $rc -ne 0 ] && echo \"\$out\" | grep -q \"serves commit 'cf91a61'\" && grep -q 'update-service.*learnix-staging-api:7' calls.log"

fresh; out=$(ECR_FAIL=1 bash d.sh --cluster c --services api --image repo:abc123 2>&1); rc=$?
check "an ECR lookup error fails the deploy before anything changes" "[ $rc -ne 0 ] && ! grep -q 'register-task-definition\|update-service' calls.log"

fresh; out=$(MIGRATE_EXIT=1 bash d.sh --cluster c --services api,worker --image repo:abc123 --migrate-family learnix-staging-migrate --network "$NET" --verify-url https://api.example.test 2>&1); rc=$?
check "failed migration: nothing rolled, nothing verified, explicit error" "[ $rc -ne 0 ] && ! grep -q update-service calls.log && [ ! -s curl.log ] && echo \"\$out\" | grep -q 'migrations failed'"

# --status: the read-only snapshot scripts/ci/release-decision.sh decides on.
fresh; out=$(RUNNING_IMAGE=repo:aaa bash d.sh --cluster c --services api,worker --status 2>/dev/null); rc=$?
check "status reports the shared running image, stable, latest revision" "[ $rc -eq 0 ] && echo \"\$out\" | grep -qx 'running_image=repo:aaa' && echo \"\$out\" | grep -qx 'stable=true' && echo \"\$out\" | grep -qx 'latest_revision=true'"
check "status changes nothing" "! grep -q 'register-task-definition\|update-service\|run-task' calls.log"

fresh; out=$(RUNNING_IMAGE=repo:aaa WORKER_IMAGE=repo:bbb bash d.sh --cluster c --services api,worker --status 2>/dev/null); rc=$?
check "status: api and worker on different images is no single release" "[ $rc -eq 0 ] && echo \"\$out\" | grep -qx 'running_image=' && echo \"\$out\" | grep -qx 'stable=false'"

fresh; out=$(RUNNING_IMAGE=repo:aaa LATEST_REV=9 bash d.sh --cluster c --services api --status 2>/dev/null); rc=$?
check "status: a newer registered revision (Terraform) is reported" "[ $rc -eq 0 ] && echo \"\$out\" | grep -qx 'latest_revision=false'"

fresh; out=$(RUNNING_IMAGE=repo:aaa IN_PROGRESS=1 bash d.sh --cluster c --services api --status 2>/dev/null); rc=$?
check "status: a rollout in progress is not stable" "[ $rc -eq 0 ] && echo \"\$out\" | grep -qx 'stable=false'"

fresh; out=$(DESCRIBE_FAIL=1 bash d.sh --cluster c --services api --status 2>/dev/null); rc=$?
check "status: an AWS error is a failure with no snapshot" "[ $rc -ne 0 ] && ! echo \"\$out\" | grep -q 'running_image='"

# --verify-only: proves what runs now, never changes anything.
fresh; out=$(RUNNING_IMAGE=repo:abc123 bash d.sh --cluster c --services api,worker --verify-only --image repo:abc123 --verify-url https://api.example.test 2>&1); rc=$?
check "verify-only passes when tasks and domain are on the release" "[ $rc -eq 0 ] && ! grep -q 'register-task-definition\|update-service' calls.log"

fresh; out=$(RUNNING_IMAGE=repo:old bash d.sh --cluster c --services api --verify-only --image repo:abc123 2>&1); rc=$?
check "verify-only fails when the service runs another image" "[ $rc -ne 0 ] && ! grep -q update-service calls.log"

fresh; out=$(RUNNING_IMAGE=repo:abc123 TASK_DIGEST=sha256:old bash d.sh --cluster c --services api --verify-only --image repo:abc123 2>&1); rc=$?
check "verify-only fails on a stale task digest, without rolling anything" "[ $rc -ne 0 ] && ! grep -q update-service calls.log"

fresh; out=$(RUNNING_IMAGE=repo:abc123 SERVED_COMMIT=cf91a61 bash d.sh --cluster c --services api --verify-only --image repo:abc123 --verify-url https://api.example.test 2>&1); rc=$?
check "verify-only fails when the domain serves an old commit" "[ $rc -ne 0 ] && ! grep -q update-service calls.log"

fresh; echo '{"api":"arn:aws:ecs:eu-central-1:111122223333:task-definition/learnix-staging-api:7"}' > prev.json
out=$(bash d.sh --cluster c --services api --rollback --to-file prev.json 2>&1); rc=$?
check "manual rollback" "[ $rc -eq 0 ] && grep -q 'update-service.*api:7' calls.log"
exit $fail
