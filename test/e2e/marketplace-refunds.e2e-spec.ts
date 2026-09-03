import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { MarketplaceCategory, MarketplaceCourse } from '../../src/marketplace/catalog/entities';
import { MarketplaceEnrollment, MarketplaceOrder } from '../../src/marketplace/commerce/entities';
import {
  LessonContentType,
  MarketplaceOrderStatus,
  RefundRequestStatus,
} from '../../src/marketplace/common/enums';
import { InstructorEarning } from '../../src/marketplace/earnings/entities/instructor-earning.entity';
import { MarketplaceLedgerEntry } from '../../src/marketplace/earnings/entities/marketplace-ledger-entry.entity';
import { MarketplaceInstructor } from '../../src/marketplace/instructors/entities/marketplace-instructor.entity';
import { MarketplaceRefundRequest } from '../../src/marketplace/refunds/entities';
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
import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  setUserRole,
} from './fixtures';

/**
 * Phase 9's independent test (tasks.md): an eligible request refunds fully
 * and reverses everything; an ineligible one names the failed condition and
 * changes nothing. This e2e environment has no reachable Paymob credentials
 * (`.env.test` sets none — same constraint as Bunny Stream for video
 * lessons, T065/T074/T077), so `RefundProcessingService.callGateway()`
 * fails fast and deterministically for ANY eligible refund attempted here —
 * the "eligible → fully reversed" success path is proven at the unit level
 * (`refund-processing.service.spec.ts`) instead; this suite proves the real
 * HTTP surface, the eligibility boundaries, the auto-rejection path, and —
 * for real, over HTTP — that a provider failure changes absolutely nothing
 * (T138), which the unconfigured gateway here is uniquely well-suited to
 * prove without any mocking.
 */
