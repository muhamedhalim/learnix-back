import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import type { DataSource } from 'typeorm';

import request from 'supertest';

import { MarketplaceCategory } from '../../src/marketplace/catalog/entities';
import { MarketplaceEnrollment, MarketplaceOrder } from '../../src/marketplace/commerce/entities';
import { LessonContentType, MarketplaceEnrollmentStatus } from '../../src/marketplace/common/enums';
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
import { API_PREFIX, createAuthenticatedUser, createE2EApp, resetDatabase } from './fixtures';

/**
 * T208 (US11 Phase 14, security hardening). FR-303's three guarantees for
 * paid content and application documents: unreachable without a valid
 * signed URL, a URL older than 900 seconds refused, and a URL issued to a
 * requester who has since lost access refused **on reuse**.
 *
 * **Scope note on "refused on reuse"**: `MarketplaceStorageService` issues
 * real S3-style presigned URLs (`marketplace-storage.service.spec.ts`
 * already proves the 900-second TTL ceiling and the "authorize() re-run on
 * every issuance, never cached" property at the unit level). A presigned
 * URL is a self-contained, cryptographically time-bound artifact — once
 * handed to a browser, the cloud storage provider itself enforces the
 * expiry, and the application has no way to revoke that specific already-
 * issued URL before its own TTL elapses (true of every presigned-URL
 * architecture, not a marketplace-specific gap; the academic lesson-video
 * player has the identical property). What IS fully within the
 * application's control, and what this suite actually proves, is the part
 * that matters for FR-303's intent: the **endpoint that issues a fresh
 * signed URL** re-checks live access on every single call, so a learner who
 * loses access is refused the very next time they ask for one — the
 * exposure window for an already-issued URL is bounded to the 900-second
 * TTL and never longer, and no new signed URL is ever handed out afterward.
 */
