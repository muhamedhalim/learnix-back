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

test('only ci-cd.yml can push images or roll out ECS (no second deployment path)', () => {
  const offenders = workflows.filter((file) => file !== 'ci-cd.yml' && DEPLOYING.test(read(file)));
  assert.deepEqual(offenders, []);
});

test('ci-cd.yml listens to pushes of main and develop only', () => {
  assert.match(ciCd, /\n {2}push:\n {4}branches: \[main, develop\]\n/u);
});

test('deploy and rollback share one per-environment lock that never cancels a running rollout', () => {
  for (const name of ['deploy', 'rollback']) {
    const text = job(ciCd, name);
    assert.match(text, /group: deploy-api-\$\{\{ needs\.control\.outputs\.environment \}\}/u, name);
    assert.match(text, /cancel-in-progress: false/u, name);
    assert.match(text, /environment: \$\{\{ needs\.control\.outputs\.environment \}\}/u, name);
  }
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
  const deploy = job(ciCd, 'deploy');
  assert.match(deploy, /ecs-deploy\.sh[^\n]*--status/u);
  assert.match(deploy, /scripts\/ci\/release-decision\.sh/u);
  assert.match(deploy, /--verify-only/u);
  assert.match(deploy, /fetch-depth: 0/u);
});

test('releases are identified by the commit SHA, never a mutable tag', () => {
  assert.match(
    job(ciCd, 'deploy'),
    /IMAGE: \$\{\{ vars\.ECR_REPOSITORY_URL \}\}:\$\{\{ github\.sha \}\}/u,
  );
  assert.doesNotMatch(ciCd, /:latest\b/u);
});

test('nothing in the release path hides a failure', () => {
  for (const name of ['control', 'ci-gate', 'gates', 'db-owner-approval', 'deploy', 'rollback']) {
    const text = job(ciCd, name);
    assert.doesNotMatch(text, /continue-on-error/u, name);
    assert.doesNotMatch(text, /\|\| true/u, name);
  }
  // Exactly two advisory jobs, both outside the release path (docs/CI-CD-ARCHITECTURE.md): branch-sync on push,
  // and the PR-time migration classifier (the enforced classifier runs again in `gates`).
  assert.equal(ciCd.match(/^\s+continue-on-error:/gmu)?.length, 2);
  assert.match(
    job(ciCd, 'branch-sync'),
    /continue-on-error: \$\{\{ github\.event_name == 'push' \}\}/u,
  );
  assert.match(job(ciCd, 'migration-safety-check'), /continue-on-error: true/u);
  assert.match(job(ciCd, 'gates'), /BLOCKED[^\n]*exit 1/u);
});

test('the image scanner runs an explicitly pinned Trivy release, not the action default', () => {
  const deploy = job(ciCd, 'deploy');
  assert.match(deploy, /uses: aquasecurity\/trivy-action@[0-9a-f]{40}/u);
  assert.match(deploy, /\n {10}version: v\d+\.\d+\.\d+\n/u);
  assert.match(deploy, /exit-code: '1'/u);
});

test('production deploys require the staging gate and the variables that prove the rollout', () => {
  assert.match(job(ciCd, 'gates'), /node scripts\/ci\/staging-gate\.mjs/u);
  assert.match(job(ciCd, 'deploy'), /REQUIRED="\$REQUIRED API_URL DB_INSTANCE_ID"/u);
});
