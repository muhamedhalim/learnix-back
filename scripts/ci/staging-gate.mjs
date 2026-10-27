// The verdict of the "A manual production deploy needs a green staging deploy of the same code" step of the
// `gates` job in .github/workflows/ci-cd.yml.
//
// A push to main deploys staging and production in ONE run (production `needs` the staging job), so this gate
// is only for a manual production dispatch, whose run has no staging job. Production may only receive a tree (the
// file contents of a commit) that AWS staging has already rolled out; the comparison is on the tree, so a
// docs-only or re-created commit of the same code is still recognised.
//
// A run counts as proof only when ALL of these hold:
//   * it is a `push` run of ci-cd.yml on `main` that finished `success`,
//   * the tree of its head commit equals the tree being promoted, and
//   * its staging rollout job (`Deploy staging / Build, migrate and roll out (AWS)`) finished `success`.
// The last point matters: a run whose staging rollout was skipped or failed can still be partly green. A green run is proof the checks passed, NOT that staging was deployed.
//
// Input (environment):
//   GITHUB_SHA     the commit being promoted
//   REPOSITORY     owner/name
//   GH_TOKEN       read by the `gh` CLI (needs actions:read)
//
// Fails closed: an API error, an unreadable commit or a malformed response is a failure, never a pass.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const WORKFLOW_FILE = 'ci-cd.yml';
export const STAGING_BRANCH = 'main';
// The API names a called reusable-workflow job "<caller job name> / <called job name>": `name:` of the
// `deploy-staging` job in ci-cd.yml, then of the `deploy` job in deploy-aws.yml (staging-gate.test.mjs enforces both).
export const DEPLOY_JOB_NAME = 'Deploy staging / Build, migrate and roll out (AWS)';
const MAX_PAGES = 10;
const PER_PAGE = 100;

/**
 * @param {object} input
 * @param {string} input.wantTree tree id of the commit being promoted
 * @param {Array<{id: number, head_sha: string, head_branch?: string, event?: string, conclusion?: string}>} input.runs
 *   candidate runs, newest first
 * @param {(sha: string) => string | undefined} input.treeOf tree id of a commit, undefined when unreadable
 * @param {(runId: number) => string | undefined} input.deployConclusionOf conclusion of the deploy job of a run
 */
export function findVerifiedStagingRun({ wantTree, runs, treeOf, deployConclusionOf }) {
  const rejected = [];
  if (!/^[0-9a-f]{40}$/u.test(wantTree ?? '')) {
    return { ok: false, rejected, reason: `invalid tree id '${String(wantTree)}'` };
  }
  for (const run of runs) {
    const label = `run ${String(run.id)} (${String(run.head_sha).slice(0, 7)})`;
    if (
      run.head_branch !== STAGING_BRANCH ||
      run.event !== 'push' ||
      run.conclusion !== 'success'
    ) {
      rejected.push(`${label}: not a successful push run on ${STAGING_BRANCH}`);
      continue;
    }
    if (treeOf(run.head_sha) !== wantTree) continue;
    const deploy = deployConclusionOf(run.id);
    if (deploy !== 'success') {
      rejected.push(
        `${label}: same tree, but its '${DEPLOY_JOB_NAME}' job is '${deploy ?? 'missing'}', so staging was not deployed`,
      );
      continue;
    }
    return { ok: true, run, rejected };
  }
  return { ok: false, rejected, reason: 'no successful staging deploy of this tree' };
}

const gh = (path) =>
  JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));

const git = (args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function listRuns(repository) {
  const runs = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const query = `branch=${STAGING_BRANCH}&event=push&status=success&per_page=${String(PER_PAGE)}&page=${String(page)}`;
    const body = gh(`repos/${repository}/actions/workflows/${WORKFLOW_FILE}/runs?${query}`);
    if (!Array.isArray(body.workflow_runs))
      throw new Error('unexpected response from the runs API');
    runs.push(...body.workflow_runs);
    if (body.workflow_runs.length < PER_PAGE) break;
  }
  return runs;
}

export function run(env = process.env) {
  const repository = env.REPOSITORY ?? '';
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository)) {
    console.log('::error::staging gate: REPOSITORY is not set to owner/name.');
    return 1;
  }
  let wantTree;
  let outcome;
  try {
    wantTree = git(['rev-parse', `${env.GITHUB_SHA ?? 'HEAD'}^{tree}`]);
    git(['fetch', '--quiet', 'origin', STAGING_BRANCH]);
    outcome = findVerifiedStagingRun({
      wantTree,
      runs: listRuns(repository),
      treeOf: (sha) => {
        try {
          return git(['rev-parse', `${sha}^{tree}`]);
        } catch {
          return undefined; // commit no longer reachable (force-push): cannot prove anything from it
        }
      },
      deployConclusionOf: (runId) => {
        const jobs = gh(`repos/${repository}/actions/runs/${String(runId)}/jobs?per_page=100`).jobs;
        return jobs?.find((job) => job.name === DEPLOY_JOB_NAME)?.conclusion ?? undefined;
      },
    });
  } catch (error) {
    console.log(
      `::error::staging gate: could not verify staging (${String(error.message)}). Failing closed.`,
    );
    return 1;
  }

  for (const line of outcome.rejected) console.log(`note: ${line}`);
  if (outcome.ok) {
    console.log(
      `Staging deployed this exact tree (${wantTree}) in run ${String(outcome.run.id)} for ${outcome.run.head_sha}.`,
    );
    return 0;
  }
  console.log(
    `::error::No successful staging deploy of this code (tree ${wantTree}). Push it to main and let the pipeline deploy staging first.`,
  );
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(run());
}
