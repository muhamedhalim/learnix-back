// Decides whether the E2E shards passed, from what each shard itself recorded.
//
//   node scripts/ci/e2e-verdict.mjs --dir shard-results --shards 4 [--summary-file "$GITHUB_STEP_SUMMARY"]
//
// Each shard uploads `e2e-shard-<n>/results.json` (jest's own JSON) and `exit-code.txt` (jest's exit
// status, captured past the `tee`). The verdict does not trust the matrix job's `result` alone: a shard
// passes only when BOTH files exist, parse, agree, and show work was done. Anything missing is a
// failure, so an artifact that was never uploaded (cancelled, timed out, OOM-killed runner) can never be
// read as a pass.
//
// Output goes to stdout (appended to the run summary by the caller). Failure messages are ANSI-stripped,
// credential-masked and truncated; nothing is dumped wholesale.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { redact } from './redact.mjs';

const MAX_FAILURES_LISTED = 15;
const MAX_MESSAGE_CHARS = 400;
const MAX_MESSAGE_LINES = 6;

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function shortMessage(raw) {
  const lines = redact(String(raw ?? ''))
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '');
  const text = lines.slice(0, MAX_MESSAGE_LINES).join('\n    ');
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}...` : text;
}

/** Evaluates one shard from its two files' contents. Pure: no file access. */
export function evaluateShard({ results, exitCode }) {
  const problems = [];
  const failures = [];
  let kind = 'passed';

  let parsed;
  if (results === undefined) {
    problems.push(
      'no results.json: jest never wrote its result (shard cancelled, timed out or the runner died)',
    );
    kind = 'infrastructure';
  } else {
    try {
      parsed = JSON.parse(results);
    } catch {
      problems.push('results.json is not valid JSON (truncated write?)');
      kind = 'infrastructure';
    }
  }

  const code = exitCode === undefined ? undefined : exitCode.trim();
  if (code === undefined) {
    problems.push('no exit-code.txt: the shard did not record how jest exited');
    kind = 'infrastructure';
  } else if (!/^\d+$/u.test(code)) {
    problems.push(`exit-code.txt is not a number: '${code.slice(0, 20)}'`);
    kind = 'infrastructure';
  }

  if (parsed !== undefined) {
    const suites = parsed.testResults ?? [];
    if (!Number.isFinite(parsed.numTotalTestSuites) || parsed.numTotalTestSuites === 0) {
      problems.push('no test suite ran (0 suites): an empty result is not a pass');
      kind = 'infrastructure';
    }
    const failedTests = parsed.numFailedTests ?? 0;
    const failedSuites = parsed.numFailedTestSuites ?? 0;
    const runtimeErrors = parsed.numRuntimeErrorTestSuites ?? 0;
    if (failedTests > 0 || failedSuites > 0 || parsed.success === false) {
      problems.push(`${failedTests} failed test(s) in ${failedSuites} failed suite(s)`);
      if (kind === 'passed') kind = 'assertion';
    }
    if (runtimeErrors > 0) {
      problems.push(
        `${runtimeErrors} suite(s) failed to run (compile error, setup error or crash)`,
      );
      kind = 'infrastructure';
    }
    if (parsed.success !== true && failedTests === 0 && failedSuites === 0 && runtimeErrors === 0) {
      problems.push("jest's own `success` flag is not true");
      if (kind === 'passed') kind = 'infrastructure';
    }
    for (const suite of suites) {
      if (suite.status !== 'failed') continue;
      const name = String(suite.name ?? '').replace(/^.*[\\/](test[\\/])/u, '$1');
      const tests = (suite.assertionResults ?? []).filter((test) => test.status === 'failed');
      if (tests.length === 0) {
        failures.push({
          suite: name,
          test: '(suite failed before any test ran)',
          message: shortMessage(suite.message),
        });
      }
      for (const test of tests) {
        failures.push({
          suite: name,
          test: test.fullName ?? test.title ?? '(unnamed test)',
          message: shortMessage((test.failureMessages ?? [])[0]),
        });
      }
    }
  }

  if (code !== undefined && /^\d+$/u.test(code) && Number(code) !== 0) {
    problems.push(`jest exited with status ${code}`);
    if (kind === 'passed') kind = 'infrastructure';
  }

  return {
    ok: problems.length === 0,
    kind: problems.length === 0 ? 'passed' : kind,
    problems,
    failures,
    totals: parsed
      ? {
          suites: parsed.numTotalTestSuites,
          tests: parsed.numTotalTests,
          passed: parsed.numPassedTests,
        }
      : undefined,
  };
}

export function evaluateAll({ dir, shards, read = readText }) {
  const outcomes = [];
  for (let shard = 1; shard <= shards; shard += 1) {
    const base = join(dir, `e2e-shard-${shard}`);
    outcomes.push({
      shard,
      ...evaluateShard({
        results: read(join(base, 'results.json')),
        exitCode: read(join(base, 'exit-code.txt')),
      }),
    });
  }
  return { ok: shards > 0 && outcomes.every((outcome) => outcome.ok), outcomes };
}

export function render({ ok, outcomes }) {
  const lines = [
    '### E2E verdict',
    '',
    '| Shard | Verdict | Suites | Tests passed | Detail |',
    '|---|---|---|---|---|',
  ];
  for (const outcome of outcomes) {
    const verdict = outcome.ok
      ? 'passed'
      : outcome.kind === 'assertion'
        ? '**FAILED (assertions)**'
        : '**FAILED (infrastructure)**';
    const totals = outcome.totals ?? { suites: '-', tests: '-', passed: '-' };
    lines.push(
      `| ${outcome.shard} | ${verdict} | ${totals.suites} | ${totals.passed}/${totals.tests} | ${outcome.problems.join('; ') || '-'} |`,
    );
  }
  const failures = outcomes.flatMap((outcome) =>
    outcome.failures.map((failure) => ({ shard: outcome.shard, ...failure })),
  );
  if (failures.length > 0) {
    lines.push('', '#### Failed tests');
    for (const failure of failures.slice(0, MAX_FAILURES_LISTED)) {
      lines.push(`- shard ${failure.shard}: \`${failure.suite}\` - ${failure.test}`);
      if (failure.message !== '') lines.push(`    ${failure.message}`);
    }
    if (failures.length > MAX_FAILURES_LISTED) {
      lines.push(
        `- ... and ${failures.length - MAX_FAILURES_LISTED} more (see the e2e-shard-N artifacts)`,
      );
    }
  }
  if (!ok)
    lines.push(
      '',
      'Full logs: the `e2e-shard-N` artifacts (`jest-output.log`, `service-*.log`, `junit.xml`).',
    );
  return lines.join('\n');
}

function main(argv) {
  const value = (flag) => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const dir = value('--dir');
  const shards = Number.parseInt(value('--shards') ?? '', 10);
  if (dir === undefined || !Number.isInteger(shards) || shards < 1) {
    console.error('usage: e2e-verdict.mjs --dir <directory> --shards <n> [--summary-file <path>]');
    return 2;
  }
  if (!existsSync(dir))
    console.error(`::warning::${dir} does not exist: no shard uploaded anything`);
  const outcome = evaluateAll({ dir, shards });
  const report = render(outcome);
  console.log(report);
  const summaryFile = value('--summary-file');
  if (summaryFile !== undefined && summaryFile !== '')
    appendFileSync(
      summaryFile,
      `${report}
`,
    );
  if (!outcome.ok) {
    const bad = outcome.outcomes
      .filter((entry) => !entry.ok)
      .map((entry) => `${entry.shard} (${entry.kind})`);
    console.log(
      `::error::E2E shard(s) not green: ${bad.join(', ')}. See the run summary and the e2e-shard-N artifacts.`,
    );
  }
  return outcome.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
