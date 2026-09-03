import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { FINANCE_PERMISSIONS } from '../../src/payments/finance-permissions';
import { User } from '../../src/users/entities';
import { API_PREFIX, createAuthenticatedUser, createE2EApp, resetDatabase } from './fixtures';

/**
 * T185. Contracts §5's admin console, authorization only — no business
 * outcome is asserted here (each route's actual effect is proven in its
 * own suite: refunds/payouts already have Phase 9/11 e2e coverage; this
 * suite's own focus is the four NEW T192 controllers plus a
 * permission-isolation proof reusable as the template for any future
 * admin route). A non-admin is refused everywhere; a bare admin (role
 * `admin`, zero finance permissions) is refused on every `Finance`-gated
 * route but allowed through plain `@Roles('admin')` routes; a single
 * finance permission unlocks only the route(s) actually gated by it, never
 * a sibling permission's route.
 */
describe('marketplace admin console — authorization matrix (Phase 12, T185)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    ({ app, dataSource } = await createE2EApp());
  });

  beforeEach(async () => resetDatabase(dataSource));
  afterAll(async () => app.close());

  async function grantOnly(adminId: string, permissions: string[]) {
    await dataSource.getRepository(User).update({ id: adminId }, { finance_permissions: permissions as never });
  }

  async function grantAll(adminId: string) {
    await grantOnly(adminId, [...FINANCE_PERMISSIONS]);
  }

  describe('non-admin refused on every route (403)', () => {
    it('refused on every GET route', async () => {
      const learner = await createAuthenticatedUser(app, dataSource);
      for (const path of [
        `${API_PREFIX}/marketplace/admin/overview`,
        `${API_PREFIX}/marketplace/admin/instructors`,
        `${API_PREFIX}/marketplace/admin/sales?currency=EGP`,
        `${API_PREFIX}/marketplace/admin/commission`,
        `${API_PREFIX}/marketplace/admin/ledger`,
        `${API_PREFIX}/marketplace/admin/reconciliation`,
      ]) {
        await learner.agent.get(path).expect(403);
      }
    });

    it('refused on every POST route', async () => {
      const learner = await createAuthenticatedUser(app, dataSource);
      await learner.agent
        .post(`${API_PREFIX}/marketplace/admin/instructors/00000000-0000-4000-8000-000000000000/suspend`)
        .send({ reason: 'test' })
        .expect(403);
      await learner.agent.post(`${API_PREFIX}/marketplace/admin/ledger/adjustments`).send({}).expect(403);
    });
  });

  describe('a bare admin (no finance permissions) is refused on every Finance-gated route', () => {
    it.each([
      ['GET', `${API_PREFIX}/marketplace/admin/sales?currency=EGP`],
      ['GET', `${API_PREFIX}/marketplace/admin/commission`],
      ['GET', `${API_PREFIX}/marketplace/admin/ledger`],
      ['GET', `${API_PREFIX}/marketplace/admin/reconciliation`],
      ['GET', `${API_PREFIX}/marketplace/admin/exports/sales?currency=EGP`],
      ['GET', `${API_PREFIX}/marketplace/admin/payouts`],
      ['GET', `${API_PREFIX}/marketplace/admin/refunds`],
    ])('%s %s', async (_method, path) => {
      const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
      await grantOnly(admin.userId, []);
      await admin.agent.get(path).expect(403);
    });

    it('is still allowed through the plain @Roles("admin") overview and instructor-roster routes', async () => {
      const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
      await grantOnly(admin.userId, []);

      await admin.agent.get(`${API_PREFIX}/marketplace/admin/overview`).expect(200);
      await admin.agent.get(`${API_PREFIX}/marketplace/admin/instructors`).expect(200);
    });
  });

  describe('permission isolation — one permission unlocks only its own route(s)', () => {
    it('marketplace.reports.view unlocks sales/ledger/reconciliation but not commission or exports', async () => {
      const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
      await grantOnly(admin.userId, ['marketplace.reports.view']);

      await admin.agent.get(`${API_PREFIX}/marketplace/admin/sales?currency=EGP`).expect(200);
      await admin.agent.get(`${API_PREFIX}/marketplace/admin/ledger`).expect(200);
      await admin.agent.get(`${API_PREFIX}/marketplace/admin/reconciliation`).expect(200);

      await admin.agent.get(`${API_PREFIX}/marketplace/admin/commission`).expect(403);
      await admin.agent.get(`${API_PREFIX}/marketplace/admin/exports/sales?currency=EGP`).expect(403);
    });

    it('marketplace.reports.export unlocks exports but not sales/ledger/commission', async () => {
      const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
      await grantOnly(admin.userId, ['marketplace.reports.export']);

      await admin.agent.get(`${API_PREFIX}/marketplace/admin/exports/sales?currency=EGP`).expect(200);

      await admin.agent.get(`${API_PREFIX}/marketplace/admin/sales?currency=EGP`).expect(403);
      await admin.agent.get(`${API_PREFIX}/marketplace/admin/ledger`).expect(403);
      await admin.agent.get(`${API_PREFIX}/marketplace/admin/commission`).expect(403);
    });

    it('marketplace.commission.manage unlocks commission GET/PUT but not sales/ledger/exports', async () => {
      const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
      await grantOnly(admin.userId, ['marketplace.commission.manage']);

      await admin.agent.get(`${API_PREFIX}/marketplace/admin/commission`).expect(200);

      await admin.agent.get(`${API_PREFIX}/marketplace/admin/sales?currency=EGP`).expect(403);
      await admin.agent.get(`${API_PREFIX}/marketplace/admin/ledger`).expect(403);
      await admin.agent.get(`${API_PREFIX}/marketplace/admin/exports/sales?currency=EGP`).expect(403);
    });

    it('marketplace.ledger.adjust unlocks the adjustment POST but not the ledger GET', async () => {
      const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
      await grantOnly(admin.userId, ['marketplace.ledger.adjust']);

      await admin.agent.get(`${API_PREFIX}/marketplace/admin/ledger`).expect(403);

      // Missing Idempotency-Key still 4xxs, but never with a permission-refusal (proves the guard let it through to validation).
      const res = await admin.agent.post(`${API_PREFIX}/marketplace/admin/ledger/adjustments`).send({
        instructorId: '00000000-0000-4000-8000-000000000000',
        currency: 'EGP',
        amountMinor: 1000,
        direction: 'credit',
        reason: 'Goodwill credit',
      });
      expect(res.status).not.toBe(403);
    });

    it('marketplace.payouts.view unlocks the payout queue but not payout approve/pay actions', async () => {
      const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
      await grantOnly(admin.userId, ['marketplace.payouts.view']);

      await admin.agent.get(`${API_PREFIX}/marketplace/admin/payouts`).expect(200);
      await admin.agent
        .post(`${API_PREFIX}/marketplace/admin/payouts/00000000-0000-4000-8000-000000000000/approve`)
        .send({})
        .expect(403);
    });
  });

  describe('a fully-privileged admin can reach every new T192 route', () => {
    it('overview, roster, sales, commission, ledger and reconciliation all 200', async () => {
      const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
      await grantAll(admin.userId);

      await admin.agent.get(`${API_PREFIX}/marketplace/admin/overview`).expect(200);
      await admin.agent.get(`${API_PREFIX}/marketplace/admin/instructors`).expect(200);
      await admin.agent.get(`${API_PREFIX}/marketplace/admin/sales?currency=EGP`).expect(200);
      await admin.agent.get(`${API_PREFIX}/marketplace/admin/commission`).expect(200);
      await admin.agent.get(`${API_PREFIX}/marketplace/admin/ledger`).expect(200);
      await admin.agent.get(`${API_PREFIX}/marketplace/admin/reconciliation`).expect(200);
      await admin.agent.get(`${API_PREFIX}/marketplace/admin/payouts/report?currency=EGP`).expect(200);
    });
  });
});
