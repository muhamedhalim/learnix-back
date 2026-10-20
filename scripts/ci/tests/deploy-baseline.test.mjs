import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findDeployedBaseline, run } from '../deploy-baseline.mjs';

const sha = (n) => String(n).repeat(40).slice(0, 40);
const deployment = (id, n, environment = 'production') => ({ id, sha: sha(n), environment });

const decide = (deployments, states) =>
  findDeployedBaseline({
    deployments,
    environment: 'production',
    latestStateOf: (id) => states[id],
  });

test('the newest successful deployment is the baseline', () => {
  assert.equal(
    decide([deployment(3, 3), deployment(2, 2)], { 3: 'success', 2: 'success' }),
    sha(3),
  );
});

test('a failed or still-waiting newer deployment does not count (the deploy that never landed)', () => {
  const deployments = [deployment(4, 4), deployment(3, 3), deployment(2, 2)];
  assert.equal(decide(deployments, { 4: 'failure', 3: 'waiting', 2: 'success' }), sha(2));
});

test('no successful deployment at all means there is no baseline (so the push deploys)', () => {
  assert.equal(decide([deployment(1, 1)], { 1: 'error' }), undefined);
  assert.equal(decide([], {}), undefined);
});

test('deployments of other environments are ignored (Railway "learnix / production")', () => {
  const deployments = [deployment(9, 9, 'learnix / production'), deployment(8, 8, 'staging')];
  assert.equal(decide(deployments, { 9: 'success', 8: 'success' }), undefined);
});

test('run() prints nothing on an API error instead of failing or skipping', () => {
  const env = { REPOSITORY: 'o/r', TARGET: 'production' };
  const failing = () => {
    throw new Error('HTTP 502');
  };
  assert.equal(run(env, failing), '');
});

test('run() refuses an unknown target without calling the API', () => {
  let called = false;
  const api = () => {
    called = true;
    return [];
  };
  assert.equal(run({ REPOSITORY: 'o/r', TARGET: 'learnix / production' }, api), '');
  assert.equal(called, false);
});

test('run() queries the environment and returns the verified sha', () => {
  const calls = [];
  const api = (path) => {
    calls.push(path);
    if (path.includes('/statuses')) return [{ state: 'success' }];
    return [deployment(5, 5)];
  };
  assert.equal(run({ REPOSITORY: 'o/r', TARGET: 'production' }, api), sha(5));
  assert.match(calls[0], /deployments\?environment=production/u);
});
