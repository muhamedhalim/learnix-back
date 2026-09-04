import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { MarketplaceCategory, MarketplaceCourse } from '../../src/marketplace/catalog/entities';
import { MarketplaceEnrollment, MarketplaceOrder } from '../../src/marketplace/commerce/entities';
import {
  InstructorEarningStatus,
  LessonContentType,
  MarketplaceLedgerDirection,
  MarketplaceLedgerEntryType,
  PayoutRequestStatus,
} from '../../src/marketplace/common/enums';
import { ClearanceSweepService } from '../../src/marketplace/jobs/clearance.job';
import { InstructorEarning } from '../../src/marketplace/earnings/entities/instructor-earning.entity';
import { MarketplaceLedgerEntry } from '../../src/marketplace/earnings/entities/marketplace-ledger-entry.entity';
import { MarketplaceInstructor } from '../../src/marketplace/instructors/entities/marketplace-instructor.entity';
import { MarketplacePayoutRequest } from '../../src/marketplace/payouts/entities';
import { FINANCE_PERMISSIONS } from '../../src/payments/finance-permissions';
import { ItemType } from '../../src/payments/entities/item-type.enum';
import { Payment } from '../../src/payments/entities/payment.entity';
import { PaymentChannel } from '../../src/payments/entities/payment-channel.enum';
import { PaymentMethod } from '../../src/payments/entities/payment-method.enum';
import { PaymentStatus } from '../../src/payments/entities/payment-status.enum';
import type { ProviderWebhookEvent } from '../../src/payments/providers/payment-gateway.interface';
import { GatewayWebhookService } from '../../src/payments/services/gateway-webhook.service';
import { PaymentOperationsService } from '../../src/payments/services/payment-operations.service';
import { Settlement } from '../../src/payments/entities/settlement.entity';
import { SettlementStatus } from '../../src/payments/entities/settlement-status.enum';
import { User } from '../../src/users/entities';
import { buildInstructorFixture } from './factories/marketplace.factory';
import { API_PREFIX, createAuthenticatedUser, createE2EApp, resetDatabase } from './fixtures';

/**
 * Phase 11's independent test (tasks.md): earnings clear on schedule; a
 * payout request locks funds; an admin drives it to paid; every figure
 * reconciles to the ledger. Bundles T160 (full payout lifecycle,
 * concurrency, admin transitions, reversal, multi-currency) and T175
 * (academic/marketplace settlement separation for a dual-capability user)
 * in one suite, matching the task list's own grouping.
 */
