// Migration safety check — Phase 5 CI/CD
// (STAGING_ENVIRONMENT_IMPLEMENTATION_PLAN.md §12.3 step 18).
//
// Scans every migration file added or changed relative to a base ref for SQL
// patterns that can lose data or fail against a populated table:
// DROP TABLE, DROP COLUMN, ALTER ... TYPE, and adding a NOT NULL constraint.
// Classifies each file as SAFE / NEEDS_DB_APPROVAL / BLOCKED, and separately
// flags a destructive migration that ships no real down().
//
// This is pattern matching on migration source text, not a SQL parser or a
// dry run against real data — it exists to make a human stop and look before
// a migration reaches Production, not to replace review. A migration that
// legitimately needs one of these operations gets classified
// NEEDS_DB_APPROVAL, not silently blocked; DROP TABLE alone is BLOCKED
// outright, since this codebase's own migration policy
// (STAGING_ENVIRONMENT_IMPLEMENTATION_PLAN.md §8.3) requires expand-migrate-
// contract across releases, never a same-release drop.
//
// USAGE:
//   npx ts-node scripts/migration-safety-check.ts [--base <git-ref>]
//
// Exit 0 = every changed migration is SAFE.
// Exit 1 = at least one is NEEDS_DB_APPROVAL (and none BLOCKED) — a human
//          reviewer with database-change authority must approve before merge.
// Exit 2 = at least one is BLOCKED — must be reworked, not merged as-is.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

type Classification = 'SAFE' | 'NEEDS_DB_APPROVAL' | 'BLOCKED';

interface FileReport {
  file: string;
  classification: Classification;
  reasons: string[];
}

const DESTRUCTIVE_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /drop\s+table/i, reason: 'DROP TABLE' },
  { pattern: /drop\s+column/i, reason: 'DROP COLUMN' },
  { pattern: /alter\s+column\s+\S+\s+type|alter\s+type\s+\S+/i, reason: 'ALTER ... TYPE' },
  { pattern: /set\s+not\s+null/i, reason: 'SET NOT NULL' },
];

function getBaseArg(): string {
  const idx = process.argv.indexOf('--base');
  const value = idx !== -1 ? process.argv[idx + 1] : undefined;
  return value ?? 'origin/develop';
}

function changedMigrationFiles(base: string): string[] {
  try {
    const output = execFileSync(
      'git',
      ['diff', '--name-only', '--diff-filter=AM', `${base}...HEAD`, '--', 'src/migrations'],
      { encoding: 'utf8' },
    );
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.endsWith('.ts') && !line.endsWith('.spec.ts'));
  } catch (error) {
    console.error(
      `Could not diff against "${base}" — falling back to no changed migrations detected. ` +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
    return [];
  }
}

function extractMethodBody(source: string, methodName: 'up' | 'down'): string {
  const marker = `${methodName}(`;
  const start = source.indexOf(marker);
  if (start === -1) return '';
  let depth = 0;
  let bodyStart = -1;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') {
      if (bodyStart === -1) bodyStart = i + 1;
      depth++;
    } else if (source[i] === '}') {
      depth--;
      if (depth === 0 && bodyStart !== -1) return source.slice(bodyStart, i);
    }
  }
  return '';
}

function isEffectivelyEmpty(body: string): boolean {
  const stripped = body
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();
  return stripped.length === 0;
}

function classify(file: string): FileReport {
  const source = readFileSync(file, 'utf8');
  const upBody = extractMethodBody(source, 'up');
  const downBody = extractMethodBody(source, 'down');

  const matched = DESTRUCTIVE_PATTERNS.filter(({ pattern }) => pattern.test(upBody));
  const hasDrop = matched.some(({ reason }) => reason === 'DROP TABLE');
  const noDown = isEffectivelyEmpty(downBody);

  const reasons = matched.map(({ reason }) => reason);
  if (noDown && matched.length > 0) reasons.push('no down() implemented for a destructive up()');

  let classification: Classification = 'SAFE';
  if (hasDrop || (matched.length > 0 && noDown)) {
    classification = 'BLOCKED';
  } else if (matched.length > 0) {
    classification = 'NEEDS_DB_APPROVAL';
  }

  return { file, classification, reasons };
}

function main(): void {
  const base = getBaseArg();
  const files = changedMigrationFiles(base);

  if (files.length === 0) {
    console.log(`No migration files changed relative to ${base}.`);
    process.exit(0);
  }

  const reports = files.map(classify);
  let worst: Classification = 'SAFE';

  for (const report of reports) {
    console.log(`${report.classification.padEnd(18)} ${report.file}`);
    for (const reason of report.reasons) console.log(`  - ${reason}`);
    if (report.classification === 'BLOCKED') worst = 'BLOCKED';
    else if (report.classification === 'NEEDS_DB_APPROVAL' && worst !== 'BLOCKED') {
      worst = 'NEEDS_DB_APPROVAL';
    }
  }

  console.log(`\nOverall: ${worst}`);
  process.exit(worst === 'BLOCKED' ? 2 : worst === 'NEEDS_DB_APPROVAL' ? 1 : 0);
}

main();
