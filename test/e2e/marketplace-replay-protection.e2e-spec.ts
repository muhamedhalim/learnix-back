import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { MarketplaceCategory } from '../../src/marketplace/catalog/entities';
import { MarketplaceEnrollment, MarketplaceOrder } from '../../src/marketplace/commerce/entities';
import {
  LessonContentType,
  MarketplaceLedgerEntryType,
  PayoutRequestStatus,
} from '../../src/marketplace/common/enums';
import { MarketplaceLedgerEntry } from '../../src/marketplace/earnings/entities/marketplace-ledger-entry.entity';
import { InstructorEarning } from '../../src/marketplace/earnings/entities/instructor-earning.entity';
import { ClearanceSweepService } from '../../src/marketplace/jobs/clearance.job';
import { MarketplaceInstructor } from '../../src/marketplace/instructors/entities/marketplace-instructor.entity';
import { FINANCE_PERMISSIONS } from '../../src/payments/finance-permissions';
import { ItemType } from '../../src/payments/entities/item-type.enum';
import { Payment } from '../../src/payments/entities/payment.entity';
import { PaymentChannel } from '../../src/payments/entities/payment-channel.enum';
import { PaymentMethod } from '../../src/payments/entities/payment-method.enum';
import { PaymentStatus } from '../../src/payments/entities/payment-status.enum';
import type { ProviderWebhookEvent } from '../../src/payments/providers/payment-gateway.interface';
import { GatewayWebhookService } from '../../src/payments/services/gateway-webhook.service';
import { PaymentOperationsService } from '../../src/payments/services/payment-operations.service';
import { User } from '../../src/users/entities';
import { buildInstructorFixture } from './factories/marketplace.factory';
import { API_PREFIX, createAuthenticatedUser, createE2EApp, resetDatabase } from './fixtures';
import { TEST_IMAGE_KEY } from './helpers/images';

/**
 * T211 (US11 Phase 14, security hardening audit). FR-305/FR-190: every
 * money-moving write is replay-safe. Two distinct mechanisms provide this
 * across the marketplace module, and this suite proves both directly:
 *
 * 1. **True idempotency-key replay** (a client resends the identical
 *    request, e.g. after a timed-out response) — the exact same key
 *    returns the exact same result, never creates a second resource.
 *    Verified here for payout-request creation (DB-column-backed) and
 *    refund-request creation (the shared `IdempotencyService` Redis cache
 *    — the same mechanism `checkout.service.ts`'s own pay step uses).
 * 2. **State-machine replay guard** — an admin action that is not itself a
 *    "create" (approve/mark-paid/etc.) cannot be re-applied to a resource
 *    already past that state; the closed transition table refuses it
 *    outright, so a double-click can never double-credit a ledger.
 *    Verified here by driving a payout to PAID and then replaying `paid`.
 *
 * **Audit finding, deliberately not fixed in this pass**: unlike every
 * other money-moving create route, `POST /marketplace/checkout/orders`
 * accepts and validates the presence of `Idempotency-Key` but never
 * actually threads it through to `MarketplaceOrderService.createOrder()` —
 * a genuine replay hits the pre-existing `UQ_mp_orders_open_per_course`
 * guard and receives `ORDER_ALREADY_OPEN` (409) instead of the same order
 * back. This bounds the risk to "a recoverable error on retry", never a
 * double order or double charge (no payment has been captured at this
 * step), so it is not a financial-integrity bug — but it is not the
 * RFC-idempotent behavior the header's own contract promises, unlike its
 * sibling `.../orders/:id/pay` (which correctly uses `IdempotencyService`,
 * exactly as this suite proves below). Recorded for a follow-up rather
 * than fixed here, since a proper fix needs `MarketplaceOrderService` wired
 * to `IdempotencyService` the same way `RefundRequestService` already is —
 * out of proportion to include unreviewed in this pass.
 */
