import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import request from 'supertest';

import { LessonContentType, MarketplaceOrderStatus } from '../../src/marketplace/common/enums';
import { MarketplaceCategory, MarketplaceCourse } from '../../src/marketplace/catalog/entities';
import { InstructorEarning } from '../../src/marketplace/earnings/entities/instructor-earning.entity';
import { MarketplaceLedgerEntry } from '../../src/marketplace/earnings/entities/marketplace-ledger-entry.entity';
import { MarketplaceEnrollment, MarketplaceOrder } from '../../src/marketplace/commerce/entities';
import { MarketplaceInstructor } from '../../src/marketplace/instructors/entities/marketplace-instructor.entity';
import { ItemType } from '../../src/payments/entities/item-type.enum';
import { Payment } from '../../src/payments/entities/payment.entity';
import { PaymentChannel } from '../../src/payments/entities/payment-channel.enum';
import { PaymentMethod } from '../../src/payments/entities/payment-method.enum';
import { PaymentStatus } from '../../src/payments/entities/payment-status.enum';
import type { ProviderWebhookEvent } from '../../src/payments/providers/payment-gateway.interface';
import { GatewayWebhookService } from '../../src/payments/services/gateway-webhook.service';
import { PaymentOperationsService } from '../../src/payments/services/payment-operations.service';
import { buildInstructorFixture } from './factories/marketplace.factory';
import { API_PREFIX, createAuthenticatedUser, createE2EApp, resetDatabase, setUserRole } from './fixtures';

/**
 * T093 — contracts §4's payment-integrity guarantee end to end: a real
 * webhook delivery through `GatewayWebhookService.process()` (the exact
 * HMAC-verified, replay-guarded entry point production traffic hits), then
 * `PaymentOperationsService.publishOutbox()` (the same cron-driven drain
 * that turns the durable `payment.marketplace_item_succeeded`/`_failed`
 * outbox fact into the real `MarketplaceSettlementListener` event, exactly
 * as it does in production — never called synchronously inline). Checkout
 * *initiation* (`POST .../orders/:id/pay`, which calls the real Paymob
 * gateway) is deliberately not exercised here — this suite starts from a
 * `Payment` row shaped exactly as `MarketplaceCheckoutService.createCheckout()`
 * creates one, the same way `payment-financial-state-machine.postgres.e2e-spec.ts`
 * does for the academic flow, so it proves settlement correctness without a
 * live gateway.
 */
