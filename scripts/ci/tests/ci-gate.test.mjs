import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { evaluate } from '../ci-gate.mjs';

const gateScript = fileURLToPath(new URL('../ci-gate.mjs', import.meta.url));
const required = ['control', 'build-test', 'e2e', 'format-check'];
const results = (overrides = {}) => ({
  control: { result: 'success' },
  'build-test': { result: 'success' },
  e2e: { result: 'success' },
  'format-check': { result: 'success' },
  ...overrides,
});

test('passes when every required job succeeded', () => {
  assert.equal(evaluate({ needs: results(), required }).ok, true);
});

test('a failed required job fails the gate and is named', () => {
  const outcome = evaluate({ needs: results({ e2e: { result: 'failure' } }), required });
  assert.equal(outcome.ok, false);
  assert.deepEqual(outcome.failed, ['e2e']);
});

test('cancelled and skipped are failures, reported apart from assertion failures', () => {
  const outcome = evaluate({
    needs: results({
      'build-test': { result: 'cancelled' },
      'format-check': { result: 'skipped' },
    }),
    required,
  });
  assert.equal(outcome.ok, false);
  assert.deepEqual(outcome.failed, []);
  assert.deepEqual(outcome.incomplete, ['build-test (cancelled)', 'format-check (skipped)']);
});

test('skipped is accepted only for a job explicitly allowed to skip', () => {
  const needs = results({ e2e: { result: 'skipped' } });
  assert.equal(evaluate({ needs, required, allowSkipped: ['e2e'] }).ok, true);
  assert.equal(evaluate({ needs, required, allowSkipped: ['format-check'] }).ok, false);
});

test('a required job missing from needs fails closed', () => {
  const needs = results();
  delete needs.e2e;
  const outcome = evaluate({ needs, required });
  assert.equal(outcome.ok, false);
  assert.match(outcome.problems.join(), /required job 'e2e' has no result/u);
});

test('an empty or malformed result list is never a pass', () => {
  assert.equal(evaluate({ needs: {}, required }).ok, false);
  assert.equal(evaluate({ needs: undefined, required }).ok, false);
  assert.equal(evaluate({ needs: null, required }).ok, false);
  assert.equal(evaluate({ needs: [], required }).ok, false);
  assert.equal(evaluate({ needs: results(), required: [] }).ok, false);
});

test('a job with no result field fails', () => {
  assert.equal(evaluate({ needs: results({ e2e: {} }), required }).ok, false);
  assert.equal(evaluate({ needs: results({ e2e: 'success' }), required }).ok, false);
});

test('a job outside the required list still has to succeed', () => {
  const outcome = evaluate({ needs: results({ extra: { result: 'failure' } }), required });
  assert.equal(outcome.ok, false);
  assert.deepEqual(outcome.failed, ['extra']);
});

function runGate(env) {
  return spawnSync(process.execPath, [gateScript], {
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
  });
}

test('the CLI exits 1 and names the failing job in an error annotation', () => {
  const run = runGate({
    NEEDS_JSON: JSON.stringify(results({ e2e: { result: 'failure' } })),
    REQUIRED_JOBS: required.join(' '),
  });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /::error::CI gate: required job\(s\) FAILED: e2e/u);
});

test('the CLI exits 0 when everything succeeded', () => {
  const run = runGate({ NEEDS_JSON: JSON.stringify(results()), REQUIRED_JOBS: required.join(' ') });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /All validation jobs succeeded/u);
});

test('the CLI fails on missing, empty or garbage input', () => {
  assert.equal(runGate({ REQUIRED_JOBS: 'a' }).status, 1);
  assert.equal(runGate({ NEEDS_JSON: '', REQUIRED_JOBS: 'a' }).status, 1);
  assert.equal(runGate({ NEEDS_JSON: '{not json', REQUIRED_JOBS: 'a' }).status, 1);
  assert.equal(runGate({ NEEDS_JSON: '{}', REQUIRED_JOBS: 'a' }).status, 1);
});
