import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Every TypeORM entity must live in an `entities/` directory.
 *
 * The CLI data source (`src/data-source.ts`: migrations, prelaunch reset, staging seed) and the e2e
 * schema builder (`test/global-setup-e2e.ts`) discover entities with the glob
 * `**\/entities/*.entity.ts`, while the Nest app uses `autoLoadEntities`. An entity outside that
 * folder works in the app but is invisible to the other two: its table is never created for e2e
 * (every suite then fails in `resetDatabase`), and the prelaunch reset rejects it as unclassified.
 */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

describe('entity file location', () => {
  it('keeps every @Entity class in an entities/ directory matching *.entity.ts', () => {
    const root = join(__dirname, '..');
    const misplaced = walk(root)
      .filter((file) => /@Entity\(/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file))
      .filter((file) => !file.split(sep).includes('entities') || !file.endsWith('.entity.ts'));

    expect(misplaced).toEqual([]);
  });
});