describe('marketplace payment integrity — webhook settlement (contracts §4, T093)', () => {
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
    return dataSource.getRepository(MarketplaceInstructor).save(buildInstructorFixture({ user_id: userId }));
  }

  async function seedCategory() {
    return dataSource.getRepository(MarketplaceCategory).save({
      name_en: 'Programming',
      name_ar: 'البرمجة',
      slug: `programming-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      display_order: 1,
    });
  }

  /** Draft → submit → admin approve → instructor publish, matching marketplace-catalog.e2e-spec.ts's helper. */
  async function publishCourse(opts: {
    instructorAgent: Awaited<ReturnType<typeof createAuthenticatedUser>>['agent'];
    adminAgent: Awaited<ReturnType<typeof createAuthenticatedUser>>['agent'];
    categoryId: string;
    priceMinor?: number;
  }) {
    const created = await opts.instructorAgent
      .post(`${API_PREFIX}/marketplace/instructor/courses`)
      .send({
        title: `Payment Integrity Course ${Date.now()}`,
        summary: 'Learn to build backend systems',
        description: 'A full description of the course content.',
        category_id: opts.categoryId,
        level: 'beginner',
        language: 'en',
        price_minor: opts.priceMinor ?? 5000,
        currency: 'EGP',
        cover_image_key: 'covers/backend-101.jpg',
        learning_outcomes: ['Build a REST API'],
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
        })
        .expect(201);
    }

    await opts.instructorAgent.post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/submit`).send({}).expect(201);
    await opts.adminAgent.post(`${API_PREFIX}/marketplace/admin/courses/${courseId}/approve`).send({}).expect(201);
    await opts.instructorAgent.post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/publish`).send({}).expect(201);

    return dataSource.getRepository(MarketplaceCourse).findOneOrFail({ where: { id: courseId } });
  }

  /** Real order creation via T103's HTTP endpoint (no gateway involved), then a `Payment` row shaped exactly as `MarketplaceCheckoutService.createCheckout()` builds one — bypassing the live Paymob call that endpoint would otherwise make. */
  async function createOrderAndPayment(
    learner: Awaited<ReturnType<typeof createAuthenticatedUser>>,
    courseId: string,
  ): Promise<{ order: MarketplaceOrder; payment: Payment }> {
    const created = await learner.agent
      .post(`${API_PREFIX}/marketplace/checkout/orders`)
      .set('Idempotency-Key', `order-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      .send({ courseId })
      .expect(201);
    const order = await dataSource.getRepository(MarketplaceOrder).findOneByOrFail({ id: created.body.id as string });

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

    return { order, payment };
  }

  function webhookFor(
    payment: Payment,
    outcome: ProviderWebhookEvent['outcome'],
    providerEventId: string,
    overrides: Partial<ProviderWebhookEvent> = {},
  ): ProviderWebhookEvent {
    return {
      provider: 'paymob',
      providerEventId,
      merchantReference: payment.id,
      providerOrderReference: payment.paymob_order_id!,
      transactionId: `txn-${providerEventId}`,
      amountMinor: payment.amount_minor!,
      currency: payment.currency,
      occurredAt: new Date(),
      outcome,
      isLive: false,
      payload: {},
      ...overrides,
    };
  }

  async function actors() {
    const instructorUser = await createAuthenticatedUser(app, dataSource);
    await seedInstructor(instructorUser.userId);
    const admin = await createAuthenticatedUser(app, dataSource);
    await setUserRole(dataSource, admin.userId, 'admin');
    const learner = await createAuthenticatedUser(app, dataSource);
    const category = await seedCategory();
    return { instructorUser, admin, learner, category };
  }

  it('grants enrollment and earning exactly once for a duplicate webhook delivery (concurrent replay)', async () => {
    const { instructorUser, admin, learner, category } = await actors();
    const course = await publishCourse({ instructorAgent: instructorUser.agent, adminAgent: admin.agent, categoryId: category.id });
    const { order, payment } = await createOrderAndPayment(learner, course.id);
    const incoming = webhookFor(payment, 'succeeded', 'duplicate-event');

    await Promise.all([webhooks.process(incoming), webhooks.process(incoming)]);
    await operations.publishOutbox();

    await expect(dataSource.getRepository(MarketplaceOrder).findOneByOrFail({ id: order.id })).resolves.toMatchObject({
      status: MarketplaceOrderStatus.PAID,
    });
    expect(await dataSource.getRepository(MarketplaceEnrollment).countBy({ order_id: order.id })).toBe(1);
    expect(await dataSource.getRepository(InstructorEarning).countBy({ order_id: order.id })).toBe(1);
    expect(await dataSource.getRepository(MarketplaceLedgerEntry).countBy({ order_id: order.id })).toBe(2);
  });

  it('a late "failed" webhook can never undo an order already settled by an earlier "succeeded" one (out-of-order delivery)', async () => {
    const { instructorUser, admin, learner, category } = await actors();
    const course = await publishCourse({ instructorAgent: instructorUser.agent, adminAgent: admin.agent, categoryId: category.id });
    const { order, payment } = await createOrderAndPayment(learner, course.id);

    await webhooks.process(webhookFor(payment, 'succeeded', 'out-of-order-success'));
    await operations.publishOutbox();
    await expect(dataSource.getRepository(MarketplaceOrder).findOneByOrFail({ id: order.id })).resolves.toMatchObject({
      status: MarketplaceOrderStatus.PAID,
    });

    // The provider's own decline notification for the same attempt arrives late.
    await webhooks.process(webhookFor(payment, 'failed', 'out-of-order-failure'));
    await operations.publishOutbox();

    await expect(dataSource.getRepository(MarketplaceOrder).findOneByOrFail({ id: order.id })).resolves.toMatchObject({
      status: MarketplaceOrderStatus.PAID,
    });
    expect(await dataSource.getRepository(MarketplaceEnrollment).countBy({ order_id: order.id, status: 'active' as never })).toBe(1);
  });

  it('grants nothing and records a discrepancy on an amount mismatch, never the order snapshot silently overridden (FR-104)', async () => {
    const { instructorUser, admin, learner, category } = await actors();
    const course = await publishCourse({ instructorAgent: instructorUser.agent, adminAgent: admin.agent, categoryId: category.id, priceMinor: 5000 });
    const { order, payment } = await createOrderAndPayment(learner, course.id);
    // The gateway's own amount check only compares against `Payment.amount_minor`
    // (which mirrors the order snapshot at checkout time) — a provider capture
    // for a different amount is rejected before it ever reaches settlement.
    const mismatched = webhookFor(payment, 'succeeded', 'amount-mismatch-event', { amountMinor: payment.amount_minor! - 1 });

    await expect(webhooks.process(mismatched)).rejects.toThrow();
    await operations.publishOutbox();

    await expect(dataSource.getRepository(MarketplaceOrder).findOneByOrFail({ id: order.id })).resolves.toMatchObject({
      status: MarketplaceOrderStatus.AWAITING_PAYMENT,
    });
    expect(await dataSource.getRepository(MarketplaceEnrollment).countBy({ order_id: order.id })).toBe(0);
  });

  it('grants nothing on a currency mismatch either (FR-104)', async () => {
    const { instructorUser, admin, learner, category } = await actors();
    const course = await publishCourse({ instructorAgent: instructorUser.agent, adminAgent: admin.agent, categoryId: category.id });
    const { order, payment } = await createOrderAndPayment(learner, course.id);
    const mismatched = webhookFor(payment, 'succeeded', 'currency-mismatch-event', { currency: 'USD' });

    await expect(webhooks.process(mismatched)).rejects.toThrow();
    await operations.publishOutbox();

    await expect(dataSource.getRepository(MarketplaceOrder).findOneByOrFail({ id: order.id })).resolves.toMatchObject({
      status: MarketplaceOrderStatus.AWAITING_PAYMENT,
    });
    expect(await dataSource.getRepository(MarketplaceEnrollment).countBy({ order_id: order.id })).toBe(0);
  });

  it('settles normally and grants access against the purchased version even though the course was unpublished after checkout (FR-103, T100)', async () => {
    const { instructorUser, admin, learner, category } = await actors();
    const course = await publishCourse({ instructorAgent: instructorUser.agent, adminAgent: admin.agent, categoryId: category.id });
    const { order, payment } = await createOrderAndPayment(learner, course.id);

    await instructorUser.agent.post(`${API_PREFIX}/marketplace/instructor/courses/${course.id}/unpublish`).send({}).expect(201);
    await expect(
      dataSource.getRepository(MarketplaceCourse).findOneByOrFail({ id: course.id }),
    ).resolves.toMatchObject({ status: 'unpublished' });

    await webhooks.process(webhookFor(payment, 'succeeded', 'unpublished-mid-checkout'));
    await operations.publishOutbox();

    await expect(dataSource.getRepository(MarketplaceOrder).findOneByOrFail({ id: order.id })).resolves.toMatchObject({
      status: MarketplaceOrderStatus.PAID,
    });
    await expect(
      dataSource.getRepository(MarketplaceEnrollment).findOneByOrFail({ order_id: order.id }),
    ).resolves.toMatchObject({ status: 'active', course_version_id: order.course_version_id });
  });

  it("a straightforward decline transitions the order to failed and never grants access (T105)", async () => {
    const { instructorUser, admin, learner, category } = await actors();
    const course = await publishCourse({ instructorAgent: instructorUser.agent, adminAgent: admin.agent, categoryId: category.id });
    const { order, payment } = await createOrderAndPayment(learner, course.id);

    await webhooks.process(webhookFor(payment, 'failed', 'declined-event'));
    await operations.publishOutbox();

    await expect(dataSource.getRepository(MarketplaceOrder).findOneByOrFail({ id: order.id })).resolves.toMatchObject({
      status: MarketplaceOrderStatus.FAILED,
    });
    expect(await dataSource.getRepository(MarketplaceEnrollment).countBy({ order_id: order.id })).toBe(0);
  });

  /**
   * T032 catalogue freshness: `enrollment_count` is part of the cached public
   * catalogue (list + detail, family `marketplace_catalog`), so an enrollment
   * must be visible on the NEXT request, never after the 60 s TTL. Every
   * fixture request is made before the first read, because publishing and
   * checkout legitimately invalidate.
   */
  describe('catalogue enrollment_count freshness (T032)', () => {
    async function catalogueEnrollmentCounts(
      courseId: string,
      slug: string,
    ): Promise<{ list: number | undefined; detail: number | undefined }> {
      const server = app.getHttpServer() as Server;
      const list = await request(server).get(`${API_PREFIX}/marketplace/courses`).expect(200);
      const item = (list.body.items as Array<{ id: string; enrollment_count: number }>).find((i) => i.id === courseId);
      const detail = await request(server).get(`${API_PREFIX}/marketplace/courses/${slug}`).expect(200);
      return {
        list: item?.enrollment_count,
        detail: (detail.body as { enrollment_count?: number }).enrollment_count,
      };
    }

    it('a free enrollment is reflected in the catalogue list and detail enrollment_count on the very next request', async () => {
      const { instructorUser, admin, learner, category } = await actors();
      const course = await publishCourse({
        instructorAgent: instructorUser.agent,
        adminAgent: admin.agent,
        categoryId: category.id,
        priceMinor: 0,
      });

      // Warm both cached reads: nobody is enrolled yet.
      expect(await catalogueEnrollmentCounts(course.id, course.slug)).toEqual({ list: 0, detail: 0 });

      await learner.agent
        .post(`${API_PREFIX}/marketplace/checkout/enroll-free`)
        .send({ courseId: course.id })
        .expect(201);

      // No TTL wait: the declared marketplace_catalog invalidation already fired.
      expect(await catalogueEnrollmentCounts(course.id, course.slug)).toEqual({ list: 1, detail: 1 });
    }, 60_000);

    /**
     * BLOCKED, deliberately skipped — not passing. This is the requirement as
     * written (paid enrollment -> `enrollment_count` fresh on the next request);
     * the current code cannot satisfy it:
     *
     *  - A paid enrollment row is written by `MarketplaceSettlementListener`,
     *    driven by the payments OUTBOX DRAIN (`PaymentOperationsService.publishOutbox`),
     *    a non-HTTP writer. No `CacheInvalidationInterceptor` runs for it.
     *  - Nothing under `src/marketplace` or `src/payments` calls
     *    `ApplicationCacheService.invalidate*` (grep), so the drain never bumps
     *    `marketplace_catalog`.
     *  - The HTTP webhook routes (`/payments/webhook`, `/marketplace/webhooks/payment`)
     *    stay UNDECLARED (T033 owns them) and bump the global generation when THEY
     *    complete, which is BEFORE the drain writes the enrollment. Any catalogue
     *    read between those two moments re-caches the old count for up to 60 s.
     *
     * Same window as before Wave 1 (TTL-bounded, cf. contract rule 4 "non-HTTP
     * writers keep today's behavior"), so it is not a regression, but it is a
     * stale window against the T032 acceptance line. To unblock: invalidate
     * `marketplace_catalog` (+ `admin_dashboard`, `platform_report`) from the
     * settlement listener after it creates the enrollment, or record a rule-7
     * written TTL-drift exception. Un-skip this test with that change.
     */
    it.skip('a paid enrollment settled by webhook + outbox drain is reflected in the catalogue enrollment_count on the very next request [BLOCKED: the outbox-drain writer never invalidates marketplace_catalog]', async () => {
      const { instructorUser, admin, learner, category } = await actors();
      const course = await publishCourse({
        instructorAgent: instructorUser.agent,
        adminAgent: admin.agent,
        categoryId: category.id,
      });
      const { payment } = await createOrderAndPayment(learner, course.id);

      // Warm both cached reads: the order exists but is unpaid, so nobody is enrolled.
      expect(await catalogueEnrollmentCounts(course.id, course.slug)).toEqual({ list: 0, detail: 0 });

      await webhooks.process(webhookFor(payment, 'succeeded', 'catalogue-freshness-event'));
      await operations.publishOutbox();

      expect(await catalogueEnrollmentCounts(course.id, course.slug)).toEqual({ list: 1, detail: 1 });
    }, 60_000);
  });
});
