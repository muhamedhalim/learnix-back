/**
 * Advisory-locked migration CLI — Phase 2 (Database and Redis).
 *
 * `npm run migration:run:prod` (the command `nixpacks.toml`/`Procfile` run
 * before `node dist/src/main.js` starts) invokes this file's `run` command
 * instead of the raw `typeorm migration:run` CLI, so the one migration
 * invocation that can actually race across two concurrently-deploying
 * replicas is now serialised by `migration-lock.util.ts`'s advisory lock.
 * `main.ts`'s in-app `runPendingMigrations()` safety net uses the same
 * exported lock utility directly, so both paths coordinate through the
 * identical lock.
 *
 * Commands: `status` (read-only, no lock — never blocks behind a concurrent
 * run/revert), `run`, `revert` (both lock-protected).
 */

import { AppDataSource } from '../data-source';
import { ensureAppRole, readAppRoleConfig, resolveDatabaseName } from './app-role.util';
import { withMigrationAdvisoryLock } from './migration-lock.util';

type Command = 'status' | 'run' | 'revert';

function isCommand(value: string | undefined): value is Command {
  return value === 'status' || value === 'run' || value === 'revert';
}

async function runStatus(): Promise<number> {
  const pending = await AppDataSource.showMigrations();
  const executed = (await AppDataSource.query(
    'SELECT name FROM migrations ORDER BY timestamp',
  )) as Array<{ name: string }>;

  console.log(`Applied migrations: ${executed.length.toString()}`);
  for (const row of executed) console.log(`  - ${row.name}`);
  console.log(pending ? 'PENDING migrations detected.' : 'No pending migrations.');

  return pending ? 1 : 0;
}

async function runMigrate(): Promise<number> {
  const executed = await withMigrationAdvisoryLock(
    AppDataSource,
    () => AppDataSource.runMigrations(),
    (message) => console.log(message),
  );
  console.log(
    executed.length > 0
      ? `Applied ${executed.length.toString()} migration(s): ${executed.map((m) => m.name).join(', ')}`
      : 'No pending migrations to apply.',
  );
  // Runs as the master user, after the schema is current, so the grants cover every table.
  const appRole = readAppRoleConfig(
    process.env,
    resolveDatabaseName(
      typeof AppDataSource.options.database === 'string'
        ? AppDataSource.options.database
        : undefined,
      process.env,
    ),
  );
  if (appRole) await ensureAppRole(AppDataSource, appRole, (message) => console.log(message));
  return 0;
}

async function runRevert(): Promise<number> {
  await withMigrationAdvisoryLock(
    AppDataSource,
    () => AppDataSource.undoLastMigration(),
    (message) => console.log(message),
  );
  console.log('Reverted the most recent migration.');
  return 0;
}

async function main(): Promise<number> {
  const command = process.argv[2];
  if (!isCommand(command)) {
    console.error(`Usage: migrate-cli <status|run|revert>. Received: "${command ?? ''}"`);
    return 1;
  }

  await AppDataSource.initialize();
  try {
    switch (command) {
      case 'status': {
        return await runStatus();
      }
      case 'run': {
        return await runMigrate();
      }
      case 'revert': {
        return await runRevert();
      }
    }
  } finally {
    await AppDataSource.destroy();
  }
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    console.error('Migration command failed:', error);
    process.exitCode = 1;
  });
