import { runPrelaunchReset } from './prelaunch-reset';

const dryRun = process.argv.includes('--dry-run');
const verify = process.argv.includes('--verify');
const skipExternal = process.argv.includes('--skip-external');

if (dryRun && verify) {
  throw new Error('--dry-run and --verify are mutually exclusive.');
}

void runPrelaunchReset({ dryRun, verify, skipExternal }).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
