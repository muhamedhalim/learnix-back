import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import type { DataSource } from 'typeorm';

import request from 'supertest';

import { MarketplaceCategory, MarketplaceCourse } from '../../src/marketplace/catalog/entities';
import { LessonContentType, MarketplaceEnrollmentStatus } from '../../src/marketplace/common/enums';
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
import { API_PREFIX, createAuthenticatedUser, createE2EApp, resetDatabase } from './fixtures';

/**
 * T213 (US11 Phase 14, performance/caching). FR-330: the public catalogue
 * (list/detail/curriculum/categories/instructor profile) is cached for at
 * most 60s and reuses `ApplicationCacheService` + the app-wide
 * `CacheInvalidationInterceptor` (already installed as `APP_INTERCEPTOR` in
 * `app.module.ts` — this suite adds no new invalidation code, only new
 * cached reads, exactly matching that AC's "reuses" wording). This proves,
 * against real HTTP + a real DB write that bypasses the API (so a stale
 * read can only mean "served from cache", not "read a row that never
 * changed"): a cache hit is genuinely served from cache, a mutation through
 * the real instructor API invalidates it, and — the isolation half — the
 * one genuinely per-viewer field on the detail response (`viewer_enrollment`)
 * is NEVER contaminated by the shared cache, for either direction (an
 * enrolled learner never sees a cached anonymous view, and caching the
 * anonymous view first never leaks into what an enrolled learner sees
 * next).
 */
