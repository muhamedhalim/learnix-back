#!/usr/bin/env bash
# Offline test of scripts/ecs-deploy.sh against a fake aws CLI (scripts/tests/fake-aws).
# Run from the repository root:
#   docker run --rm -v "$PWD/scripts/tests:/fake" -v "$PWD/scripts:/src:ro" alpine:3.20 sh -c
#   "apk add --no-cache bash jq >/dev/null && mkdir -p /work && install -m 755 /fake/fake-aws /usr/local/bin/aws && bash /fake/ecs-deploy.test.sh"
set -u
cp /src/ecs-deploy.sh /work/d.sh; export POLL_SECONDS=0 ALARM_SETTLE_SECONDS=0
fresh() { rm -f /work/td-* /work/rolledback /work/registered-* /work/calls.log /work/previous-task-definitions.json; cd /work; }
NET='{"subnets":["subnet-1"],"securityGroups":["sg-1"],"assignPublicIp":"ENABLED"}'
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }

fresh; out=$(bash d.sh --cluster c --services api,worker --image repo:abc123 --migrate-family learnix-staging-migrate --network "$NET" --alarm-prefix learnix-staging 2>&1); rc=$?
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

fresh; out=$(ALARMS=learnix-staging-alb-5xx bash d.sh --cluster c --services api --image repo:abc123 --alarm-prefix learnix-staging 2>&1); rc=$?
check "firing alarm after deploy rolls back" "[ $rc -ne 0 ] && grep -q 'update-service.*learnix-staging-api:7' calls.log"

fresh; out=$(bash d.sh --cluster c --services api --image repo:latest 2>&1); rc=$?
check "refuses :latest" "[ $rc -ne 0 ] && echo \"$out\" | grep -q refusing"

fresh; echo '{"api":"arn:aws:ecs:eu-central-1:111122223333:task-definition/learnix-staging-api:7"}' > prev.json
out=$(bash d.sh --cluster c --services api --rollback --to-file prev.json 2>&1); rc=$?
check "manual rollback" "[ $rc -eq 0 ] && grep -q 'update-service.*api:7' calls.log"
exit $fail
