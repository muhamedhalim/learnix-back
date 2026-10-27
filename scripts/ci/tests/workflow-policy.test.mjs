// Structural rules of the release pipeline, checked on the workflow text (no YAML library: this runs before
// `npm ci`). They keep exactly ONE path that deploys each environment and stop competing deployments.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const workflowsDir = join(root, '.github/workflows');
const workflows = readdirSync(workflowsDir).filter((f) => /\.ya?ml$/u.test(f));
const read = (file) => readFileSync(join(workflowsDir, file), 'utf8').replace(/\r\n/gu, '\n');
const ciCd = read('ci-cd.yml');
const deployAws = read('deploy-aws.yml');

/** The text of one top-level job (2-space indented key under `jobs:`). */
function job(text, name) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.notEqual(start, -1, `job ${name} not found`);
  let end = start + 1;
  while (end < lines.length && !/^ {2}[a-z0-9-]+:$/u.test(lines[end]) && !/^\S/u.test(lines[end]))
    end += 1;
  return lines.slice(start, end).join('\n');
}

const DEPLOYING =
  /ecs-deploy\.sh[^\n]*--cluster|docker push|update-service|amazon-ecr-login|create-db-snapshot/u;

test('only ci-cd.yml and the deploy-aws.yml it calls can push images or roll out ECS', () => {
  const allowed = new Set(['ci-cd.yml', 'deploy-aws.yml']);
  const offenders = workflows.filter((file) => !allowed.has(file) && DEPLOYING.test(read(file)));
  assert.deepEqual(offenders, []);
  // The rollback job is the only place ci-cd.yml itself touches ECS; images are built in deploy-aws.yml only.
  assert.doesNotMatch(ciCd, /docker push|amazon-ecr-login|create-db-snapshot/u);
});

test('deploy-aws.yml is reusable only: it has no trigger of its own', () => {
  assert.match(deployAws, /\non:\n {2}workflow_call:\n/u);
  assert.doesNotMatch(deployAws, /\n {2}(push|pull_request|schedule|workflow_dispatch):/u);
});

test('ci-cd.yml listens to pushes of main only: no other branch deploys or gates a deploy', () => {
  assert.match(ciCd, /\n {2}push:\n {4}branches: \[main\]\n/u);
  assert.doesNotMatch(ciCd, /develop|branch-sync|branch_sync/u);
  assert.doesNotMatch(ciCd, /\n {2}schedule:/u);
});

test('deploy and rollback share one per-environment lock that never cancels a running rollout', () => {
  const deploy = job(deployAws, 'deploy');
  assert.match(deploy, /group: deploy-api-\$\{\{ inputs\.environment \}\}/u);
  assert.match(deploy, /cancel-in-progress: false/u);
  assert.match(deploy, /environment: \$\{\{ inputs\.environment \}\}/u);
  const rollback = job(ciCd, 'rollback');
  assert.match(rollback, /group: deploy-api-\$\{\{ needs\.control\.outputs\.environment \}\}/u);
  assert.match(rollback, /cancel-in-progress: false/u);
  assert.match(rollback, /environment: \$\{\{ needs\.control\.outputs\.environment \}\}/u);
});

test('a push to main promotes staging, then production, of the same commit in one run', () => {
  const staging = job(ciCd, 'deploy-staging');
  const production = job(ciCd, 'deploy-production');
  for (const [text, env] of [
    [staging, 'staging'],
    [production, 'production'],
  ]) {
    assert.match(text, /uses: \.\/\.github\/workflows\/deploy-aws\.yml\n/u, env);
    assert.match(text, new RegExp(`environment: ${env}\\n`, 'u'), env);
    assert.match(text, /id-token: write/u, env);
    assert.match(text, /needs\.gates\.result == 'success'/u, env);
  }
  assert.match(production, /needs: \[control, gates, deploy-staging, db-owner-approval\]/u);
  assert.match(production, /needs\.deploy-staging\.result == 'success'/u);
  assert.match(job(ciCd, 'db-owner-approval'), /needs: \[control, gates, deploy-staging\]/u);
});

test('push runs of a branch queue instead of cancelling each other', () => {
  assert.match(ciCd, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/u);
});

test('routing is the tested script, not inline shell with a diff-based skip', () => {
  const control = job(ciCd, 'control');
  assert.match(control, /bash scripts\/ci\/route-event\.sh/u);
  assert.doesNotMatch(control, /git diff|app_changed|deploy-baseline/u);
});

test('the deploy job decides from the runtime and verifies it on every path', () => {
  const deploy = job(deployAws, 'deploy');
  assert.match(deploy, /ecs-deploy\.sh[^\n]*--status/u);
  assert.match(deploy, /scripts\/ci\/release-decision\.sh/u);
  assert.match(deploy, /--verify-only/u);
  assert.match(deploy, /fetch-depth: 0/u);
});

test('releases are identified by the commit SHA, never a mutable tag', () => {
  assert.match(
    job(deployAws, 'deploy'),
    /IMAGE: \$\{\{ vars\.ECR_REPOSITORY_URL \}\}:\$\{\{ github\.sha \}\}/u,
  );
  assert.doesNotMatch(ciCd, /:latest\b/u);
  assert.doesNotMatch(deployAws, /:latest\b/u);
});

test('nothing in the release path hides a failure', () => {
  for (const name of [
    'control',
    'ci-gate',
    'gates',
    'deploy-staging',
    'db-owner-approval',
    'deploy-production',
    'rollback',
  ]) {
    const text = job(ciCd, name);
    assert.doesNotMatch(text, /continue-on-error/u, name);
    assert.doesNotMatch(text, /\|\| true/u, name);
  }
  assert.doesNotMatch(deployAws, /continue-on-error|\|\| true/u);
  // Exactly one advisory job, outside the release path (docs/CI-CD-ARCHITECTURE.md): the PR-time migration
  // classifier (the enforced classifier runs again in `gates`).
  assert.equal(ciCd.match(/^\s+continue-on-error:/gmu)?.length, 1);
  assert.match(job(ciCd, 'migration-safety-check'), /continue-on-error: true/u);
  assert.match(job(ciCd, 'gates'), /BLOCKED[^\n]*exit 1/u);
});

test('the image scanner runs an explicitly pinned Trivy release, not the action default', () => {
  const deploy = job(deployAws, 'deploy');
  assert.match(deploy, /uses: aquasecurity\/trivy-action@[0-9a-f]{40}/u);
  assert.match(deploy, /\n {10}version: v\d+\.\d+\.\d+\n/u);
  assert.match(deploy, /exit-code: '1'/u);
});

test('manual production deploys require the staging gate; every rollout needs the variables that prove it', () => {
  assert.match(job(ciCd, 'gates'), /node scripts\/ci\/staging-gate\.mjs/u);
  assert.match(job(deployAws, 'deploy'), /REQUIRED="\$REQUIRED API_URL DB_INSTANCE_ID"/u);
});
