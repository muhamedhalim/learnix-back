// Turns the E2E jest `--json` result files into a Markdown summary and a pass/fail verdict.
//
// Everything printed comes from the files jest wrote — names of failed suites and tests are copied
// verbatim, nothing is inferred. Used twice by CI:
//   * per shard:   `ts-node scripts/e2e-summary.ts e2e-results/results.json`
//   * aggregate:   `ts-node scripts/e2e-summary.ts shard-artifacts/*/results.json`
// Markdown goes to stdout (CI appends it to $GITHUB_STEP_SUMMARY). Exit code is 1 when any given file
// reports a failed test or suite, is missing, or is unreadable — an absent result is never a pass.

import { readFileSync } from 'node:fs';

interface AssertionResult {
  fullName: string;
  status: string;
}

interface SuiteResult {
  name: string;
  status: string;
  message: string;
  assertionResults: AssertionResult[];
}

interface JestJson {
  numTotalTestSuites: number;
  numFailedTestSuites: number;
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  testResults: SuiteResult[];
  startTime: number;
  success: boolean;
}

const MAX_FAILED_LISTED = 50;

function load(path: string): JestJson | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as JestJson;
  } catch {
    return undefined;
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const reportOnly = args.includes('--report-only');
  const files = args.filter((arg) => arg !== '--report-only');
  if (files.length === 0) {
    console.error('usage: e2e-summary.ts <results.json>...');
    process.exit(2);
  }

  let ok = true;
  const rows: string[] = [];
  const details: string[] = [];

  for (const file of files) {
    const label = file.split(/[\/]/u).slice(-2, -1)[0] ?? file;
    const result = load(file);
    if (result === undefined) {
      ok = false;
      rows.push(`| ${label} | no result file | - | - | - | - |`);
      continue;
    }
    // A suite that failed to load/compile has no failed assertions, so success must come from jest.
    if (!result.success) ok = false;
    rows.push(
      `| ${label} | ${result.success ? 'passed' : '**FAILED**'} | ${result.numTotalTestSuites} | ` +
        `${result.numFailedTestSuites} | ${result.numPassedTests}/${result.numTotalTests} | ${result.numPendingTests} |`,
    );
    const failedSuites = result.testResults.filter((suite) => suite.status === 'failed');
    if (failedSuites.length > 0) {
      details.push(`#### ${label}`);
      for (const suite of failedSuites) {
        const failedTests = suite.assertionResults.filter((test) => test.status === 'failed');
        details.push(`- \`${suite.name.replace(process.cwd(), '.')}\``);
        for (const test of failedTests.slice(0, MAX_FAILED_LISTED))
          details.push(`  - ${test.fullName}`);
        if (failedTests.length === 0)
          details.push('  - suite failed before any test ran (see the log artifact)');
      }
    }
  }

  console.log('### E2E results');
  console.log('');
  console.log('| Shard | Result | Suites | Failed suites | Tests passed | Skipped |');
  console.log('|---|---|---|---|---|---|');
  for (const row of rows) console.log(row);
  if (details.length > 0) {
    console.log('');
    console.log('#### Failed suites and tests');
    for (const line of details) console.log(line);
  }
  process.exit(ok || reportOnly ? 0 : 1);
}

main();
