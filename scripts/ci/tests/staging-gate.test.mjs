import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEPLOY_JOB_NAME, findVerifiedStagingRun, run } from '../staging-gate.mjs';

const TREE = '107212a67a7f53521b532713815691a256e57d46';
const OTHER = '449d46daff4924df8de1d508ee40fcdb841a1f21';
const sha = (n) => String(n).repeat(40).slice(0, 40);

const mainRun = (id, headSha, overrides = {}) => ({
  id,
  head_sha: headSha,
  head_branch: 'main',
  event: 'push',
  conclusion: 'success',
  ...overrides,
});

const decide = ({ runs, trees = {}, deploys = {} }) =>
  findVerifiedStagingRun({
    wantTree: TREE,
    runs,
    treeOf: (s) => trees[s],
    deployConclusionOf: (id) => deploys[id],
  });

test('accepts a main push run of the same tree whose deploy job succeeded', () => {
  const outcome = decide({
    runs: [mainRun(1, sha(1))],
    trees: { [sha(1)]: TREE },
    deploys: { 1: 'success' },
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.run.id, 1);
});

test('the commit id may differ: a re-created commit shares the tree of the staging-deployed commit', () => {
  const outcome = decide({
    runs: [mainRun(7, sha(2))],
    trees: { [sha(2)]: TREE },
    deploys: { 7: 'success' },
  });
  assert.equal(outcome.ok, true);
});

test('rejects when no main run exists at all', () => {
  const outcome = decide({ runs: [] });
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /no successful staging deploy/u);
});

test('rejects a green run of a different tree', () => {
  const outcome = decide({
    runs: [mainRun(1, sha(1))],
    trees: { [sha(1)]: OTHER },
    deploys: { 1: 'success' },
  });
  assert.equal(outcome.ok, false);
});

test('a green run whose deploy job was skipped is NOT proof of a staging deploy', () => {
  for (const conclusion of ['skipped', 'failure', 'cancelled', undefined]) {
    const outcome = decide({
      runs: [mainRun(1, sha(1))],
      trees: { [sha(1)]: TREE },
      deploys: { 1: conclusion },
    });
    assert.equal(outcome.ok, false, `deploy job ${String(conclusion)}`);
    assert.match(outcome.rejected.join(), /staging was not deployed/u);
  }
});

test('a later run of the same tree with a real deploy is accepted after an earlier skipped one', () => {
  const outcome = decide({
    runs: [mainRun(2, sha(2)), mainRun(1, sha(1))],
    trees: { [sha(2)]: TREE, [sha(1)]: TREE },
    deploys: { 2: 'skipped', 1: 'success' },
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.run.id, 1);
});

test('only successful push runs on main count, whatever the API returned', () => {
  for (const override of [
    { head_branch: 'develop' },
    { head_branch: 'feature/x' },
    { event: 'pull_request' },
    { event: 'workflow_dispatch' },
    { conclusion: 'failure' },
    { conclusion: null },
  ]) {
    const outcome = decide({
      runs: [mainRun(1, sha(1), override)],
      trees: { [sha(1)]: TREE },
      deploys: { 1: 'success' },
    });
    assert.equal(outcome.ok, false, JSON.stringify(override));
  }
});

test('an unreadable commit (history rewritten) proves nothing', () => {
  const outcome = decide({ runs: [mainRun(1, sha(1))], trees: {}, deploys: { 1: 'success' } });
  assert.equal(outcome.ok, false);
});

test('a malformed tree id fails closed', () => {
  for (const wantTree of [undefined, '', 'HEAD', 'abc123']) {
    const outcome = findVerifiedStagingRun({
      wantTree,
      runs: [mainRun(1, sha(1))],
      treeOf: () => wantTree,
      deployConclusionOf: () => 'success',
    });
    assert.equal(outcome.ok, false);
  }
});

test('run() fails closed without a repository and on an API/git error', () => {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    assert.equal(run({}), 1);
    assert.equal(run({ REPOSITORY: 'owner/name', GITHUB_SHA: 'not-a-commit-sha' }), 1);
  } finally {
    console.log = original;
  }
  assert.match(lines.join('\n'), /::error::staging gate/u);
});

test('the workflow runs this script and the deploy job keeps the name the script looks for', () => {
  const read = (file) =>
    readFileSync(
      fileURLToPath(new URL(`../../../.github/workflows/${file}`, import.meta.url)),
      'utf8',
    );
  const workflow = read('ci-cd.yml');
  const [caller, called] = DEPLOY_JOB_NAME.split(' / ');
  assert.ok(workflow.includes(`name: ${caller}`), 'staging caller job was renamed');
  assert.ok(read('deploy-aws.yml').includes(`name: ${called}`), 'deploy job was renamed');
  assert.ok(
    workflow.includes('node scripts/ci/staging-gate.mjs'),
    'gate step no longer runs the script',
  );
  assert.match(
    workflow,
    /actions: read/u,
    'the gates job needs actions:read for the runs/jobs API',
  );
});
