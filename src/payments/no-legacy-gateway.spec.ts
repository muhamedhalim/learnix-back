import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Paymob was retired as an integration. Historical rows may still carry
 * `provider = 'paymob'`, and the legacy `paymob_*` columns still exist in the
 * database, but no active source file may reference the gateway. Migrations
 * are history and are exempt.
 */
const SRC_ROOT = join(__dirname, '..');
const ALLOWED = [`${sep}migrations${sep}`, `${sep}payments${sep}no-legacy-gateway.spec.ts`];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('retired payment gateway', () => {
  it('has no active Paymob references in application source', () => {
    const offenders = walk(SRC_ROOT)
      .filter((file) => !ALLOWED.some((fragment) => file.includes(fragment)))
      .filter((file) => /paymob/iu.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC_ROOT, file));
    expect(offenders).toEqual([]);
  });
});