describe('marketplace payouts — earn, clear, request, and settle (Phase 11)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let webhooks: GatewayWebhookService;
  let operations: PaymentOperationsService;
  let clearanceSweep: ClearanceSweepService;

  beforeAll(async () => {
    ({ app, dataSource } = await createE2EApp());
    webhooks = app.get(GatewayWebhookService);
    operations = app.get(PaymentOperationsService);
    clearanceSweep = app.get(ClearanceSweepService);
  });

  beforeEach(async () => resetDatabase(dataSource));
  afterAll(async () => app.close());

  async function seedInstructor(userId: string) {
    return dataSource
      .getRepository(MarketplaceInstructor)
      .save(buildInstructorFixture({ user_id: userId }));
  }

  async function seedCategory() {
    return dataSource.getRepository(MarketplaceCategory).save({
      name_en: 'Programming',
      name_ar: 'البرمجة',
      slug: `programming-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      display_order: 1,
    });
  }

  async function publishCourse(opts: {
    instructorAgent: Awaited<ReturnType<typeof createAuthenticatedUser>>['agent'];
    adminAgent: Awaited<ReturnType<typeof createAuthenticatedUser>>['agent'];
    categoryId: string;
    priceMinor?: number;
    currency?: string;
  }) {
    const created = await opts.instructorAgent
      .post(`${API_PREFIX}/marketplace/instructor/courses`)
      .send({
        title: `Payout Flow Course ${Date.now()}-${Math.random().toString(36).slice(2)}`,
        summary: 'Learn payout-relevant things',
        description: 'A full description of the course content.',
        category_id: opts.categoryId,
        level: 'beginner',
        language: 'en',
        price_minor: opts.priceMinor ?? 200000,
        currency: opts.currency ?? 'EGP',
        cover_image_key: 'covers/payouts-101.jpg',
        learning_outcomes: ['Understand payouts'],
      })
      .expect(201);
    const courseId = created.body.id as string;

    const section = await opts.instructorAgent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/sections`)
      .send({ title: 'Getting Started' })
      .expect(201);

    for (let i = 0; i < 3; i++) {
      await opts.instructorAgent
        .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/lessons`)
        .send({
          section_id: section.body.id,
          title: `Lesson ${i + 1}`,
          content_type: LessonContentType.TEXT,
          content_html: `<p>Content ${i + 1}</p>`,
          duration_seconds: 120,
          is_free_preview: i === 0,
          is_required_for_completion: true,
        })
        .expect(201);
    }

    await opts.instructorAgent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/submit`)
      .send({})
      .expect(201);
    await opts.adminAgent
      .post(`${API_PREFIX}/marketplace/admin/courses/${courseId}/approve`)
      .send({})
      .expect(201);
    await opts.instructorAgent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/publish`)
      .send({})
      .expect(201);

    const course = await dataSource
      .getRepository(MarketplaceCourse)
      .findOneOrFail({ where: { id: courseId } });
    return course;
  }

  /** Real order creation via HTTP, a `Payment` row shaped like checkout would build one, then a real webhook settles it to PAID — the same bypass-the-live-gateway pattern `marketplace-refunds.e2e-spec.ts` established. Produces a real `InstructorEarning` at REFUND_CLEARANCE via settlement. */
  async function createPaidOrder(
    learner: Awaited<ReturnType<typeof createAuthenticatedUser>>,
    courseId: string,
  ): Promise<{ order: MarketplaceOrder; enrollment: MarketplaceEnrollment }> {
    const created = await learner.agent
      .post(`${API_PREFIX}/marketplace/checkout/orders`)
      .set('Idempotency-Key', `order-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      .send({ courseId })
      .expect(201);
    let order = await dataSource
      .getRepository(MarketplaceOrder)
      .findOneByOrFail({ id: created.body.id as string });

    const payments = dataSource.getRepository(Payment);
    const payment = await payments.save(
      payments.create({
        user_id: learner.userId,
        item_type: ItemType.MARKETPLACE_COURSE,
        item_id: order.id,
        amount: order.net_amount_minor / 100,
        final_amount: order.net_amount_minor / 100,
        amount_minor: order.net_amount_minor,
        currency: order.currency,
        channel: PaymentChannel.GATEWAY,
        provider: 'paymob',
        provider_reference: `provider-order-${order.id}`,
        paymob_order_id: `provider-order-${order.id}`,
        status: PaymentStatus.PROCESSING,
        payment_method: PaymentMethod.CARD,
        idempotency_key: `marketplace-checkout:${order.id}`,
      }),
    );
    await dataSource.getRepository(MarketplaceOrder).update(order.id, { payment_id: payment.id });

    const event: ProviderWebhookEvent = {
      provider: 'paymob',
      providerEventId: `settle-${order.id}`,
      merchantReference: payment.id,
      providerOrderReference: payment.paymob_order_id!,
      transactionId: `txn-${order.id}`,
      amountMinor: payment.amount_minor!,
      currency: payment.currency,
      occurredAt: new Date(),
      outcome: 'succeeded',
      isLive: false,
      payload: {},
    };
    await webhooks.process(event);
    await operations.publishOutbox();

    order = await dataSource.getRepository(MarketplaceOrder).findOneByOrFail({ id: order.id });
    const enrollment = await dataSource
      .getRepository(MarketplaceEnrollment)
      .findOneByOrFail({ order_id: order.id });
    return { order, enrollment };
  }

  /** Backdates the earning's clearance deadline into the past and runs the real sweep — moves REFUND_CLEARANCE → AVAILABLE_BALANCE exactly as the scheduled job would, once the window has passed. */
  async function forceClear(orderId: string): Promise<InstructorEarning> {
    const earnings = dataSource.getRepository(InstructorEarning);
    const earning = await earnings.findOneByOrFail({ order_id: orderId });
    await earnings.update(earning.id, { available_at: new Date(Date.now() - 1000) });
    await clearanceSweep.runSweep();
    return earnings.findOneByOrFail({ id: earning.id });
  }

  async function grantPayoutPermissions(adminId: string) {
    await dataSource
      .getRepository(User)
      .update({ id: adminId }, { finance_permissions: [...FINANCE_PERMISSIONS] });
  }

  async function actors(opts: { priceMinor?: number; currency?: string } = {}) {
    const instructorUser = await createAuthenticatedUser(app, dataSource);
    await seedInstructor(instructorUser.userId);
    const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
    await grantPayoutPermissions(admin.userId);
    const learner = await createAuthenticatedUser(app, dataSource);
    const category = await seedCategory();
    const course = await publishCourse({
      instructorAgent: instructorUser.agent,
      adminAgent: admin.agent,
      categoryId: category.id,
      ...(opts.priceMinor !== undefined && { priceMinor: opts.priceMinor }),
      ...(opts.currency !== undefined && { currency: opts.currency }),
    });
    const { order } = await createPaidOrder(learner, course.id);
    const earning = await forceClear(order.id);
    return { instructorUser, admin, learner, course, order, earning };
  }

  async function createPayoutAccount(
    instructorAgent: Awaited<ReturnType<typeof createAuthenticatedUser>>['agent'],
    currency = 'EGP',
  ) {
    const res = await instructorAgent
      .post(`${API_PREFIX}/marketplace/instructor/payout-accounts`)
      .send({
        account_holder_name: 'Ada Lovelace',
        bank_name: 'Test Bank',
        account_identifier: 'EG1234567890123456789012345678',
        currency,
        country: 'EG',
      })
      .expect(201);
    return res.body.id as string;
  }

  describe('full lifecycle: earn → clear → request → approve → processing → paid', () => {
    it('reconciles the request, the earning and the ledger at every step (FR-206 – FR-220)', async () => {
      const { instructorUser, admin, earning } = await actors({ priceMinor: 200000 });
      expect(earning.status).toBe(InstructorEarningStatus.AVAILABLE_BALANCE);

      const accountId = await createPayoutAccount(instructorUser.agent);

      const requestRes = await instructorUser.agent
        .post(`${API_PREFIX}/marketplace/instructor/payouts`)
        .set('Idempotency-Key', `payout-${Date.now()}`)
        .send({ payout_account_id: accountId, amount_minor: earning.net_amount_minor, currency: 'EGP' })
        .expect(201);
      const requestId = requestRes.body.id as string;
      expect(requestRes.body.status).toBe(PayoutRequestStatus.REQUESTED);
      expect(requestRes.body.amount_minor).toBe(earning.net_amount_minor);

      const lockedEarning = await dataSource.getRepository(InstructorEarning).findOneByOrFail({ id: earning.id });
      expect(lockedEarning.status).toBe(InstructorEarningStatus.PAYOUT_REQUESTED);
      expect(lockedEarning.payout_request_id).toBe(requestId);

      await admin.agent.post(`${API_PREFIX}/marketplace/admin/payouts/${requestId}/approve`).send({}).expect(201);
      await admin.agent.post(`${API_PREFIX}/marketplace/admin/payouts/${requestId}/processing`).send({}).expect(201);
      const paidRes = await admin.agent
        .post(`${API_PREFIX}/marketplace/admin/payouts/${requestId}/paid`)
        .send({ payout_reference: 'TXN-E2E-1' })
        .expect(201);
      expect(paidRes.body.status).toBe(PayoutRequestStatus.PAID);
      expect(paidRes.body.payout_reference).toBe('TXN-E2E-1');

      const paidEarning = await dataSource.getRepository(InstructorEarning).findOneByOrFail({ id: earning.id });
      expect(paidEarning.status).toBe(InstructorEarningStatus.PAID_OUT);

      const ledgerEntries = await dataSource
        .getRepository(MarketplaceLedgerEntry)
        .find({ where: { instructor_id: earning.instructor_id, entry_type: MarketplaceLedgerEntryType.PAYOUT } });
      expect(ledgerEntries).toHaveLength(1);
      expect(ledgerEntries[0]!.direction).toBe(MarketplaceLedgerDirection.CREDIT);
      expect(Number(ledgerEntries[0]!.amount_minor)).toBe(earning.net_amount_minor);

      const balanceRes = await instructorUser.agent
        .get(`${API_PREFIX}/marketplace/instructor/earnings/balance`)
        .expect(200);
      const egp = (balanceRes.body as Array<{ currency: string; paidOutMinor: number; availableMinor: number }>).find(
        (b) => b.currency === 'EGP',
      );
      expect(egp?.paidOutMinor).toBe(earning.net_amount_minor);
      expect(egp?.availableMinor).toBe(0);
    });
  });

  describe('clearance sweep idempotency (FR-153, T163)', () => {
    it('running the sweep twice clears nothing twice', async () => {
      const { order } = await actors();
      const first = await clearanceSweep.runSweep();
      expect(first.cleared).toBe(0); // already cleared once by `actors()`'s own forceClear() call

      const earning = await dataSource.getRepository(InstructorEarning).findOneByOrFail({ order_id: order.id });
      expect(earning.status).toBe(InstructorEarningStatus.AVAILABLE_BALANCE);
    });

    it('a missed run fully recovers on the next run', async () => {
      const { order } = await actors();
      // Simulate the sweep never having run by resetting straight back to REFUND_CLEARANCE.
      const earnings = dataSource.getRepository(InstructorEarning);
      const earning = await earnings.findOneByOrFail({ order_id: order.id });
      await earnings.update(earning.id, {
        status: InstructorEarningStatus.REFUND_CLEARANCE,
        available_at: new Date(Date.now() - 60_000),
      });

      const result = await clearanceSweep.runSweep();
      expect(result.cleared).toBe(1);
      const recovered = await earnings.findOneByOrFail({ id: earning.id });
      expect(recovered.status).toBe(InstructorEarningStatus.AVAILABLE_BALANCE);
    });
  });

  describe('concurrent payout requests cannot over-draw (FR-210, FR-211)', () => {
    it('exactly one of two simultaneous requests against the same earning succeeds', async () => {
      const { instructorUser, earning } = await actors({ priceMinor: 200000 });
      const accountId = await createPayoutAccount(instructorUser.agent);

      const [first, second] = await Promise.all([
        instructorUser.agent
          .post(`${API_PREFIX}/marketplace/instructor/payouts`)
          .set('Idempotency-Key', `payout-race-a-${Date.now()}`)
          .send({ payout_account_id: accountId, amount_minor: earning.net_amount_minor, currency: 'EGP' }),
        instructorUser.agent
          .post(`${API_PREFIX}/marketplace/instructor/payouts`)
          .set('Idempotency-Key', `payout-race-b-${Date.now()}`)
          .send({ payout_account_id: accountId, amount_minor: earning.net_amount_minor, currency: 'EGP' }),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 422]);
      const failed = first.status === 422 ? first : second;
      expect(failed.body.code).toBe('PAYOUT_INSUFFICIENT_BALANCE');

      const requests = await dataSource.getRepository(MarketplacePayoutRequest).find({ where: { instructor_id: earning.instructor_id } });
      expect(requests).toHaveLength(1);
    });
  });

  describe('admin transitions (FR-216, FR-217)', () => {
    it('rejecting a request returns the locked funds to available balance', async () => {
      const { instructorUser, admin, earning } = await actors({ priceMinor: 200000 });
      const accountId = await createPayoutAccount(instructorUser.agent);
      const requestRes = await instructorUser.agent
        .post(`${API_PREFIX}/marketplace/instructor/payouts`)
        .set('Idempotency-Key', `payout-reject-${Date.now()}`)
        .send({ payout_account_id: accountId, amount_minor: earning.net_amount_minor, currency: 'EGP' })
        .expect(201);

      await admin.agent
        .post(`${API_PREFIX}/marketplace/admin/payouts/${requestRes.body.id}/reject`)
        .send({ reason: 'Suspicious account details' })
        .expect(201);

      const released = await dataSource.getRepository(InstructorEarning).findOneByOrFail({ id: earning.id });
      expect(released.status).toBe(InstructorEarningStatus.AVAILABLE_BALANCE);
      expect(released.payout_request_id).toBeNull();
    });

    it('cancelling a request as the instructor returns the locked funds', async () => {
      const { instructorUser, earning } = await actors({ priceMinor: 200000 });
      const accountId = await createPayoutAccount(instructorUser.agent);
      const requestRes = await instructorUser.agent
        .post(`${API_PREFIX}/marketplace/instructor/payouts`)
        .set('Idempotency-Key', `payout-cancel-${Date.now()}`)
        .send({ payout_account_id: accountId, amount_minor: earning.net_amount_minor, currency: 'EGP' })
        .expect(201);

      await instructorUser.agent
        .post(`${API_PREFIX}/marketplace/instructor/payouts/${requestRes.body.id}/cancel`)
        .send({})
        .expect(201);

      const released = await dataSource.getRepository(InstructorEarning).findOneByOrFail({ id: earning.id });
      expect(released.status).toBe(InstructorEarningStatus.AVAILABLE_BALANCE);
    });

    it('refuses a payout request below the currency minimum, naming the exact figure (FR-209, FR-325)', async () => {
      const { instructorUser } = await actors({ priceMinor: 200000 });
      const accountId = await createPayoutAccount(instructorUser.agent);

      const res = await instructorUser.agent
        .post(`${API_PREFIX}/marketplace/instructor/payouts`)
        .set('Idempotency-Key', `payout-min-${Date.now()}`)
        .send({ payout_account_id: accountId, amount_minor: 100, currency: 'EGP' })
        .expect(422);

      expect(res.body.code).toBe('PAYOUT_BELOW_MINIMUM');
      expect(String(res.body.detail)).toContain('50000');
    });
  });

  describe('payout failure reversal (FR-221)', () => {
    it('reverses a PAID payout back to available balance and writes a PAYOUT_REVERSAL entry', async () => {
      const { instructorUser, admin, earning } = await actors({ priceMinor: 200000 });
      const accountId = await createPayoutAccount(instructorUser.agent);
      const requestRes = await instructorUser.agent
        .post(`${API_PREFIX}/marketplace/instructor/payouts`)
        .set('Idempotency-Key', `payout-reversal-${Date.now()}`)
        .send({ payout_account_id: accountId, amount_minor: earning.net_amount_minor, currency: 'EGP' })
        .expect(201);
      const requestId = requestRes.body.id as string;

      await admin.agent.post(`${API_PREFIX}/marketplace/admin/payouts/${requestId}/approve`).send({}).expect(201);
      await admin.agent.post(`${API_PREFIX}/marketplace/admin/payouts/${requestId}/processing`).send({}).expect(201);
      await admin.agent
        .post(`${API_PREFIX}/marketplace/admin/payouts/${requestId}/paid`)
        .send({ payout_reference: 'TXN-TO-REVERSE' })
        .expect(201);

      const failedRes = await admin.agent
        .post(`${API_PREFIX}/marketplace/admin/payouts/${requestId}/failed`)
        .send({ reason: 'Funds bounced back from the bank' })
        .expect(201);
      expect(failedRes.body.status).toBe(PayoutRequestStatus.FAILED);

      const reverted = await dataSource.getRepository(InstructorEarning).findOneByOrFail({ id: earning.id });
      expect(reverted.status).toBe(InstructorEarningStatus.AVAILABLE_BALANCE);

      const reversalEntries = await dataSource
        .getRepository(MarketplaceLedgerEntry)
        .find({ where: { instructor_id: earning.instructor_id, entry_type: MarketplaceLedgerEntryType.PAYOUT_REVERSAL } });
      expect(reversalEntries).toHaveLength(1);
      expect(reversalEntries[0]!.direction).toBe(MarketplaceLedgerDirection.DEBIT);
      expect(Number(reversalEntries[0]!.amount_minor)).toBe(earning.net_amount_minor);

      // The original `payout` credit is never edited or deleted (FR-221).
      const originalPayoutEntry = await dataSource
        .getRepository(MarketplaceLedgerEntry)
        .findOneOrFail({ where: { instructor_id: earning.instructor_id, entry_type: MarketplaceLedgerEntryType.PAYOUT } });
      expect(Number(originalPayoutEntry.amount_minor)).toBe(earning.net_amount_minor);
      expect(originalPayoutEntry.direction).toBe(MarketplaceLedgerDirection.CREDIT);
    });
  });

  describe('multi-currency balances never merge (FR-125, FR-150, FR-151)', () => {
    it('keeps EGP and a second currency fully separate across earnings, requests and balances', async () => {
      // EGP leg.
      const { instructorUser, admin, earning: egpEarning } = await actors({ priceMinor: 200000, currency: 'EGP' });

      // A second currency leg for the SAME instructor. Enabled here directly
      // since only EGP ships enabled at launch (FR-325) — a second currency
      // row is exactly what an admin's future currency-enablement action
      // would produce, so this mirrors that end state without depending on
      // an admin currency-management endpoint this phase doesn't build yet.
      await dataSource.query(
        `INSERT INTO "marketplace_currencies" ("code", "minor_unit_exponent", "is_enabled", "min_price_minor", "max_price_minor", "min_payout_minor")
         VALUES ('USD', 2, true, 500, 200000, 5000)
         ON CONFLICT ("code") DO UPDATE SET "is_enabled" = true`,
      );
      const category = await seedCategory();
      const usdCourse = await publishCourse({
        instructorAgent: instructorUser.agent,
        adminAgent: admin.agent,
        categoryId: category.id,
        priceMinor: 10000,
        currency: 'USD',
      });
      const usdLearner = await createAuthenticatedUser(app, dataSource);
      const { order: usdOrder } = await createPaidOrder(usdLearner, usdCourse.id);
      const usdEarning = await forceClear(usdOrder.id);
      expect(usdEarning.currency).toBe('USD');

      const balanceRes = await instructorUser.agent
        .get(`${API_PREFIX}/marketplace/instructor/earnings/balance`)
        .expect(200);
      const balances = balanceRes.body as Array<{ currency: string; availableMinor: number }>;
      const egp = balances.find((b) => b.currency === 'EGP');
      const usd = balances.find((b) => b.currency === 'USD');
      expect(egp?.availableMinor).toBe(egpEarning.net_amount_minor);
      expect(usd?.availableMinor).toBe(usdEarning.net_amount_minor);

      // A payout request in one currency can never draw from the other.
      const egpAccountId = await createPayoutAccount(instructorUser.agent, 'EGP');
      const oversized = await instructorUser.agent
        .post(`${API_PREFIX}/marketplace/instructor/payouts`)
        .set('Idempotency-Key', `payout-multi-${Date.now()}`)
        .send({ payout_account_id: egpAccountId, amount_minor: egpEarning.net_amount_minor + usdEarning.net_amount_minor, currency: 'EGP' })
        .expect(422);
      expect(oversized.body.code).toBe('PAYOUT_INSUFFICIENT_BALANCE');
    });
  });

  describe('academic and marketplace settlements never interact for a dual-capability user (FR-225, T175)', () => {
    it('a marketplace payout never touches teacher_settlements, and a settlement never touches the marketplace ledger', async () => {
      const { instructorUser, admin, earning } = await actors({ priceMinor: 200000 });

      // The SAME users.id also holds an academic teacher_settlements row —
      // seeded directly (this suite proves independence between the two
      // systems' financial records, not academic settlement correctness,
      // which is proven elsewhere).
      const settlements = dataSource.getRepository(Settlement);
      const settlement = await settlements.save(
        settlements.create({
          settlement_number: `TS-E2E-${Date.now()}`,
          idempotency_key: `settlement-e2e-${Date.now()}`,
          idempotency_fingerprint: 'e2e-fingerprint',
          teacher_id: instructorUser.userId,
          gross_amount_minor: 500000,
          payout_amount_minor: 500000,
          currency: 'EGP',
          fiscal_period: '2026-01',
          status: SettlementStatus.APPROVED,
          payment_method: 'bank_transfer',
          initiated_by: admin.userId,
        }),
      );

      const accountId = await createPayoutAccount(instructorUser.agent);
      const requestRes = await instructorUser.agent
        .post(`${API_PREFIX}/marketplace/instructor/payouts`)
        .set('Idempotency-Key', `payout-dual-${Date.now()}`)
        .send({ payout_account_id: accountId, amount_minor: earning.net_amount_minor, currency: 'EGP' })
        .expect(201);
      const requestId = requestRes.body.id as string;
      await admin.agent.post(`${API_PREFIX}/marketplace/admin/payouts/${requestId}/approve`).send({}).expect(201);
      await admin.agent.post(`${API_PREFIX}/marketplace/admin/payouts/${requestId}/processing`).send({}).expect(201);
      await admin.agent
        .post(`${API_PREFIX}/marketplace/admin/payouts/${requestId}/paid`)
        .send({ payout_reference: 'TXN-DUAL-CAPABILITY' })
        .expect(201);

      // The academic settlement is completely untouched by the marketplace payout.
      const unchangedSettlement = await settlements.findOneByOrFail({ id: settlement.id });
      expect(unchangedSettlement.status).toBe(SettlementStatus.APPROVED);
      expect(unchangedSettlement.payout_amount_minor).toBe(500000);
      expect(unchangedSettlement.paid_at).toBeNull();

      // The marketplace ledger carries only the marketplace amount — never netted against, offset by, or inflated by the academic settlement.
      const paidOutEntries = await dataSource
        .getRepository(MarketplaceLedgerEntry)
        .find({ where: { instructor_id: earning.instructor_id, entry_type: MarketplaceLedgerEntryType.PAYOUT } });
      expect(paidOutEntries).toHaveLength(1);
      expect(Number(paidOutEntries[0]!.amount_minor)).toBe(earning.net_amount_minor);

      const balanceRes = await instructorUser.agent
        .get(`${API_PREFIX}/marketplace/instructor/earnings/balance`)
        .expect(200);
      const egp = (balanceRes.body as Array<{ currency: string; paidOutMinor: number }>).find((b) => b.currency === 'EGP');
      expect(egp?.paidOutMinor).toBe(earning.net_amount_minor);
    });
  });

  describe('authorization (FR-226)', () => {
    it('refuses a non-instructor from creating a payout account', async () => {
      const learner = await createAuthenticatedUser(app, dataSource);
      await learner.agent
        .post(`${API_PREFIX}/marketplace/instructor/payout-accounts`)
        .send({
          account_holder_name: 'Someone',
          bank_name: 'Bank',
          account_identifier: 'EG1234567890123456789012345678',
          currency: 'EGP',
          country: 'EG',
        })
        .expect(403);
    });

    it('refuses an admin without marketplace.payouts.view from listing the queue', async () => {
      // createAuthenticatedUser's `role: 'admin'` provisions the full FINANCE_PERMISSIONS
      // set (matching production's AdminInitializationService) — explicitly clear it
      // to exercise the "admin, but this one permission wasn't granted" case, the same
      // pattern finance-audit.postgres.e2e-spec.ts uses to assert denial.
      const bareAdmin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
      await dataSource.query('UPDATE users SET finance_permissions = $1::jsonb WHERE id = $2', ['[]', bareAdmin.userId]);
      await bareAdmin.agent.get(`${API_PREFIX}/marketplace/admin/payouts`).expect(403);
    });

    it('404s an instructor reading another instructor\'s payout request (IDOR-safe)', async () => {
      const { instructorUser, earning } = await actors({ priceMinor: 200000 });
      const accountId = await createPayoutAccount(instructorUser.agent);
      const requestRes = await instructorUser.agent
        .post(`${API_PREFIX}/marketplace/instructor/payouts`)
        .set('Idempotency-Key', `payout-idor-${Date.now()}`)
        .send({ payout_account_id: accountId, amount_minor: earning.net_amount_minor, currency: 'EGP' })
        .expect(201);

      const otherInstructorUser = await createAuthenticatedUser(app, dataSource);
      await seedInstructor(otherInstructorUser.userId);
      await otherInstructorUser.agent
        .get(`${API_PREFIX}/marketplace/instructor/payouts/${requestRes.body.id}`)
        .expect(404);
    });
  });
});
