import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { evaluateAll, evaluateShard, render } from '../e2e-verdict.mjs';
import { redact } from '../redact.mjs';

const script = fileURLToPath(new URL('../e2e-verdict.mjs', import.meta.url));

const green = {
  success: true,
  numTotalTestSuites: 3,
  numFailedTestSuites: 0,
  numRuntimeErrorTestSuites: 0,
  numTotalTests: 10,
  numPassedTests: 10,
  numFailedTests: 0,
  testResults: [],
};
const json = (value) => JSON.stringify(value);

test('a green shard with exit code 0 passes', () => {
  const shard = evaluateShard({ results: json(green), exitCode: '0\n' });
  assert.equal(shard.ok, true);
  assert.equal(shard.kind, 'passed');
});

test('missing results.json or exit-code.txt fails as infrastructure', () => {
  assert.equal(evaluateShard({ results: undefined, exitCode: '0' }).kind, 'infrastructure');
  assert.equal(evaluateShard({ results: json(green), exitCode: undefined }).kind, 'infrastructure');
  assert.equal(evaluateShard({ results: undefined, exitCode: undefined }).ok, false);
});

test('malformed json or a non-numeric exit code fails', () => {
  assert.equal(evaluateShard({ results: '{"success": tr', exitCode: '0' }).ok, false);
  assert.equal(evaluateShard({ results: json(green), exitCode: 'oops' }).ok, false);
  assert.equal(evaluateShard({ results: '', exitCode: '0' }).ok, false);
});

test('a result with zero suites is not a pass', () => {
  const shard = evaluateShard({
    results: json({ ...green, numTotalTestSuites: 0, numTotalTests: 0 }),
    exitCode: '0',
  });
  assert.equal(shard.ok, false);
  assert.match(shard.problems.join(), /0 suites/u);
});

test('a non-zero exit code fails even when jest wrote success: true', () => {
  const shard = evaluateShard({ results: json(green), exitCode: '1' });
  assert.equal(shard.ok, false);
  assert.equal(shard.kind, 'infrastructure');
  assert.match(shard.problems.join(), /exited with status 1/u);
});

test('failed assertions are an assertion failure with the failing test named and the message masked', () => {
  const failed = {
    ...green,
    success: false,
    numFailedTests: 1,
    numFailedTestSuites: 1,
    testResults: [
      {
        name: '/repo/test/e2e/teacher-follow-up-ownership.postgres.e2e-spec.ts',
        status: 'failed',
        message: '',
        assertionResults: [
          {
            status: 'failed',
            fullName: 'Teacher follow-up keeps output identical',
            failureMessages: [
              '\u001b[31mError: connect postgres://postgres:hunter2@localhost:5432/lms\u001b[0m\n  at x',
            ],
          },
        ],
      },
    ],
  };
  const shard = evaluateShard({ results: json(failed), exitCode: '1' });
  assert.equal(shard.ok, false);
  assert.equal(shard.kind, 'assertion');
  assert.equal(shard.failures[0].test, 'Teacher follow-up keeps output identical');
  assert.match(shard.failures[0].suite, /^test[\\/]e2e[\\/]teacher-follow-up-ownership/u);
  // eslint-disable-next-line no-control-regex -- asserting the ESC byte was stripped
  assert.doesNotMatch(shard.failures[0].message, /hunter2|\u001b/u);
});

test('a suite that crashed before any test is reported, as infrastructure', () => {
  const crashed = {
    ...green,
    success: false,
    numFailedTestSuites: 1,
    numRuntimeErrorTestSuites: 1,
    testResults: [
      {
        name: '/repo/test/e2e/x.e2e-spec.ts',
        status: 'failed',
        message: 'Cannot find module',
        assertionResults: [],
      },
    ],
  };
  const shard = evaluateShard({ results: json(crashed), exitCode: '1' });
  assert.equal(shard.kind, 'infrastructure');
  assert.equal(shard.failures[0].test, '(suite failed before any test ran)');
});

test('every shard has to be green: one missing shard fails the verdict', () => {
  const files = {
    'd/e2e-shard-1/results.json': json(green),
    'd/e2e-shard-1/exit-code.txt': '0',
    'd/e2e-shard-2/results.json': json(green),
    'd/e2e-shard-2/exit-code.txt': '0',
  };
  const read = (path) => files[path.replaceAll('\\', '/')];
  assert.equal(evaluateAll({ dir: 'd', shards: 2, read }).ok, true);
  const outcome = evaluateAll({ dir: 'd', shards: 3, read });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.outcomes[2].ok, false);
  assert.equal(evaluateAll({ dir: 'd', shards: 0, read }).ok, false);
});

test('the rendered report names failed shards and truncates long lists', () => {
  const many = Array.from({ length: 40 }, (_, index) => ({
    status: 'failed',
    fullName: `test ${index}`,
    failureMessages: ['boom'],
  }));
  const failed = {
    ...green,
    success: false,
    numFailedTests: 40,
    numFailedTestSuites: 1,
    testResults: [{ name: '/r/test/e2e/a.e2e-spec.ts', status: 'failed', assertionResults: many }],
  };
  const outcome = evaluateAll({
    dir: 'd',
    shards: 1,
    read: (path) => (path.endsWith('.json') ? json(failed) : '1'),
  });
  const text = render(outcome);
  assert.match(text, /FAILED \(assertions\)/u);
  assert.match(text, /and 25 more/u);
});

test('the CLI exits 1 when the directory is missing and 0 for green shards', () => {
  const dir = mkdtempSync(join(tmpdir(), 'verdict-'));
  try {
    const missing = spawnSync(
      process.execPath,
      [script, '--dir', join(dir, 'none'), '--shards', '2'],
      { encoding: 'utf8' },
    );
    assert.equal(missing.status, 1);
    for (const shard of [1, 2]) {
      const shardDir = join(dir, `e2e-shard-${shard}`);
      mkdirSync(shardDir);
      writeFileSync(join(shardDir, 'results.json'), json(green));
      writeFileSync(join(shardDir, 'exit-code.txt'), '0\n');
    }
    const ok = spawnSync(process.execPath, [script, '--dir', dir, '--shards', '2'], {
      encoding: 'utf8',
    });
    assert.equal(ok.status, 0);
    const wrongCount = spawnSync(process.execPath, [script, '--dir', dir, '--shards', '3'], {
      encoding: 'utf8',
    });
    assert.equal(wrongCount.status, 1);
    assert.equal(spawnSync(process.execPath, [script], { encoding: 'utf8' }).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('redact masks connection strings, bearer tokens, key=value secrets and known token shapes', () => {
  const input = [
    'DATABASE_URL=postgres://postgres:s3cr3t@db:5432/x',
    'Authorization: Bearer abcdefgh12345678',
    '{"password": "hunter2", "name": "kept"}',
    'JWT_SECRET=test-jwt-secret-value',
    `token ghp_${'a'.repeat(36)} and AKIAABCDEFGHIJKLMNOP`,
    'plain line stays',
  ].join('\n');
  const out = redact(input);
  for (const secret of [
    's3cr3t',
    'abcdefgh12345678',
    'hunter2',
    'test-jwt-secret-value',
    'ghp_',
    'AKIAABCDEFGHIJKLMNOP',
  ]) {
    assert.ok(!out.includes(secret), `leaked ${secret}`);
  }
  assert.match(out, /"name": "kept"/u);
  assert.match(out, /plain line stays/u);
});
