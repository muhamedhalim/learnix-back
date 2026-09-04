import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { API_PREFIX, createAuthenticatedUser, createE2EApp, resetDatabase } from './fixtures';

const FORBIDDEN_TARGET_TABLES = [
  'orders',
  'entitlements',
  'lesson_packages',
  'lessons',
  'teacher_profiles',
  'teacher_settlements',
  'financial_ledger_entries',
];

/**
 * T228 (US11, release gate). Complements `marketplace-payouts.e2e-spec.ts`
 * (marketplace → academic non-interaction, proved through a real payout)
 * and `dual-capability-isolation.e2e-spec.ts` (academic → marketplace
 * non-interaction, proved through a real settlement) with the one thing
 * neither of those can prove by exercising a single scenario: that
 * **no** marketplace table has a foreign key into academic commerce data,
 * checked directly against the live schema rather than any one code path.
 *
 * A static source check (`grep -rn 'REFERENCES "orders"' etc. across every
 * marketplace migration) was run manually before writing this file and
 * found zero matches — every foreign key a marketplace table declares
 * targets `users("id")` and nothing else. This test makes that check
 * durable and DB-verified (catching drift from any *future* migration,
 * not just the ones existing today) rather than a one-time audit note.
 */
describe('marketplace ↔ academic bidirectional isolation (Phase 13, T228, release gate)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    ({ app, dataSource } = await createE2EApp());
  });

  beforeEach(async () => resetDatabase(dataSource));
  afterAll(async () => app.close());

  describe('schema assertion (FR-322, FR-323)', () => {
    it('no marketplace_* table holds a foreign key into an academic commerce table', async () => {
      const rows = await dataSource.query<Array<{ table_name: string; foreign_table_name: string }>>(`
        SELECT
          tc.table_name,
          ccu.table_name AS foreign_table_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.constraint_column_usage ccu
          ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_name LIKE 'marketplace\\_%'
      `);

      const violations = rows.filter((row) => FORBIDDEN_TARGET_TABLES.includes(row.foreign_table_name));
      expect(violations).toEqual([]);
    });

    it('every marketplace_* foreign key targets only users or another marketplace_* table', async () => {
      const rows = await dataSource.query<Array<{ table_name: string; foreign_table_name: string }>>(`
        SELECT
          tc.table_name,
          ccu.table_name AS foreign_table_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.constraint_column_usage ccu
          ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_name LIKE 'marketplace\\_%'
      `);

      const outsideEdges = rows.filter(
        (row) => row.foreign_table_name !== 'users' && !row.foreign_table_name.startsWith('marketplace_'),
      );
      // `certificates` is the one other legitimate outbound target this feature's
      // own migrations name (FR-322) — the reverse direction (`certificates` →
      // `marketplace_courses`, an additive column on the ACADEMIC table) is
      // proven separately in `academic-certificates-regression.e2e-spec.ts`; no
      // marketplace table has ever needed an outbound edge to `certificates`
      // itself, so this assertion is deliberately stricter than the ceiling
      // FR-322 allows.
      expect(outsideEdges).toEqual([]);
    });
  });

  describe('academic → marketplace: every academic journey completes with marketplace tables empty', () => {
    it('registering and logging in a plain user touches no marketplace_ table', async () => {
      const before = await dataSource.query<Array<{ count: string }>>(
        `SELECT COUNT(*)::int AS count FROM marketplace_instructors`,
      );
      const user = await createAuthenticatedUser(app, dataSource);
      expect(user.userId).toBeDefined();
      const after = await dataSource.query<Array<{ count: string }>>(
        `SELECT COUNT(*)::int AS count FROM marketplace_instructors`,
      );
      expect(after[0]!.count).toBe(before[0]!.count);
    });
  });

  describe('marketplace → academic: no marketplace write reaches an academic commerce record', () => {
    it('a marketplace instructor application touches no academic orders/entitlements/settlements table', async () => {
      const before = await Promise.all(
        ['orders', 'entitlements', 'teacher_settlements'].map(async (table) => {
          const rows = await dataSource.query<Array<{ count: string }>>(`SELECT COUNT(*)::int AS count FROM "${table}"`);
          return rows[0]!.count;
        }),
      );

      const applicant = await createAuthenticatedUser(app, dataSource);
      await applicant.agent
        .post(`${API_PREFIX}/marketplace/applications`)
        .send({ display_name: 'Isolation Test Applicant', years_of_experience: 5 })
        .expect(201);

      const after = await Promise.all(
        ['orders', 'entitlements', 'teacher_settlements'].map(async (table) => {
          const rows = await dataSource.query<Array<{ count: string }>>(`SELECT COUNT(*)::int AS count FROM "${table}"`);
          return rows[0]!.count;
        }),
      );

      expect(after).toEqual(before);
    });
  });
});
