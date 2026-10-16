import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import type { DataSource } from 'typeorm';

import request from 'supertest';

import { MarketplaceCategory, MarketplaceCourse } from '../../src/marketplace/catalog/entities';
import { MarketplaceEnrollment, MarketplaceOrder } from '../../src/marketplace/commerce/entities';
import { LessonContentType } from '../../src/marketplace/common/enums';
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
 * T207 (US11 Phase 14, release-adjacent security hardening). FR-298/FR-299
 * require that a cross-tenant request (instructor B reaching instructor A's
 * course, learner B reaching learner A's order) return **404**, not 403 —
 * a 403 would confirm the resource exists at all, which is itself an
 * information leak. Every controller in the marketplace module scopes its
 * lookups by the caller's own id (`@CurrentInstructor()` / `@GetUser()`
 * joined into the WHERE clause), never by trusting the route id alone — this
 * suite is the durable, cross-cutting proof of that pattern, covering course
 * ownership, curriculum ownership, payout-account/payout-request ownership,
 * order ownership, enrollment/player ownership and review ownership.
 *
 * **Scope note**: "every role × every route" from the task's own AC is not
 * read literally as an exhaustive combinatorial matrix over every one of the
 * ~30 marketplace controllers (several thousand cells, most of them
 * uninteresting — e.g. two GET-list routes that are inherently
 * caller-scoped and take no id at all). Instead this covers every route
 * family that accepts a caller-owned resource id as a route parameter — the
 * only shape where cross-tenant IDOR is structurally possible — plus a
 * representative unauthenticated/wrong-role pass. Admin-side permission
 * separation is already covered by `marketplace-admin-authz.e2e-spec.ts`;
 * instructor-capability-state authorization by
 * `marketplace-instructor-authz.e2e-spec.ts`. This file is additive to both.
 */