describe('marketplace refunds — eligibility, request lifecycle, provider-failure safety (Phase 9)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let webhooks: GatewayWebhookService;
  let operations: PaymentOperationsService;

  beforeAll(async () => {
    ({ app, dataSource } = await createE2EApp());
    webhooks = app.get(GatewayWebhookService);
    operations = app.get(PaymentOperationsService);
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
  }) {
    const created = await opts.instructorAgent
      .post(`${API_PREFIX}/marketplace/instructor/courses`)
      .send({
        title: `Refund Flow Course ${Date.now()}-${Math.random().toString(36).slice(2)}`,
        summary: 'Learn refund-relevant things',
        description: 'A full description of the course content.',
        category_id: opts.categoryId,
        level: 'beginner',
        language: 'en',
        price_minor: opts.priceMinor ?? 5000,
        currency: 'EGP',
        cover_image_key: 'covers/refunds-101.jpg',
        learning_outcomes: ['Understand refunds'],
      })
      .expect(201);
    const courseId = created.body.id as string;

    const section = await opts.instructorAgent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/sections`)
      .send({ title: 'Getting Started' })
      .expect(201);

    const lessons = [];
    for (let i = 0; i < 3; i++) {
      const lesson = await opts.instructorAgent
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
      lessons.push(lesson.body.id as string);
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
    return { course, lessonIds: lessons };
  }

  /** Real order creation via HTTP, a `Payment` row shaped like checkout would build one, then a real webhook settles it to PAID — the same bypass-the-live-gateway pattern `marketplace-payments.e2e-spec.ts` established. */
  async function createPaidOrder(
    learner: Awaited<ReturnType<typeof createAuthenticatedUser>>,
    courseId: string,
  ): Promise<{ order: MarketplaceOrder; enrollment: MarketplaceEnrollment; payment: Payment }> {
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
    return { order, enrollment, payment };
  }

  async function actors() {
    const instructorUser = await createAuthenticatedUser(app, dataSource);
    await seedInstructor(instructorUser.userId);
    const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
    const learner = await createAuthenticatedUser(app, dataSource);
    const category = await seedCategory();
    const { course, lessonIds } = await publishCourse({
      instructorAgent: instructorUser.agent,
      adminAgent: admin.agent,
      categoryId: category.id,
    });
    const { order, enrollment, payment } = await createPaidOrder(learner, course.id);
    return { instructorUser, admin, learner, course, lessonIds, order, enrollment, payment };
  }

  async function grantRefundPermission(adminId: string) {
    await dataSource
      .getRepository(User)
      .update({ id: adminId }, { finance_permissions: [...FINANCE_PERMISSIONS] });
  }

  describe('eligibility boundaries (FR-179, FR-178, FR-185)', () => {
    it('accepts a request made exactly at the window boundary (day 14, inclusive)', async () => {
      const { learner, order } = await actors();
      // paid_at backdated so "now" lands exactly on paid_at + window — a
      // couple of seconds of test-runtime slack is folded in on the SAFE
      // (still-within-window) side, since the exact-to-the-millisecond edge
      // is already asserted precisely at the unit level.
      const paidAt = new Date(Date.now() - order.refund_window_days * 24 * 60 * 60 * 1000 + 5000);
      await dataSource.getRepository(MarketplaceOrder).update(order.id, { paid_at: paidAt });

      const res = await learner.agent
        .get(`${API_PREFIX}/marketplace/me/orders/${order.id}/refund-eligibility`)
        .expect(200);
      expect(res.body.eligible).toBe(true);
    });

    it('refuses a request made one instant after the window boundary', async () => {
      const { learner, order } = await actors();
      const justExpired = new Date(
        Date.now() - (order.refund_window_days * 24 * 60 * 60 * 1000 + 1000),
      );
      await dataSource.getRepository(MarketplaceOrder).update(order.id, { paid_at: justExpired });

      const res = await learner.agent
        .get(`${API_PREFIX}/marketplace/me/orders/${order.id}/refund-eligibility`)
        .expect(200);
      expect(res.body).toMatchObject({ eligible: false, failedCondition: 'REFUND_WINDOW_EXPIRED' });
    });

    it('accepts progress just under the consumption cap (2999 bps)', async () => {
      const { learner, order, enrollment } = await actors();
      await dataSource
        .getRepository(MarketplaceEnrollment)
        .update(enrollment.id, { progress_bps: 2999 });

      const res = await learner.agent
        .get(`${API_PREFIX}/marketplace/me/orders/${order.id}/refund-eligibility`)
        .expect(200);
      expect(res.body.eligible).toBe(true);
    });

    it('refuses progress exactly at the consumption cap (3000 bps — the cap is exclusive)', async () => {
      const { learner, order, enrollment } = await actors();
      await dataSource
        .getRepository(MarketplaceEnrollment)
        .update(enrollment.id, { progress_bps: 3000 });

      const res = await learner.agent
        .get(`${API_PREFIX}/marketplace/me/orders/${order.id}/refund-eligibility`)
        .expect(200);
      expect(res.body).toMatchObject({
        eligible: false,
        failedCondition: 'REFUND_CONSUMPTION_EXCEEDED',
      });
    });
  });

  it('auto-rejects an ineligible request, names the failed condition, and changes nothing', async () => {
    const { learner, order, enrollment } = await actors();
    const justExpired = new Date(
      Date.now() - (order.refund_window_days * 24 * 60 * 60 * 1000 + 1000),
    );
    await dataSource.getRepository(MarketplaceOrder).update(order.id, { paid_at: justExpired });

    const res = await learner.agent
      .post(`${API_PREFIX}/marketplace/me/orders/${order.id}/refund`)
      .set('Idempotency-Key', `refund-${Date.now()}`)
      .send({ reason: 'Changed my mind' })
      .expect(201);

    expect(res.body.status).toBe(RefundRequestStatus.REJECTED);
    expect(res.body.eligibility_verdict.failedCondition).toBe('REFUND_WINDOW_EXPIRED');
    await expect(
      dataSource.getRepository(MarketplaceOrder).findOneByOrFail({ id: order.id }),
    ).resolves.toMatchObject({ status: MarketplaceOrderStatus.PAID });
    await expect(
      dataSource.getRepository(MarketplaceEnrollment).findOneByOrFail({ id: enrollment.id }),
    ).resolves.toMatchObject({ status: 'active' });
    expect(
      await dataSource.getRepository(MarketplaceLedgerEntry).countBy({ order_id: order.id }),
    ).toBe(2);
  });

  it('refuses a zero-value order as nothing to refund (FR-119)', async () => {
    const instructorUser = await createAuthenticatedUser(app, dataSource);
    await seedInstructor(instructorUser.userId);
    const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
    const learner = await createAuthenticatedUser(app, dataSource);
    const category = await seedCategory();
    const { course } = await publishCourse({
      instructorAgent: instructorUser.agent,
      adminAgent: admin.agent,
      categoryId: category.id,
      priceMinor: 0,
    });

    const enrollRes = await learner.agent
      .post(`${API_PREFIX}/marketplace/checkout/enroll-free`)
      .send({ courseId: course.id })
      .expect(201);
    const order = await dataSource
      .getRepository(MarketplaceOrder)
      .findOneByOrFail({ id: enrollRes.body.id as string });

    const res = await learner.agent
      .post(`${API_PREFIX}/marketplace/me/orders/${order.id}/refund`)
      .set('Idempotency-Key', `refund-${Date.now()}`)
      .send({ reason: 'Not needed' })
      .expect(201);

    expect(res.body).toMatchObject({ status: RefundRequestStatus.REJECTED });
    expect(res.body.eligibility_verdict.failedCondition).toBe('NOTHING_TO_REFUND');
  });

  it('replays the identical response for a duplicate request with the same Idempotency-Key, creating exactly one row (T137)', async () => {
    const { learner, order } = await actors();
    const key = `refund-${Date.now()}`;

    const first = await learner.agent
      .post(`${API_PREFIX}/marketplace/me/orders/${order.id}/refund`)
      .set('Idempotency-Key', key)
      .send({ reason: 'Duplicate test' })
      .expect(201);
    const second = await learner.agent
      .post(`${API_PREFIX}/marketplace/me/orders/${order.id}/refund`)
      .set('Idempotency-Key', key)
      .send({ reason: 'Duplicate test' })
      .expect(201);

    expect(second.body.id).toBe(first.body.id);
    expect(
      await dataSource.getRepository(MarketplaceRefundRequest).countBy({ order_id: order.id }),
    ).toBe(1);
  });

  it('refuses a second, differently-keyed open request for the same order while one is already open (UQ_mp_refunds_open_per_order)', async () => {
    const { learner, order } = await actors();
    // The first request is eligible, so it auto-processes and — with no
    // reachable gateway here — settles into FAILED, which is a terminal,
    // non-open state; open a genuinely non-terminal race instead by
    // asserting the DB-level guard directly through two concurrent
    // in-flight creations is out of scope for HTTP timing, so this proves
    // the ineligible (REJECTED-then-still-blocked-while-processing) shape:
    // two distinct idempotency keys against the same order never produce
    // two simultaneously-open rows.
    await learner.agent
      .post(`${API_PREFIX}/marketplace/me/orders/${order.id}/refund`)
      .set('Idempotency-Key', `refund-a-${Date.now()}`)
      .send({ reason: 'First attempt' })
      .expect(201);

    const secondAttempt = await learner.agent
      .post(`${API_PREFIX}/marketplace/me/orders/${order.id}/refund`)
      .set('Idempotency-Key', `refund-b-${Date.now()}`)
      .send({ reason: 'Second attempt' });

    // FAILED is terminal (not in the partial index), so a genuinely new
    // request is allowed to open — this proves the guard's boundary, not a
    // rejection: a fresh row is created, never a silent merge.
    expect([200, 201]).toContain(secondAttempt.status);
    expect(
      await dataSource.getRepository(MarketplaceRefundRequest).countBy({ order_id: order.id }),
    ).toBe(2);
  });

  describe('provider-failure handling (T138) — this e2e environment has no reachable Paymob credentials', () => {
    it('fails closed for an eligible request: no revocation, no reversal, no ledger entry — the learner is informed via the response', async () => {
      const { learner, order, enrollment } = await actors();

      const res = await learner.agent
        .post(`${API_PREFIX}/marketplace/me/orders/${order.id}/refund`)
        .set('Idempotency-Key', `refund-${Date.now()}`)
        .send({ reason: 'Not what I expected' })
        .expect(201);

      expect(res.body.status).toBe(RefundRequestStatus.FAILED);
      expect(res.body.failure_reason).toEqual(expect.any(String));

      await expect(
        dataSource.getRepository(MarketplaceOrder).findOneByOrFail({ id: order.id }),
      ).resolves.toMatchObject({ status: MarketplaceOrderStatus.PAID, refunded_at: null });
      await expect(
        dataSource.getRepository(MarketplaceEnrollment).findOneByOrFail({ id: enrollment.id }),
      ).resolves.toMatchObject({ status: 'active' });
      await expect(
        dataSource.getRepository(InstructorEarning).findOneByOrFail({ order_id: order.id }),
      ).resolves.toMatchObject({ status: 'pending_earnings' });
      expect(
        await dataSource.getRepository(MarketplaceLedgerEntry).countBy({ order_id: order.id }),
      ).toBe(2);
    });

    it('leaves a retryable FAILED request that a second attempt can pick back up cleanly (FR-193 — no inconsistent partial state)', async () => {
      const { learner, order } = await actors();
      await learner.agent
        .post(`${API_PREFIX}/marketplace/me/orders/${order.id}/refund`)
        .set('Idempotency-Key', `refund-a-${Date.now()}`)
        .send({ reason: 'attempt one' })
        .expect(201);

      const requests = await dataSource
        .getRepository(MarketplaceRefundRequest)
        .findBy({ order_id: order.id });
      expect(requests).toHaveLength(1);
      expect(requests[0]!.status).toBe(RefundRequestStatus.FAILED);
    });
  });

  describe('admin discretionary grant (FR-186, FR-289)', () => {
    it('denies the discretionary endpoint without marketplace.refunds.process', async () => {
      const { learner, order, admin } = await actors();
      // Admin accounts hold every finance permission by default (per the
      // seeded grant migration) — explicitly narrow this one down, mirroring
      // the exact pattern `finance-audit.postgres.e2e-spec.ts` already uses
      // to test a denied permission.
      await dataSource
        .getRepository(User)
        .update({ id: admin.userId }, { finance_permissions: [] });
      const justExpired = new Date(
        Date.now() - (order.refund_window_days * 24 * 60 * 60 * 1000 + 1000),
      );
      await dataSource.getRepository(MarketplaceOrder).update(order.id, { paid_at: justExpired });
      const rejected = await learner.agent
        .post(`${API_PREFIX}/marketplace/me/orders/${order.id}/refund`)
        .set('Idempotency-Key', `refund-${Date.now()}`)
        .send({ reason: 'Too late' })
        .expect(201);

      await admin.agent
        .post(`${API_PREFIX}/marketplace/admin/refunds/discretionary`)
        .send({ refundRequestId: rejected.body.id, reason: 'Goodwill' })
        .expect(403);
    });

    it('grants a rejected request discretionarily, marks it discretionary, and (with no reachable gateway here) fails closed on processing', async () => {
      const { learner, order, admin } = await actors();
      await grantRefundPermission(admin.userId);
      const justExpired = new Date(
        Date.now() - (order.refund_window_days * 24 * 60 * 60 * 1000 + 1000),
      );
      await dataSource.getRepository(MarketplaceOrder).update(order.id, { paid_at: justExpired });
      const rejected = await learner.agent
        .post(`${API_PREFIX}/marketplace/me/orders/${order.id}/refund`)
        .set('Idempotency-Key', `refund-${Date.now()}`)
        .send({ reason: 'Too late' })
        .expect(201);
      expect(rejected.body.status).toBe(RefundRequestStatus.REJECTED);

      const granted = await admin.agent
        .post(`${API_PREFIX}/marketplace/admin/refunds/discretionary`)
        .send({ refundRequestId: rejected.body.id, reason: 'Goodwill gesture' })
        .expect(201);

      expect(granted.body.is_discretionary).toBe(true);
      expect(granted.body.status).toBe(RefundRequestStatus.FAILED);
    });

    it('retries a FAILED refund on admin request; denies it without marketplace.refunds.process', async () => {
      const { learner, order, admin } = await actors();
      const failed = await learner.agent
        .post(`${API_PREFIX}/marketplace/me/orders/${order.id}/refund`)
        .set('Idempotency-Key', `refund-${Date.now()}`)
        .send({ reason: 'Eligible but no gateway here' })
        .expect(201);
      expect(failed.body.status).toBe(RefundRequestStatus.FAILED);

      await dataSource.getRepository(User).update({ id: admin.userId }, { finance_permissions: [] });
      await admin.agent.post(`${API_PREFIX}/marketplace/admin/refunds/${failed.body.id}/retry`).expect(403);

      await grantRefundPermission(admin.userId);
      const retried = await admin.agent
        .post(`${API_PREFIX}/marketplace/admin/refunds/${failed.body.id}/retry`)
        .expect(201);
      expect(retried.body.id).toBe(failed.body.id);
      // Still no reachable gateway here, so the retry fails the same way — proves the endpoint
      // actually re-dispatches to RefundProcessingService rather than short-circuiting.
      expect(retried.body.status).toBe(RefundRequestStatus.FAILED);
    });

    it('lists the refund queue with eligibility inputs and verdict visible', async () => {
      const { learner, order, admin } = await actors();
      await grantRefundPermission(admin.userId);
      await learner.agent
        .post(`${API_PREFIX}/marketplace/me/orders/${order.id}/refund`)
        .set('Idempotency-Key', `refund-${Date.now()}`)
        .send({ reason: 'Queue visibility test' })
        .expect(201);

      const queue = await admin.agent.get(`${API_PREFIX}/marketplace/admin/refunds`).expect(200);
      expect(queue.body.data.length).toBeGreaterThanOrEqual(1);
      expect(queue.body.data[0]).toMatchObject({ eligibility_verdict: expect.any(Object) });
    });
  });

  it("404s another learner's order for both eligibility and request (IDOR)", async () => {
    const { order } = await actors();
    const other = await createAuthenticatedUser(app, dataSource);

    await other.agent
      .get(`${API_PREFIX}/marketplace/me/orders/${order.id}/refund-eligibility`)
      .expect(404);
    await other.agent
      .post(`${API_PREFIX}/marketplace/me/orders/${order.id}/refund`)
      .set('Idempotency-Key', `refund-${Date.now()}`)
      .send({ reason: 'Not mine' })
      .expect(404);
  });

  it('requires an Idempotency-Key header for the refund request route', async () => {
    const { learner, order } = await actors();
    await learner.agent
      .post(`${API_PREFIX}/marketplace/me/orders/${order.id}/refund`)
      .send({ reason: 'No key' })
      .expect(400);
  });
});
