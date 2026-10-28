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
import { createEnrolledStudent } from './helpers/enrolled-student';
import { TEST_IMAGE_KEY } from './helpers/images';

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
    await dataSource
      .getRepository(MarketplaceInstructor)
      .save(buildInstructorFixture({ user_id: instructorUser.userId }));
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

    const course = await dataSource
      .getRepository(MarketplaceCourse)
      .findOneByOrFail({ id: courseId });
    return { instructorUser, admin, courseId, slug: course.slug };
  }

  it('serves the second identical list request from cache — a direct DB write that bypasses the API is not reflected until the cache is invalidated', async () => {
    const { courseId } = await publishCourse();

    const server = app.getHttpServer() as Server;

    const before = await request(server).get(`${API_PREFIX}/marketplace/courses`).expect(200);
    const beforeItem = (before.body.items as Array<{ id: string; price_minor: number }>).find(
      (i) => i.id === courseId,
    );
    expect(beforeItem?.price_minor).toBe(100000);

    // Bypasses the API entirely — no controller runs, so no invalidation fires either.
    await dataSource.getRepository(MarketplaceCourse).update(courseId, { price_minor: 999999 });

    const stillCached = await request(server).get(`${API_PREFIX}/marketplace/courses`).expect(200);
    const stillCachedItem = (
      stillCached.body.items as Array<{ id: string; price_minor: number }>
    ).find((i) => i.id === courseId);
    expect(stillCachedItem?.price_minor).toBe(100000); // proves this came from cache, not a fresh read
  }, 60_000);

  it('a real mutation through the instructor API invalidates the cache — the next list read is fresh, never stale financial data', async () => {
    const { instructorUser, courseId } = await publishCourse();
    const server = app.getHttpServer() as Server;

    const before = await request(server).get(`${API_PREFIX}/marketplace/courses`).expect(200);
    const beforeItem = (before.body.items as Array<{ id: string; price_minor: number }>).find(
      (i) => i.id === courseId,
    );
    expect(beforeItem?.price_minor).toBe(100000);

    await instructorUser.agent
      .patch(`${API_PREFIX}/marketplace/instructor/courses/${courseId}`)
      .send({ price_minor: 250000 })
      .expect(200);

    const after = await request(server).get(`${API_PREFIX}/marketplace/courses`).expect(200);
    const afterItem = (after.body.items as Array<{ id: string; price_minor: number }>).find(
      (i) => i.id === courseId,
    );
    expect(afterItem?.price_minor).toBe(250000);
  }, 60_000);

  it("the cached detail response never leaks one viewer's enrollment status to another — anonymous first, enrolled learner second", async () => {
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
        provider_reference: `provider-cache-${order.id}`,
        provider_order_reference: `provider-cache-${order.id}`,
        status: PaymentStatus.PROCESSING,
        payment_method: PaymentMethod.CARD,
        idempotency_key: `marketplace-checkout:${order.id}`,
      }),
    );
    await dataSource.getRepository(MarketplaceOrder).update(order.id, { payment_id: payment.id });
    const event: ProviderWebhookEvent = {
      provider: 'easykash',
      providerEventId: `cache-settle-${order.id}`,
      merchantReference: payment.id,
      providerOrderReference: payment.provider_order_reference!,
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
    const enrollment = await dataSource
      .getRepository(MarketplaceEnrollment)
      .findOneByOrFail({ order_id: order.id });
    expect(enrollment.status).toBe(MarketplaceEnrollmentStatus.ACTIVE);

    // Immediately after — the enrolled learner's OWN request, while the anonymous view above is still within its 60s cache window.
    const enrolledView = await learner.agent
      .get(`${API_PREFIX}/marketplace/courses/${slug}`)
      .expect(200);
    expect(enrolledView.body.viewer_enrollment).toEqual({
      enrolled: true,
      enrollment_id: enrollment.id,
    });
    // The shared, cached half of the response is identical either way.
    expect(enrolledView.body.id).toBe(anon.body.id);
    expect(enrolledView.body.snapshot).toEqual(anon.body.snapshot);

    // And a THIRD, different anonymous visitor still sees no enrollment at all.
    const anonAgain = await request(server)
      .get(`${API_PREFIX}/marketplace/courses/${slug}`)
      .expect(200);
    expect(anonAgain.body.viewer_enrollment).toEqual({ enrolled: false, enrollment_id: null });
  }, 60_000);

  it('a signed preview URL is never cached and never appears with a cacheable header', async () => {
    const { slug } = await publishCourse();

    const server = app.getHttpServer() as Server;
    const curriculumRes = await request(server)
      .get(`${API_PREFIX}/marketplace/courses/${slug}/curriculum`)
      .expect(200);
    const freeLesson = (
      curriculumRes.body.sections as Array<{
        lessons: Array<{ id: string; is_free_preview: boolean }>;
      }>
    )
      .flatMap((s) => s.lessons)
      .find((l) => l.is_free_preview);
    expect(freeLesson).toBeDefined();

    const previewRes = await request(server)
      .get(`${API_PREFIX}/marketplace/courses/${slug}/preview/${freeLesson!.id}`)
      .expect(200);
    expect(previewRes.headers['cache-control']).toBe('private, no-store');
    expect(previewRes.headers['cache-control']).not.toMatch(/public|s-maxage/);
  }, 60_000);

  /**
   * Wave 1 (T030, T031): mutations that write nothing the catalogue reads must
   * no longer evict it. Same DB-bypass technique as the first test: a price
   * change made directly in the database can only become visible if the cached
   * list entry was invalidated, so seeing the OLD price proves the entry
   * survived the unrelated request. Every fixture request (publishing, user
   * registration, subject creation) happens BEFORE the list is warmed, because
   * those legitimately invalidate.
   */
  describe('catalogue survives unrelated mutations (T030, T031)', () => {
    async function warmListThenBypassPriceChange(courseId: string): Promise<void> {
      const server = app.getHttpServer() as Server;
      const warmed = await request(server).get(`${API_PREFIX}/marketplace/courses`).expect(200);
      const warmedItem = (warmed.body.items as Array<{ id: string; price_minor: number }>).find(
        (i) => i.id === courseId,
      );
      expect(warmedItem?.price_minor).toBe(100000);

      // Bypasses the API entirely — no controller runs, so no invalidation fires either.
      await dataSource.getRepository(MarketplaceCourse).update(courseId, { price_minor: 999999 });
    }

    async function expectListStillServesCachedPrice(courseId: string): Promise<void> {
      const server = app.getHttpServer() as Server;
      const after = await request(server).get(`${API_PREFIX}/marketplace/courses`).expect(200);
      const afterItem = (after.body.items as Array<{ id: string; price_minor: number }>).find(
        (i) => i.id === courseId,
      );
      expect(afterItem?.price_minor).toBe(100000); // the DB now says 999999: only a surviving cache entry can answer 100000
    }

    it('a notifications read-all does not evict the cached catalogue list (T030)', async () => {
      const { courseId } = await publishCourse();
      const learner = await createAuthenticatedUser(app, dataSource);
      await warmListThenBypassPriceChange(courseId);

      await learner.agent.post(`${API_PREFIX}/notifications/read-all`).expect(201);

      await expectListStillServesCachedPrice(courseId);
    }, 60_000);

    it('a declared academic mutation (student lesson progress) does not evict the cached marketplace list (T031)', async () => {
      const { courseId } = await publishCourse();
      const { student, lesson } = await createEnrolledStudent(app, dataSource);
      await warmListThenBypassPriceChange(courseId);

      // Declared with `@InvalidatesCache([...])`: it bumps only this student's own `student_report` and
      // `student_quiz_analytics` (T040) slices, so neither the global generation nor `marketplace_catalog` moves.
      const res = await student.agent
        .post(`${API_PREFIX}/student/lessons/${lesson.id}/progress`)
        .send({ watchedDuration: 60 });
      expect([200, 201]).toContain(res.status);

      await expectListStillServesCachedPrice(courseId);
    }, 60_000);

    /**
     * The contrast case. A teacher creating a lesson is an ACADEMIC mutation but is
     * UNDECLARED, so it takes the correctness fallback (contract rule 1): the global
     * generation is bumped, and every family's key material includes the global
     * generation, so the catalogue is evicted along with everything else. Only routes
     * that declare their families (or are exempt) stop evicting it. Pinning this keeps
     * "undeclared routes still global" (T031 acceptance) honest.
     */
    it('an UNDECLARED academic mutation (teacher creates a lesson) still evicts the list through the global fallback (T031: undeclared routes stay global)', async () => {
      const { courseId } = await publishCourse();
      const teacher = await createAuthenticatedUser(app, dataSource, {
        role: 'teacher',
        overrides: { requestedRole: 'teacher' },
      });
      const subject = await teacher.agent
        .post(`${API_PREFIX}/teacher/subjects`)
        .send({
          name: `Catalogue cache subject ${Date.now()}-${Math.random().toString(36).slice(2)}`,
        })
        .expect(201);
      await warmListThenBypassPriceChange(courseId);

      await teacher.agent
        .post(`${API_PREFIX}/teacher/lessons`)
        .send({
          title: 'Academic lesson',
          subject_id: (subject.body as { subject: { id: string } }).subject.id,
          price: 0,
          is_group: true,
        })
        .expect(201);

      const server = app.getHttpServer() as Server;
      const after = await request(server).get(`${API_PREFIX}/marketplace/courses`).expect(200);
      const afterItem = (after.body.items as Array<{ id: string; price_minor: number }>).find(
        (i) => i.id === courseId,
      );
      expect(afterItem?.price_minor).toBe(999999); // global bump: the cached entry is unreachable, the DB value is read fresh
    }, 60_000);
  });
});