describe('marketplace public catalogue cache (Phase 14, T213)', () => {
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

  async function publishCourse(): Promise<{
    instructorUser: Awaited<ReturnType<typeof createAuthenticatedUser>>;
    admin: Awaited<ReturnType<typeof createAuthenticatedUser>>;
    courseId: string;
    slug: string;
  }> {
    const instructorUser = await createAuthenticatedUser(app, dataSource);
    await dataSource.getRepository(MarketplaceInstructor).save(buildInstructorFixture({ user_id: instructorUser.userId }));
    const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
    const category = await dataSource.getRepository(MarketplaceCategory).save({
      name_en: 'Programming',
      name_ar: 'البرمجة',
      slug: `programming-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      display_order: 1,
    });

    const created = await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses`)
      .send({
        title: `Cache Test Course ${Date.now()}`,
        summary: 'Catalogue cache coverage',
        description: 'A full description of the course content.',
        category_id: category.id,
        level: 'beginner',
        language: 'en',
        price_minor: 100000,
        currency: 'EGP',
        cover_image_key: 'covers/cache-101.jpg',
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
    await instructorUser.agent.post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/submit`).send({}).expect(201);
    await admin.agent.post(`${API_PREFIX}/marketplace/admin/courses/${courseId}/approve`).send({}).expect(201);
    await instructorUser.agent.post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/publish`).send({}).expect(201);

    const course = await dataSource.getRepository(MarketplaceCourse).findOneByOrFail({ id: courseId });
    return { instructorUser, admin, courseId, slug: course.slug };
  }

  it('serves the second identical list request from cache — a direct DB write that bypasses the API is not reflected until the cache is invalidated', async () => {
    const { courseId } = await publishCourse();

    const server = app.getHttpServer() as Server;

    const before = await request(server).get(`${API_PREFIX}/marketplace/courses`).expect(200);
    const beforeItem = (before.body.items as Array<{ id: string; price_minor: number }>).find((i) => i.id === courseId);
    expect(beforeItem?.price_minor).toBe(100000);

    // Bypasses the API entirely — no controller runs, so no invalidation fires either.
    await dataSource.getRepository(MarketplaceCourse).update(courseId, { price_minor: 999999 });

    const stillCached = await request(server).get(`${API_PREFIX}/marketplace/courses`).expect(200);
    const stillCachedItem = (stillCached.body.items as Array<{ id: string; price_minor: number }>).find((i) => i.id === courseId);
    expect(stillCachedItem?.price_minor).toBe(100000); // proves this came from cache, not a fresh read
  }, 60_000);

  it('a real mutation through the instructor API invalidates the cache — the next list read is fresh, never stale financial data', async () => {
    const { instructorUser, courseId } = await publishCourse();
    const server = app.getHttpServer() as Server;

    const before = await request(server).get(`${API_PREFIX}/marketplace/courses`).expect(200);
    const beforeItem = (before.body.items as Array<{ id: string; price_minor: number }>).find((i) => i.id === courseId);
    expect(beforeItem?.price_minor).toBe(100000);

    await instructorUser.agent
      .patch(`${API_PREFIX}/marketplace/instructor/courses/${courseId}`)
      .send({ price_minor: 250000 })
      .expect(200);

    const after = await request(server).get(`${API_PREFIX}/marketplace/courses`).expect(200);
    const afterItem = (after.body.items as Array<{ id: string; price_minor: number }>).find((i) => i.id === courseId);
    expect(afterItem?.price_minor).toBe(250000);
  }, 60_000);

  it('the cached detail response never leaks one viewer\'s enrollment status to another — anonymous first, enrolled learner second', async () => {
    const { courseId, slug } = await publishCourse();
    const server = app.getHttpServer() as Server;

    // Anonymous visit first — populates the shared cache entry.
    const anon = await request(server).get(`${API_PREFIX}/marketplace/courses/${slug}`).expect(200);
    expect(anon.body.viewer_enrollment).toEqual({ enrolled: false, enrollment_id: null });

    // A real paid enrollment for a DIFFERENT learner.
    const learner = await createAuthenticatedUser(app, dataSource);
    const orderRes = await learner.agent
      .post(`${API_PREFIX}/marketplace/checkout/orders`)
      .set('Idempotency-Key', `cache-order-${Date.now()}`)
      .send({ courseId })
      .expect(201);
    let order = await dataSource.getRepository(MarketplaceOrder).findOneByOrFail({ id: orderRes.body.id as string });
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
        provider_reference: `provider-cache-${order.id}`,
        paymob_order_id: `provider-cache-${order.id}`,
        status: PaymentStatus.PROCESSING,
        payment_method: PaymentMethod.CARD,
        idempotency_key: `marketplace-checkout:${order.id}`,
      }),
    );
    await dataSource.getRepository(MarketplaceOrder).update(order.id, { payment_id: payment.id });
    const event: ProviderWebhookEvent = {
      provider: 'paymob',
      providerEventId: `cache-settle-${order.id}`,
      merchantReference: payment.id,
      providerOrderReference: payment.paymob_order_id!,
      transactionId: `cache-txn-${order.id}`,
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
    expect(enrollment.status).toBe(MarketplaceEnrollmentStatus.ACTIVE);

    // Immediately after — the enrolled learner's OWN request, while the anonymous view above is still within its 60s cache window.
    const enrolledView = await learner.agent.get(`${API_PREFIX}/marketplace/courses/${slug}`).expect(200);
    expect(enrolledView.body.viewer_enrollment).toEqual({ enrolled: true, enrollment_id: enrollment.id });
    // The shared, cached half of the response is identical either way.
    expect(enrolledView.body.id).toBe(anon.body.id);
    expect(enrolledView.body.snapshot).toEqual(anon.body.snapshot);

    // And a THIRD, different anonymous visitor still sees no enrollment at all.
    const anonAgain = await request(server).get(`${API_PREFIX}/marketplace/courses/${slug}`).expect(200);
    expect(anonAgain.body.viewer_enrollment).toEqual({ enrolled: false, enrollment_id: null });
  }, 60_000);

  it('a signed preview URL is never cached and never appears with a cacheable header', async () => {
    const { slug } = await publishCourse();

    const server = app.getHttpServer() as Server;
    const curriculumRes = await request(server).get(`${API_PREFIX}/marketplace/courses/${slug}/curriculum`).expect(200);
    const freeLesson = (curriculumRes.body.sections as Array<{ lessons: Array<{ id: string; is_free_preview: boolean }> }>)
      .flatMap((s) => s.lessons)
      .find((l) => l.is_free_preview);
    expect(freeLesson).toBeDefined();

    const previewRes = await request(server)
      .get(`${API_PREFIX}/marketplace/courses/${slug}/preview/${freeLesson!.id}`)
      .expect(200);
    expect(previewRes.headers['cache-control']).toBe('no-store');
  }, 60_000);
});
