// Prettier on exactly the files a change touches — the same scope the CI `format-check` job gates.
//
// `prettier --check .` over the whole repository still fails on files that predate that gate, so CI
// (and this script) look only at what the branch changed: commits since the merge-base with the base
// branch, plus uncommitted and untracked work. Run it before pushing, so a formatting failure shows up
// locally instead of as a red PR check.
//
// USAGE:
//   npm run format:changed            # check, exits 1 when a changed file is not formatted
//   npm run format:changed -- --write # reformat the changed files in place
//   npm run format:changed -- --base origin/develop
//
// Git is invoked without a shell, so file names are never interpreted (spaces, `;`, `$(...)` are inert).

import { execFileSync } from 'node:child_process';

const PATHSPEC = ['*.ts', '*.tsx', '*.js', '*.jsx', '*.json', '*.md'];
const EXTENSIONS = /\.(?:ts|tsx|js|jsx|json|md)$/u;

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function lines(output: string): string[] {
  return output.split('\n').filter((line) => line !== '');
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function mergeBase(base: string): string {
  try {
    return git(['merge-base', 'HEAD', base]).trim();
  } catch {
    // No such ref (fresh clone without the base branch): fall back to the previous commit.
    return git(['rev-parse', 'HEAD~1']).trim();
  }
}

const base = mergeBase(argValue('--base') ?? 'origin/main');
const changed = new Set<string>([
  ...lines(git(['diff', '--name-only', '--diff-filter=ACMR', base, '--', ...PATHSPEC])),
  ...lines(git(['ls-files', '--others', '--exclude-standard'])).filter((file) =>
    EXTENSIONS.test(file),
  ),
]);

if (changed.size === 0) {
  console.log('No changed files to format.');
  process.exit(0);
}

const prettierBin = require.resolve('prettier/bin/prettier.cjs');
const mode = process.argv.includes('--write') ? '--write' : '--check';
console.log(
  `prettier ${mode} on ${String(changed.size)} changed file(s) since ${base.slice(0, 7)}`,
);

try {
  execFileSync(process.execPath, [prettierBin, mode, '--ignore-unknown', ...changed], {
    stdio: 'inherit',
  });
} catch {
  process.exit(1);
}
