// The verdict of the `ci-gate` job in .github/workflows/ci-cd.yml.
//
// Input (environment):
//   NEEDS_JSON      ${{ toJSON(needs) }}: { "<job>": { "result": "success|failure|cancelled|skipped", ... } }
//   REQUIRED_JOBS   space-separated job ids that must have a result
//   ALLOW_SKIPPED   space-separated job ids whose `skipped` counts as success (default: none)
//
// Fails closed. The gate passes only when:
//   * it was given results at all (an empty or malformed list is a failure, never a pass),
//   * every REQUIRED job is present in `needs` (a job dropped from `needs:` cannot go unnoticed), and
//   * every job in `needs` finished `success`, or `skipped` where ALLOW_SKIPPED explicitly says so.
// `failure` (a step or assertion failed) is reported separately from `cancelled` / `skipped` /
// timed-out jobs (the work did not complete), because the remedy differs.
//
// No dependencies: the gate job has no checkout and no `npm ci`.

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const words = (value) => (value ?? '').split(/\s+/u).filter((word) => word !== '');

export function evaluate({ needs, required, allowSkipped = [] }) {
  const problems = [];
  const rows = [];

  if (needs === null || typeof needs !== 'object' || Array.isArray(needs)) {
    return {
      ok: false,
      rows,
      failed: [],
      incomplete: [],
      problems: ['no job results were provided to the gate'],
    };
  }
  if (Object.keys(needs).length === 0) {
    problems.push('the list of job results is empty');
  }
  if (required.length === 0) {
    problems.push('the gate was configured without any required job');
  }

  const failed = [];
  const incomplete = [];

  for (const job of required) {
    if (!(job in needs)) problems.push(`required job '${job}' has no result (missing from needs)`);
  }

  for (const [job, value] of Object.entries(needs)) {
    const result = value !== null && typeof value === 'object' ? value.result : undefined;
    rows.push({ job, result: result ?? '(none)' });
    if (result === 'success') continue;
    if (result === 'skipped' && allowSkipped.includes(job)) continue;
    if (result === 'failure') failed.push(job);
    else incomplete.push(`${job} (${result ?? 'no result'})`);
  }

  const ok = problems.length === 0 && failed.length === 0 && incomplete.length === 0;
  return { ok, rows, failed, incomplete, problems };
}

function report(outcome) {
  const lines = ['### CI gate', '', '| Job | Result |', '|---|---|'];
  for (const { job, result } of outcome.rows) lines.push(`| ${job} | ${result} |`);
  for (const problem of outcome.problems) lines.push('', `**${problem}**`);
  return lines.join('\n');
}

export function run(env = process.env) {
  let needs;
  try {
    needs = JSON.parse(env.NEEDS_JSON ?? '');
  } catch {
    needs = undefined;
  }
  const outcome = evaluate({
    needs,
    required: words(env.REQUIRED_JOBS),
    allowSkipped: words(env.ALLOW_SKIPPED),
  });

  const summary = report(outcome);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  console.log(summary);

  if (outcome.ok) {
    console.log('\nAll validation jobs succeeded.');
    return 0;
  }
  if (outcome.failed.length > 0) {
    console.log(
      `::error::CI gate: required job(s) FAILED: ${outcome.failed.join(', ')}. Nothing is released from this run.`,
    );
  }
  if (outcome.incomplete.length > 0) {
    console.log(
      `::error::CI gate: required job(s) did not complete successfully (cancelled, skipped, timed out or no result): ${outcome.incomplete.join(', ')}. Nothing is released from this run.`,
    );
  }
  for (const problem of outcome.problems) console.log(`::error::CI gate: ${problem}.`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(run());
}
