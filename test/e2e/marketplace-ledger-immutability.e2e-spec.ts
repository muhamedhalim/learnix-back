import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { MarketplaceLedgerDirection, MarketplaceLedgerEntryType } from '../../src/marketplace/common/enums';
import { MarketplaceLedgerEntry } from '../../src/marketplace/earnings/entities/marketplace-ledger-entry.entity';
import { MarketplaceInstructor } from '../../src/marketplace/instructors/entities/marketplace-instructor.entity';
import { FINANCE_PERMISSIONS } from '../../src/payments/finance-permissions';
import { User } from '../../src/users/entities';
import { buildInstructorFixture, buildLedgerEntryFixture } from './factories/marketplace.factory';
import { API_PREFIX, createAuthenticatedUser, createE2EApp, resetDatabase } from './fixtures';

/**
 * T161. `TRG_mp_ledger_immutable` (migration 2096000000000) is the
 * database-level backstop for FR-162: a direct UPDATE or DELETE against
 * `marketplace_ledger_entries` must raise, regardless of which connection
 * or role issues it. FR-291's "viewable and filterable but not editable or
 * deletable through any interface" is proven the other way — the admin
 * ledger surface exposes GET only, so there is no PATCH/PUT/DELETE route
 * to even attempt.
 */
describe('marketplace ledger and audit-record immutability (Phase 11, T161)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    ({ app, dataSource } = await createE2EApp());
  });

  beforeEach(async () => resetDatabase(dataSource));
  afterAll(async () => app.close());

  async function seedInstructor(userId: string) {
    return dataSource.getRepository(MarketplaceInstructor).save(buildInstructorFixture({ user_id: userId }));
  }

  async function seedLedgerEntry(instructorId: string) {
    return dataSource.getRepository(MarketplaceLedgerEntry).save(
      buildLedgerEntryFixture({
        instructor_id: instructorId,
        entry_type: MarketplaceLedgerEntryType.COURSE_SALE,
        direction: MarketplaceLedgerDirection.CREDIT,
        amount_minor: 5000,
      }),
    );
  }

  describe('database-level immutability (FR-162)', () => {
    it('raises on a direct UPDATE', async () => {
      const instructorUser = await createAuthenticatedUser(app, dataSource);
      const instructor = await seedInstructor(instructorUser.userId);
      const entry = await seedLedgerEntry(instructor.id);

      await expect(
        dataSource.query(`UPDATE "marketplace_ledger_entries" SET "amount_minor" = 999999 WHERE "id" = $1`, [entry.id]),
      ).rejects.toThrow(/immutable/i);

      const unchanged = await dataSource.getRepository(MarketplaceLedgerEntry).findOneByOrFail({ id: entry.id });
      // `amount_minor` has no minorUnitsTransformer on this entity (unlike InstructorEarning/MarketplacePayoutRequest) — the pg driver returns bigint columns as strings.
      expect(Number(unchanged.amount_minor)).toBe(5000);
    });

    it('raises on a direct DELETE', async () => {
      const instructorUser = await createAuthenticatedUser(app, dataSource);
      const instructor = await seedInstructor(instructorUser.userId);
      const entry = await seedLedgerEntry(instructor.id);

      await expect(
        dataSource.query(`DELETE FROM "marketplace_ledger_entries" WHERE "id" = $1`, [entry.id]),
      ).rejects.toThrow(/immutable/i);

      const stillThere = await dataSource.getRepository(MarketplaceLedgerEntry).findOneBy({ id: entry.id });
      expect(stillThere).not.toBeNull();
    });
  });

  describe('application-level: viewable and filterable, never editable or deletable (FR-291)', () => {
    async function grantLedgerPermissions(adminId: string) {
      await dataSource.getRepository(User).update({ id: adminId }, { finance_permissions: [...FINANCE_PERMISSIONS] });
    }

    it('exposes no write route for ledger entries or audit records at all', async () => {
      const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
      await grantLedgerPermissions(admin.userId);
      const instructorUser = await createAuthenticatedUser(app, dataSource);
      const instructor = await seedInstructor(instructorUser.userId);
      const entry = await seedLedgerEntry(instructor.id);

      // No PATCH/PUT/DELETE route exists for a ledger entry or an audit log record under any known path shape.
      await admin.agent.patch(`${API_PREFIX}/marketplace/admin/ledger/${entry.id}`).send({}).expect(404);
      await admin.agent.delete(`${API_PREFIX}/marketplace/admin/ledger/${entry.id}`).expect(404);
      await admin.agent.patch(`${API_PREFIX}/admin/audit-log/${entry.id}`).send({}).expect(404);
      await admin.agent.delete(`${API_PREFIX}/admin/audit-log/${entry.id}`).expect(404);
    });

    it('the instructor ledger route stays read-only for the owning instructor too', async () => {
      const instructorUser = await createAuthenticatedUser(app, dataSource);
      const instructor = await seedInstructor(instructorUser.userId);
      const entry = await seedLedgerEntry(instructor.id);

      const listRes = await instructorUser.agent.get(`${API_PREFIX}/marketplace/instructor/ledger`).expect(200);
      const ids = (listRes.body.data as Array<{ id: string }>).map((row) => row.id);
      expect(ids).toContain(entry.id);

      await instructorUser.agent.patch(`${API_PREFIX}/marketplace/instructor/ledger/${entry.id}`).send({}).expect(404);
      await instructorUser.agent.delete(`${API_PREFIX}/marketplace/instructor/ledger/${entry.id}`).expect(404);
    });
  });
});
