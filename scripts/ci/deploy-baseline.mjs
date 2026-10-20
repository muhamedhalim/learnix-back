// The commit an AWS environment last received from this workflow: the baseline the `control` job of
// .github/workflows/ci-cd.yml diffs a push against to decide whether the image changed.
//
// Diffing against the push's `before` was wrong: when the deploy of `before` never happened (failed gate,
// skipped job, billing), a follow-up push with no app change was skipped as "nothing to deploy" and the run
// went green while the environment kept serving an older release. The baseline is therefore the newest
// GitHub deployment of the environment (created by the `deploy` / `rollback` jobs, which run in that
// environment) whose latest status is `success`.
//
// Input (environment):
//   TARGET         staging | production
//   REPOSITORY     owner/name
//   GH_TOKEN       read by the `gh` CLI (needs deployments:read)
//
// Output (stdout): the baseline commit SHA, or nothing when there is none. Never fails the job: on any API
// error it prints nothing, so the push is treated as an app change and deploys (fail towards deploying, never
// towards a silent skip). Tests: scripts/ci/tests/deploy-baseline.test.mjs.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const PER_PAGE = 30;

/**
 * @param {object} input
 * @param {Array<{id: number, sha: string, environment?: string}>} input.deployments newest first
 * @param {string} input.environment
 * @param {(deploymentId: number) => string | undefined} input.latestStateOf state of the newest status
 * @returns {string | undefined}
 */
export function findDeployedBaseline({ deployments, environment, latestStateOf }) {
  for (const deployment of deployments) {
    if (deployment.environment !== environment) continue;
    if (!/^[0-9a-f]{40}$/u.test(deployment.sha ?? '')) continue;
    if (latestStateOf(deployment.id) === 'success') return deployment.sha;
  }
  return undefined;
}

const gh = (path) =>
  JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));

export function run(env = process.env, api = gh) {
  const repository = env.REPOSITORY ?? '';
  const environment = env.TARGET ?? '';
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository) || !/^(staging|production)$/u.test(environment)) {
    console.error(
      '::warning::deploy baseline: REPOSITORY or TARGET is not set; treating the push as a change.',
    );
    return '';
  }
  try {
    const deployments = api(
      `repos/${repository}/deployments?environment=${environment}&per_page=${String(PER_PAGE)}`,
    );
    if (!Array.isArray(deployments))
      throw new Error('unexpected response from the deployments API');
    return (
      findDeployedBaseline({
        deployments,
        environment,
        latestStateOf: (id) => {
          const statuses = api(`repos/${repository}/deployments/${String(id)}/statuses?per_page=1`);
          return Array.isArray(statuses) ? statuses[0]?.state : undefined;
        },
      }) ?? ''
    );
  } catch (error) {
    console.error(
      `::warning::deploy baseline: could not read deployments (${String(error.message)}); treating the push as a change.`,
    );
    return '';
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(run());
}