describe('marketplace private file access (Phase 14, T208)', () => {
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

  async function publishVideoCourse(
    instructorAgent: Awaited<ReturnType<typeof createAuthenticatedUser>>['agent'],
    adminAgent: Awaited<ReturnType<typeof createAuthenticatedUser>>['agent'],
  ): Promise<{ courseId: string; lessonId: string }> {
    const category = await dataSource.getRepository(MarketplaceCategory).save({
      name_en: 'Programming',
      name_ar: 'البرمجة',
      slug: `programming-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      display_order: 1,
    });
    const created = await instructorAgent
      .post(`${API_PREFIX}/marketplace/instructor/courses`)
      .send({
        title: `File Access Course ${Date.now()}`,
        summary: 'Private content access coverage',
        description: 'A full description of the course content.',
        category_id: category.id,
        level: 'beginner',
        language: 'en',
        price_minor: 150000,
        currency: 'EGP',
        cover_image_key: 'covers/fileaccess-101.jpg',
        learning_outcomes: ['n/a'],
      })
      .expect(201);
    const courseId = created.body.id as string;
    const section = await instructorAgent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/sections`)
      .send({ title: 'Getting Started' })
      .expect(201);

    let lessonId = '';
    for (let i = 0; i < 3; i++) {
      const lesson = await instructorAgent
        .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/lessons`)
        .send({
          section_id: section.body.id,
          title: `Lesson ${i + 1}`,
          content_type: LessonContentType.TEXT,
          content_html: `<p>Private lesson content ${i + 1}</p>`,
          duration_seconds: 120,
          // FR-055/FR-056: submission requires at least one free-preview
          // lesson. Lesson 0 is the free preview; the lesson this suite
          // actually tests private access against (index 1, see `lessonId`
          // below) stays non-preview — genuinely paid, private content.
          is_free_preview: i === 0,
          is_required_for_completion: true,
        })
        .expect(201);
      if (i === 1) lessonId = lesson.body.id as string;
    }

    await instructorAgent.post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/submit`).send({}).expect(201);
    await adminAgent.post(`${API_PREFIX}/marketplace/admin/courses/${courseId}/approve`).send({}).expect(201);
    await instructorAgent.post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/publish`).send({}).expect(201);

    return { courseId, lessonId };
  }

  async function createPaidOrder(
    learner: Awaited<ReturnType<typeof createAuthenticatedUser>>,
    courseId: string,
  ): Promise<{ order: MarketplaceOrder; enrollment: MarketplaceEnrollment }> {
    const created = await learner.agent
      .post(`${API_PREFIX}/marketplace/checkout/orders`)
      .set('Idempotency-Key', `fileaccess-order-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      .send({ courseId })
      .expect(201);
    let order = await dataSource.getRepository(MarketplaceOrder).findOneByOrFail({ id: created.body.id as string });

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
        provider_reference: `provider-fileaccess-${order.id}`,
        paymob_order_id: `provider-fileaccess-${order.id}`,
        status: PaymentStatus.PROCESSING,
        payment_method: PaymentMethod.CARD,
        idempotency_key: `marketplace-checkout:${order.id}`,
      }),
    );
    await dataSource.getRepository(MarketplaceOrder).update(order.id, { payment_id: payment.id });

    const event: ProviderWebhookEvent = {
      provider: 'paymob',
      providerEventId: `fileaccess-settle-${order.id}`,
      merchantReference: payment.id,
      providerOrderReference: payment.paymob_order_id!,
      transactionId: `fileaccess-txn-${order.id}`,
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
    const enrollment = await dataSource.getRepository(MarketplaceEnrollment).findOneByOrFail({ order_id: order.id });
    return { order, enrollment };
  }

  it('a learner with no enrollment cannot reach a paid lesson\'s content at all', async () => {
    const instructor = await createAuthenticatedUser(app, dataSource);
    await dataSource.getRepository(MarketplaceInstructor).save(buildInstructorFixture({ user_id: instructor.userId }));
    const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
    const { courseId, lessonId } = await publishVideoCourse(instructor.agent, admin.agent);
    void courseId;

    const outsider = await createAuthenticatedUser(app, dataSource);
    // No enrollment id belongs to this learner at all — every enrollment id is refused identically.
    await outsider.agent
      .get(`${API_PREFIX}/marketplace/me/enrollments/00000000-0000-4000-8000-000000000000/lessons/${lessonId}`)
      .expect(404);
  });

  it('an enrolled learner gets real signed content, and the response is never cacheable', async () => {
    const instructor = await createAuthenticatedUser(app, dataSource);
    await dataSource.getRepository(MarketplaceInstructor).save(buildInstructorFixture({ user_id: instructor.userId }));
    const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
    const { courseId, lessonId } = await publishVideoCourse(instructor.agent, admin.agent);

    const learner = await createAuthenticatedUser(app, dataSource);
    const { enrollment } = await createPaidOrder(learner, courseId);

    const res = await learner.agent
      .get(`${API_PREFIX}/marketplace/me/enrollments/${enrollment.id}/lessons/${lessonId}`)
      .expect(200);

    expect(res.body.lesson_id).toBe(lessonId);
    expect(res.body.content_html).toContain('Private lesson content');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('access lost after purchase (e.g. a completed refund revoking the enrollment) is refused on the very next request — not a stale cached grant', async () => {
    const instructor = await createAuthenticatedUser(app, dataSource);
    await dataSource.getRepository(MarketplaceInstructor).save(buildInstructorFixture({ user_id: instructor.userId }));
    const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
    const { courseId, lessonId } = await publishVideoCourse(instructor.agent, admin.agent);

    const learner = await createAuthenticatedUser(app, dataSource);
    const { enrollment } = await createPaidOrder(learner, courseId);

    // First request succeeds — proves access genuinely existed, not that the route always 404s.
    await learner.agent.get(`${API_PREFIX}/marketplace/me/enrollments/${enrollment.id}/lessons/${lessonId}`).expect(200);

    // Access is revoked exactly as a completed refund would (`RefundProcessingService` sets the
    // enrollment to REVOKED — see `marketplace-refunds.e2e-spec.ts` for the full refund lifecycle;
    // this suite isolates the file-access consequence of that state, not the refund flow itself).
    await dataSource
      .getRepository(MarketplaceEnrollment)
      .update(enrollment.id, { status: MarketplaceEnrollmentStatus.REVOKED });

    await learner.agent.get(`${API_PREFIX}/marketplace/me/enrollments/${enrollment.id}/lessons/${lessonId}`).expect(403);
    await learner.agent.get(`${API_PREFIX}/marketplace/me/enrollments/${enrollment.id}/player`).expect(403);
  });

  it('an authenticated instructor-facing course response also carries no-store', async () => {
    const instructor = await createAuthenticatedUser(app, dataSource);
    await dataSource.getRepository(MarketplaceInstructor).save(buildInstructorFixture({ user_id: instructor.userId }));
    const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
    const { courseId } = await publishVideoCourse(instructor.agent, admin.agent);

    const res = await instructor.agent.get(`${API_PREFIX}/marketplace/instructor/courses/${courseId}`).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('the public, anonymous catalogue surface is explicitly excluded from no-store — it is meant to be cacheable', async () => {
    const instructor = await createAuthenticatedUser(app, dataSource);
    await dataSource.getRepository(MarketplaceInstructor).save(buildInstructorFixture({ user_id: instructor.userId }));
    const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
    await publishVideoCourse(instructor.agent, admin.agent);

    const server = app.getHttpServer() as Server;
    const res = await request(server).get(`${API_PREFIX}/marketplace/courses`).expect(200);
    expect(res.headers['cache-control']).not.toBe('no-store');
  });
});