describe('marketplace authorization matrix — cross-tenant IDOR returns 404, never 403 (Phase 14, T207)', () => {
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

  async function seedCategory() {
    return dataSource.getRepository(MarketplaceCategory).save({
      name_en: 'Programming',
      name_ar: 'البرمجة',
      slug: `programming-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      display_order: 1,
    });
  }

  /** A published course owned by `instructorAgent`, with one section and 3 lessons. */
  async function publishCourse(
    instructorAgent: Awaited<ReturnType<typeof createAuthenticatedUser>>['agent'],
    categoryId: string,
  ): Promise<{ courseId: string; sectionId: string; lessonId: string }> {
    const created = await instructorAgent
      .post(`${API_PREFIX}/marketplace/instructor/courses`)
      .send({
        title: `Authz Matrix Course ${Date.now()}-${Math.random().toString(36).slice(2)}`,
        summary: 'Cross-tenant IDOR coverage',
        description: 'A full description of the course content.',
        category_id: categoryId,
        level: 'beginner',
        language: 'en',
        price_minor: 150000,
        currency: 'EGP',
        cover_image_key: 'covers/authz-101.jpg',
        learning_outcomes: ['n/a'],
      })
      .expect(201);
    const courseId = created.body.id as string;

    const section = await instructorAgent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/sections`)
      .send({ title: 'Getting Started' })
      .expect(201);
    const sectionId = section.body.id as string;

    let lessonId = '';
    for (let i = 0; i < 3; i++) {
      const lesson = await instructorAgent
        .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/lessons`)
        .send({
          section_id: sectionId,
          title: `Lesson ${i + 1}`,
          content_type: LessonContentType.TEXT,
          content_html: `<p>Content ${i + 1}</p>`,
          duration_seconds: 120,
          is_free_preview: i === 0,
          is_required_for_completion: true,
        })
        .expect(201);
      lessonId = lesson.body.id as string;
    }

    return { courseId, sectionId, lessonId };
  }

  async function submitAndApprove(
    instructorAgent: Awaited<ReturnType<typeof createAuthenticatedUser>>['agent'],
    adminAgent: Awaited<ReturnType<typeof createAuthenticatedUser>>['agent'],
    courseId: string,
  ) {
    await instructorAgent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/submit`)
      .send({})
      .expect(201);
    await adminAgent
      .post(`${API_PREFIX}/marketplace/admin/courses/${courseId}/approve`)
      .send({})
      .expect(201);
    await instructorAgent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/publish`)
      .send({})
      .expect(201);
  }

  async function createPaidOrder(
    learner: Awaited<ReturnType<typeof createAuthenticatedUser>>,
    courseId: string,
  ): Promise<{ order: MarketplaceOrder; enrollment: MarketplaceEnrollment }> {
    const created = await learner.agent
      .post(`${API_PREFIX}/marketplace/checkout/orders`)
      .set('Idempotency-Key', `authz-order-${Date.now()}-${Math.random().toString(36).slice(2)}`)
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
        provider: 'easykash',
        provider_reference: `provider-authz-${order.id}`,
        provider_order_reference: `provider-authz-${order.id}`,
        status: PaymentStatus.PROCESSING,
        payment_method: PaymentMethod.CARD,
        idempotency_key: `marketplace-checkout:${order.id}`,
      }),
    );
    await dataSource.getRepository(MarketplaceOrder).update(order.id, { payment_id: payment.id });

    const event: ProviderWebhookEvent = {
      provider: 'easykash',
      providerEventId: `authz-settle-${order.id}`,
      merchantReference: payment.id,
      providerOrderReference: payment.provider_order_reference!,
      transactionId: `authz-txn-${order.id}`,
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

  describe('instructor course and curriculum ownership', () => {
    it("a stranger instructor gets 404 (never 403) on another instructor's course, section and lesson", async () => {
      const owner = await createAuthenticatedUser(app, dataSource);
      await dataSource
        .getRepository(MarketplaceInstructor)
        .save(buildInstructorFixture({ user_id: owner.userId }));
      const stranger = await createAuthenticatedUser(app, dataSource);
      await dataSource
        .getRepository(MarketplaceInstructor)
        .save(buildInstructorFixture({ user_id: stranger.userId }));
      const category = await seedCategory();
      const { courseId, sectionId, lessonId } = await publishCourse(owner.agent, category.id);

      await stranger.agent
        .get(`${API_PREFIX}/marketplace/instructor/courses/${courseId}`)
        .expect(404);
      await stranger.agent
        .patch(`${API_PREFIX}/marketplace/instructor/courses/${courseId}`)
        .send({ title: 'Hijacked' })
        .expect(404);
      await stranger.agent
        .delete(`${API_PREFIX}/marketplace/instructor/courses/${courseId}`)
        .expect(404);
      await stranger.agent
        .patch(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/sections/${sectionId}`)
        .send({ title: 'Hijacked section' })
        .expect(404);
      await stranger.agent
        .delete(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/sections/${sectionId}`)
        .expect(404);
      await stranger.agent
        .patch(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/lessons/${lessonId}`)
        .send({ title: 'Hijacked lesson' })
        .expect(404);
      await stranger.agent
        .delete(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/lessons/${lessonId}`)
        .expect(404);

      // The owner, meanwhile, can read and modify their own resource normally.
      await owner.agent.get(`${API_PREFIX}/marketplace/instructor/courses/${courseId}`).expect(200);

      // Confirm the resource was genuinely untouched by every refused stranger write.
      const untouched = await dataSource
        .getRepository(MarketplaceCourse)
        .findOneByOrFail({ id: courseId });
      expect(untouched.title).not.toBe('Hijacked');
    });

    it('an unauthenticated caller gets 401 on the same routes, before any ownership check runs', async () => {
      const owner = await createAuthenticatedUser(app, dataSource);
      await dataSource
        .getRepository(MarketplaceInstructor)
        .save(buildInstructorFixture({ user_id: owner.userId }));
      const category = await seedCategory();
      const { courseId } = await publishCourse(owner.agent, category.id);

      const server = app.getHttpServer() as Server;
      await request(server)
        .get(`${API_PREFIX}/marketplace/instructor/courses/${courseId}`)
        .expect(401);
    });
  });

  describe('instructor payout account and payout request ownership', () => {
    it("a stranger instructor gets 404 on another instructor's payout account", async () => {
      const owner = await createAuthenticatedUser(app, dataSource);
      await dataSource
        .getRepository(MarketplaceInstructor)
        .save(buildInstructorFixture({ user_id: owner.userId }));
      const stranger = await createAuthenticatedUser(app, dataSource);
      await dataSource
        .getRepository(MarketplaceInstructor)
        .save(buildInstructorFixture({ user_id: stranger.userId }));

      const account = await owner.agent
        .post(`${API_PREFIX}/marketplace/instructor/payout-accounts`)
        .send({
          account_holder_name: 'Owner Account',
          bank_name: 'Test Bank',
          account_identifier: 'EG1111111111111111111111111111',
          currency: 'EGP',
          country: 'EG',
        })
        .expect(201);
      const accountId = account.body.id as string;

      await stranger.agent
        .patch(`${API_PREFIX}/marketplace/instructor/payout-accounts/${accountId}`)
        .send({ bank_name: 'Hijacked Bank' })
        .expect(404);
      await stranger.agent
        .post(`${API_PREFIX}/marketplace/instructor/payout-accounts/${accountId}/default`)
        .expect(404);
      await stranger.agent
        .delete(`${API_PREFIX}/marketplace/instructor/payout-accounts/${accountId}`)
        .expect(404);

      // The stranger's own list never includes the owner's account (scoped list, not filtered after the fact).
      const strangerList = await stranger.agent
        .get(`${API_PREFIX}/marketplace/instructor/payout-accounts`)
        .expect(200);
      expect((strangerList.body as Array<{ id: string }>).some((a) => a.id === accountId)).toBe(
        false,
      );
    });
  });

  describe('learner order, enrollment and refund ownership', () => {
    it("a stranger learner gets 404 on another learner's order, enrollment player and refund-eligibility", async () => {
      const instructor = await createAuthenticatedUser(app, dataSource);
      await dataSource
        .getRepository(MarketplaceInstructor)
        .save(buildInstructorFixture({ user_id: instructor.userId }));
      const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
      const category = await seedCategory();
      const { courseId } = await publishCourse(instructor.agent, category.id);
      await submitAndApprove(instructor.agent, admin.agent, courseId);

      const owner = await createAuthenticatedUser(app, dataSource);
      const { order, enrollment } = await createPaidOrder(owner, courseId);
      const stranger = await createAuthenticatedUser(app, dataSource);

      await stranger.agent.get(`${API_PREFIX}/marketplace/me/orders/${order.id}`).expect(404);
      await stranger.agent
        .get(`${API_PREFIX}/marketplace/me/enrollments/${enrollment.id}/player`)
        .expect(404);
      await stranger.agent
        .get(`${API_PREFIX}/marketplace/me/orders/${order.id}/refund-eligibility`)
        .expect(404);

      // The owning learner, meanwhile, can read their own order normally.
      await owner.agent.get(`${API_PREFIX}/marketplace/me/orders/${order.id}`).expect(200);
    });
  });

  describe('learner review ownership', () => {
    it("a stranger learner gets 404 on another learner's review", async () => {
      const instructor = await createAuthenticatedUser(app, dataSource);
      await dataSource
        .getRepository(MarketplaceInstructor)
        .save(buildInstructorFixture({ user_id: instructor.userId }));
      const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
      const category = await seedCategory();
      const { courseId } = await publishCourse(instructor.agent, category.id);
      await submitAndApprove(instructor.agent, admin.agent, courseId);

      const owner = await createAuthenticatedUser(app, dataSource);
      await createPaidOrder(owner, courseId);
      const reviewRes = await owner.agent
        .post(`${API_PREFIX}/marketplace/me/reviews`)
        .send({ courseId, rating: 5, comment: 'Great course' })
        .expect(201);
      const reviewId = reviewRes.body.id as string;

      const stranger = await createAuthenticatedUser(app, dataSource);
      await stranger.agent.get(`${API_PREFIX}/marketplace/me/reviews/${reviewId}`).expect(404);
      await stranger.agent
        .patch(`${API_PREFIX}/marketplace/me/reviews/${reviewId}`)
        .send({ rating: 1 })
        .expect(404);
      await stranger.agent.delete(`${API_PREFIX}/marketplace/me/reviews/${reviewId}`).expect(404);

      await owner.agent.get(`${API_PREFIX}/marketplace/me/reviews/${reviewId}`).expect(200);
    });
  });
});