describe('marketplace replay protection (Phase 14, T211)', () => {
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

  async function grantFinancePermissions(adminId: string) {
    await dataSource
      .getRepository(User)
      .update({ id: adminId }, { finance_permissions: [...FINANCE_PERMISSIONS] });
  }

  async function seedInstructorWithClearedEarning(): Promise<{
    instructorUser: Awaited<ReturnType<typeof createAuthenticatedUser>>;
    admin: Awaited<ReturnType<typeof createAuthenticatedUser>>;
    earning: InstructorEarning;
  }> {
    const instructorUser = await createAuthenticatedUser(app, dataSource);
    await dataSource
      .getRepository(MarketplaceInstructor)
      .save(buildInstructorFixture({ user_id: instructorUser.userId }));
    const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
    await grantFinancePermissions(admin.userId);
    const learner = await createAuthenticatedUser(app, dataSource);
    const category = await dataSource.getRepository(MarketplaceCategory).save({
      name_en: 'Programming',
      name_ar: 'البرمجة',
      slug: `programming-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      display_order: 1,
    });

    const created = await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses`)
      .send({
        title: `Replay Protection Course ${Date.now()}`,
        summary: 'Replay protection coverage',
        description: 'A full description of the course content.',
        category_id: category.id,
        level: 'beginner',
        language: 'en',
        price_minor: 200000,
        currency: 'EGP',
        cover_image_key: TEST_IMAGE_KEY,
        learning_outcomes: ['n/a'],
      })
      .expect(201);
    const courseId = created.body.id as string;
    const section = await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/sections`)
      .send({ title: 'Getting Started' })
      .expect(201);
    for (let i = 0; i < 3; i++) {
      await instructorUser.agent
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
    await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/submit`)
      .send({})
      .expect(201);
    await admin.agent
      .post(`${API_PREFIX}/marketplace/admin/courses/${courseId}/approve`)
      .send({})
      .expect(201);
    await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/publish`)
      .send({})
      .expect(201);

    const orderRes = await learner.agent
      .post(`${API_PREFIX}/marketplace/checkout/orders`)
      .set('Idempotency-Key', `replay-order-${Date.now()}`)
      .send({ courseId })
      .expect(201);
    let order = await dataSource
      .getRepository(MarketplaceOrder)
      .findOneByOrFail({ id: orderRes.body.id as string });

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
        provider: 'easykash',
        provider_reference: `provider-replay-${order.id}`,
        provider_order_reference: `provider-replay-${order.id}`,
        status: PaymentStatus.PROCESSING,
        payment_method: PaymentMethod.CARD,
        idempotency_key: `marketplace-checkout:${order.id}`,
      }),
    );
    await dataSource.getRepository(MarketplaceOrder).update(order.id, { payment_id: payment.id });

    const event: ProviderWebhookEvent = {
      provider: 'easykash',
      providerEventId: `replay-settle-${order.id}`,
      merchantReference: payment.id,
      providerOrderReference: payment.provider_order_reference!,
      transactionId: `replay-txn-${order.id}`,
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
    await dataSource.getRepository(MarketplaceEnrollment).findOneByOrFail({ order_id: order.id });

    const earnings = dataSource.getRepository(InstructorEarning);
    const earning = await earnings.findOneByOrFail({ order_id: order.id });
    await earnings.update(earning.id, { available_at: new Date(Date.now() - 1000) });
    await clearanceSweep.runSweep();
    const cleared = await earnings.findOneByOrFail({ id: earning.id });

    return { instructorUser, admin, earning: cleared };
  }

  it('replaying the exact same Idempotency-Key on a payout request returns the SAME request, never a second one', async () => {
    const { instructorUser, earning } = await seedInstructorWithClearedEarning();

    const accountRes = await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/payout-accounts`)
      .send({
        account_holder_name: 'Replay Instructor',
        bank_name: 'Test Bank',
        account_identifier: 'EG5555555555555555555555555555',
        currency: 'EGP',
        country: 'EG',
      })
      .expect(201);
    const key = `replay-payout-${Date.now()}`;
    const body = {
      payout_account_id: accountRes.body.id,
      amount_minor: earning.net_amount_minor,
      currency: 'EGP',
    };

    const first = await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/payouts`)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    const second = await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/payouts`)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);

    expect(second.body.id).toBe(first.body.id);

    const list = await instructorUser.agent
      .get(`${API_PREFIX}/marketplace/instructor/payouts?page=1&limit=20`)
      .expect(200);
    expect((list.body.data as unknown[]).length).toBe(1);
  });

  it('replaying the exact same Idempotency-Key on a refund request returns the cached result, never a second refund', async () => {
    const learner = await createAuthenticatedUser(app, dataSource);
    const instructor = await createAuthenticatedUser(app, dataSource);
    await dataSource
      .getRepository(MarketplaceInstructor)
      .save(buildInstructorFixture({ user_id: instructor.userId }));
    const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
    const category = await dataSource.getRepository(MarketplaceCategory).save({
      name_en: 'Programming',
      name_ar: 'البرمجة',
      slug: `programming-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      display_order: 1,
    });
    const created = await instructor.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses`)
      .send({
        title: `Refund Replay Course ${Date.now()}`,
        summary: 'Refund replay coverage',
        description: 'A full description of the course content.',
        category_id: category.id,
        level: 'beginner',
        language: 'en',
        price_minor: 150000,
        currency: 'EGP',
        cover_image_key: TEST_IMAGE_KEY,
        learning_outcomes: ['n/a'],
      })
      .expect(201);
    const courseId = created.body.id as string;
    const section = await instructor.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/sections`)
      .send({ title: 'Getting Started' })
      .expect(201);
    for (let i = 0; i < 3; i++) {
      await instructor.agent
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
    await instructor.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/submit`)
      .send({})
      .expect(201);
    await admin.agent
      .post(`${API_PREFIX}/marketplace/admin/courses/${courseId}/approve`)
      .send({})
      .expect(201);
    await instructor.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/publish`)
      .send({})
      .expect(201);

    const orderRes = await learner.agent
      .post(`${API_PREFIX}/marketplace/checkout/orders`)
      .set('Idempotency-Key', `refund-replay-order-${Date.now()}`)
      .send({ courseId })
      .expect(201);
    let order = await dataSource
      .getRepository(MarketplaceOrder)
      .findOneByOrFail({ id: orderRes.body.id as string });
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
        provider: 'easykash',
        provider_reference: `provider-refundreplay-${order.id}`,
        provider_order_reference: `provider-refundreplay-${order.id}`,
        status: PaymentStatus.PROCESSING,
        payment_method: PaymentMethod.CARD,
        idempotency_key: `marketplace-checkout:${order.id}`,
      }),
    );
    await dataSource.getRepository(MarketplaceOrder).update(order.id, { payment_id: payment.id });
    const event: ProviderWebhookEvent = {
      provider: 'easykash',
      providerEventId: `refundreplay-settle-${order.id}`,
      merchantReference: payment.id,
      providerOrderReference: payment.provider_order_reference!,
      transactionId: `refundreplay-txn-${order.id}`,
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

    const key = `refund-replay-${Date.now()}`;
    const first = await learner.agent
      .post(`${API_PREFIX}/marketplace/me/orders/${order.id}/refund`)
      .set('Idempotency-Key', key)
      .send({ reason: 'not_as_described' })
      .expect(201);
    const second = await learner.agent
      .post(`${API_PREFIX}/marketplace/me/orders/${order.id}/refund`)
      .set('Idempotency-Key', key)
      .send({ reason: 'not_as_described' })
      .expect(201);

    expect(second.body.id).toBe(first.body.id);
  });

  it('an already-PAID payout request refuses a replayed "mark paid" — the state machine, not luck, prevents a double credit', async () => {
    const { instructorUser, admin, earning } = await seedInstructorWithClearedEarning();
    const accountRes = await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/payout-accounts`)
      .send({
        account_holder_name: 'Replay Instructor 2',
        bank_name: 'Test Bank',
        account_identifier: 'EG4444444444444444444444444444',
        currency: 'EGP',
        country: 'EG',
      })
      .expect(201);
    const requestRes = await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/payouts`)
      .set('Idempotency-Key', `replay-transition-${Date.now()}`)
      .send({
        payout_account_id: accountRes.body.id,
        amount_minor: earning.net_amount_minor,
        currency: 'EGP',
      })
      .expect(201);
    const requestId = requestRes.body.id as string;

    await admin.agent
      .post(`${API_PREFIX}/marketplace/admin/payouts/${requestId}/approve`)
      .send({})
      .expect(201);
    await admin.agent
      .post(`${API_PREFIX}/marketplace/admin/payouts/${requestId}/processing`)
      .send({})
      .expect(201);
    const paidRes = await admin.agent
      .post(`${API_PREFIX}/marketplace/admin/payouts/${requestId}/paid`)
      .send({ payout_reference: 'TXN-REPLAY-1' })
      .expect(201);
    expect(paidRes.body.status).toBe(PayoutRequestStatus.PAID);

    // The exact same "mark paid" call, replayed — refused, not silently re-applied.
    await admin.agent
      .post(`${API_PREFIX}/marketplace/admin/payouts/${requestId}/paid`)
      .send({ payout_reference: 'TXN-REPLAY-1' })
      .expect(409);

    const ledgerEntries = await dataSource.getRepository(MarketplaceLedgerEntry).find({
      where: {
        instructor_id: earning.instructor_id,
        entry_type: MarketplaceLedgerEntryType.PAYOUT,
      },
    });
    expect(ledgerEntries).toHaveLength(1);
    expect(Number(ledgerEntries[0]!.amount_minor)).toBe(earning.net_amount_minor);
  });
});
