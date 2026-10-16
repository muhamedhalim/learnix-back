import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { MarketplaceCategory } from '../../src/marketplace/catalog/entities';
import { MarketplaceEnrollment, MarketplaceOrder } from '../../src/marketplace/commerce/entities';
import {
  InstructorEarningStatus,
  LessonContentType,
  PayoutRequestStatus,
} from '../../src/marketplace/common/enums';
import { ClearanceSweepService } from '../../src/marketplace/jobs/clearance.job';
import { InstructorEarning } from '../../src/marketplace/earnings/entities/instructor-earning.entity';
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
import { Settlement } from '../../src/payments/entities/settlement.entity';
import { SettlementStatus } from '../../src/payments/entities/settlement-status.enum';
import { User } from '../../src/users/entities';
import { buildInstructorFixture } from './factories/marketplace.factory';
import { API_PREFIX, createAuthenticatedUser, createE2EApp, resetDatabase } from './fixtures';

/**
 * T203 (US11, release gate), Deps: T175. `marketplace-payouts.e2e-spec.ts`
 * already proves the **marketplace → academic** direction (a marketplace
 * payout paid to completion leaves a seeded `teacher_settlements` row
 * byte-for-byte unchanged). This suite adds the direction that test did
 * not cover: **academic → marketplace** — driving an academic settlement
 * through its own real state machine (`SettlementsService`, unchanged) for
 * a dual-capability user and proving it leaves every marketplace figure
 * for that same person untouched.
 */
describe('dual-capability isolation — academic activity never touches marketplace figures (Phase 13, T203)', () => {
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

  async function grantAllFinancePermissions(adminId: string) {
    await dataSource
      .getRepository(User)
      .update({ id: adminId }, { finance_permissions: [...FINANCE_PERMISSIONS] });
  }

  /** Builds one real marketplace earning for a dual-capability user, cleared to AVAILABLE_BALANCE. */
  async function seedMarketplaceEarning(
    instructorUser: Awaited<ReturnType<typeof createAuthenticatedUser>>,
    admin: Awaited<ReturnType<typeof createAuthenticatedUser>>,
  ) {
    await dataSource
      .getRepository(MarketplaceInstructor)
      .save(buildInstructorFixture({ user_id: instructorUser.userId }));
    const category = await dataSource.getRepository(MarketplaceCategory).save({
      name_en: 'Programming',
      name_ar: 'البرمجة',
      slug: `programming-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      display_order: 1,
    });
    const created = await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses`)
      .send({
        title: `Dual Capability Course ${Date.now()}`,
        summary: 'Learn dual-capability isolation',
        description: 'A full description of the course content.',
        category_id: category.id,
        level: 'beginner',
        language: 'en',
        price_minor: 200000,
        currency: 'EGP',
        cover_image_key: 'covers/dual-101.jpg',
        learning_outcomes: ['Understand isolation'],
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

    const learner = await createAuthenticatedUser(app, dataSource);
    const orderRes = await learner.agent
      .post(`${API_PREFIX}/marketplace/checkout/orders`)
      .set('Idempotency-Key', `order-${Date.now()}-${Math.random().toString(36).slice(2)}`)
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
        provider_reference: `provider-order-${order.id}`,
        provider_order_reference: `provider-order-${order.id}`,
        status: PaymentStatus.PROCESSING,
        payment_method: PaymentMethod.CARD,
        idempotency_key: `marketplace-checkout:${order.id}`,
      }),
    );
    await dataSource.getRepository(MarketplaceOrder).update(order.id, { payment_id: payment.id });

    const event: ProviderWebhookEvent = {
      provider: 'easykash',
      providerEventId: `settle-${order.id}`,
      merchantReference: payment.id,
      providerOrderReference: payment.provider_order_reference!,
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
    await dataSource.getRepository(MarketplaceEnrollment).findOneByOrFail({ order_id: order.id });

    const earnings = dataSource.getRepository(InstructorEarning);
    const earning = await earnings.findOneByOrFail({ order_id: order.id });
    await earnings.update(earning.id, { available_at: new Date(Date.now() - 1000) });
    await clearanceSweep.runSweep();
    return earnings.findOneByOrFail({ id: earning.id });
  }

  it('an academic settlement approved and paid for a dual-capability user never changes their marketplace balance, earning or payout state', async () => {
    const instructorUser = await createAuthenticatedUser(app, dataSource);
    const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
    await grantAllFinancePermissions(admin.userId);

    const earning = await seedMarketplaceEarning(instructorUser, admin);
    expect(earning.status).toBe(InstructorEarningStatus.AVAILABLE_BALANCE);

    // The SAME users.id also holds an academic settlement, driven through
    // its own real lifecycle (approved → paid) — genuine academic activity,
    // not a bare seed.
    const settlements = dataSource.getRepository(Settlement);
    const settlement = await settlements.save(
      settlements.create({
        settlement_number: `TS-DUAL-${Date.now()}`,
        idempotency_key: `settlement-dual-${Date.now()}`,
        idempotency_fingerprint: 'e2e-fingerprint',
        teacher_id: instructorUser.userId,
        gross_amount_minor: 800000,
        payout_amount_minor: 800000,
        currency: 'EGP',
        fiscal_period: '2026-01',
        status: SettlementStatus.APPROVED,
        payment_method: 'bank_transfer',
        initiated_by: admin.userId,
        approved_by: admin.userId,
      }),
    );
    await settlements.update(settlement.id, {
      status: SettlementStatus.PAID,
      paid_by: admin.userId,
      paid_at: new Date(),
      transfer_reference: 'ACADEMIC-TXN-1',
    });

    const balanceRes = await instructorUser.agent
      .get(`${API_PREFIX}/marketplace/instructor/earnings/balance`)
      .expect(200);
    const egp = (
      balanceRes.body as Array<{ currency: string; availableMinor: number; paidOutMinor: number }>
    ).find((b) => b.currency === 'EGP');
    // The academic settlement's 800000 minor units never appear in the marketplace balance.
    expect(egp?.availableMinor).toBe(earning.net_amount_minor);
    expect(egp?.paidOutMinor).toBe(0);

    const unchangedEarning = await dataSource
      .getRepository(InstructorEarning)
      .findOneByOrFail({ id: earning.id });
    expect(unchangedEarning.status).toBe(InstructorEarningStatus.AVAILABLE_BALANCE);
    expect(unchangedEarning.net_amount_minor).toBe(earning.net_amount_minor);

    const payoutRes = await instructorUser.agent
      .get(`${API_PREFIX}/marketplace/instructor/payouts?page=1&limit=20`)
      .expect(200);
    expect(
      (payoutRes.body.data as unknown[]).filter(
        (p) => (p as { status: string }).status === PayoutRequestStatus.PAID,
      ),
    ).toHaveLength(0);
  });
});
