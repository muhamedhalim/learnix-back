import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { LessonContentType, MarketplaceOrderStatus } from '../../src/marketplace/common/enums';
import { MarketplaceCategory, MarketplaceCourse } from '../../src/marketplace/catalog/entities';
import { InstructorEarning } from '../../src/marketplace/earnings/entities/instructor-earning.entity';
import { MarketplaceLedgerEntry } from '../../src/marketplace/earnings/entities/marketplace-ledger-entry.entity';
import { MarketplaceEnrollment, MarketplaceOrder } from '../../src/marketplace/commerce/entities';
import { MarketplaceInstructor } from '../../src/marketplace/instructors/entities/marketplace-instructor.entity';
import { buildInstructorFixture } from './factories/marketplace.factory';
import { API_PREFIX, createAuthenticatedUser, createE2EApp, resetDatabase, setUserRole } from './fixtures';
import { TEST_IMAGE_KEY } from './helpers/images';

/**
 * T110 — contracts §4's free-enrollment block end to end (FR-111 – FR-114,
 * FR-121). Independent test per tasks.md Phase 7: enroll free → access
 * granted → no earning, no commission, no ledger entry → counted in
 * acquisition reporting, excluded from revenue (the acquisition/revenue
 * split itself is T113's `MarketplaceReportingService`, verified there —
 * this suite proves the zero-financial-trace half plus the abuse controls).
 */
describe('marketplace free enrollment (contracts §4, T110)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    ({ app, dataSource } = await createE2EApp());
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

  async function publishFreeCourse(opts: {
    instructorAgent: Awaited<ReturnType<typeof createAuthenticatedUser>>['agent'];
    adminAgent: Awaited<ReturnType<typeof createAuthenticatedUser>>['agent'];
    categoryId: string;
    title?: string;
  }) {
    const created = await opts.instructorAgent
      .post(`${API_PREFIX}/marketplace/instructor/courses`)
      .send({
        title: opts.title ?? `Free Course ${Date.now()}-${Math.random().toString(36).slice(2)}`,
        summary: 'Learn for free',
        description: 'A full description of the free course content.',
        category_id: opts.categoryId,
        level: 'beginner',
        language: 'en',
        price_minor: 0,
        currency: 'EGP',
        cover_image_key: TEST_IMAGE_KEY,
        learning_outcomes: ['Get started'],
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

  async function actors() {
    const instructorUser = await createAuthenticatedUser(app, dataSource);
    await seedInstructor(instructorUser.userId);
    const admin = await createAuthenticatedUser(app, dataSource);
    await setUserRole(dataSource, admin.userId, 'admin');
    const learner = await createAuthenticatedUser(app, dataSource);
    const category = await seedCategory();
    return { instructorUser, admin, learner, category };
  }

  it('grants access with a zero-value order and no gateway interaction, and leaves absolutely no financial trace (FR-111 – FR-114)', async () => {
    const { instructorUser, admin, learner, category } = await actors();
    const course = await publishFreeCourse({ instructorAgent: instructorUser.agent, adminAgent: admin.agent, categoryId: category.id });

    const res = await learner.agent
      .post(`${API_PREFIX}/marketplace/checkout/enroll-free`)
      .send({ courseId: course.id })
      .expect(201);

    expect(res.body).toMatchObject({ status: MarketplaceOrderStatus.PAID, is_zero_value: true, net_amount_minor: 0 });
    const order = await dataSource.getRepository(MarketplaceOrder).findOneByOrFail({ id: res.body.id as string });
    await expect(
      dataSource.getRepository(MarketplaceEnrollment).findOneByOrFail({ order_id: order.id }),
    ).resolves.toMatchObject({ status: 'active', learner_id: learner.userId, course_id: course.id });
    expect(await dataSource.getRepository(InstructorEarning).countBy({ order_id: order.id })).toBe(0);
    expect(await dataSource.getRepository(MarketplaceLedgerEntry).countBy({ order_id: order.id })).toBe(0);
  });

  it('refuses a second free enrollment for the same course (already open/paid) — the same duplicate rule paid orders get (FR-095, FR-096)', async () => {
    const { instructorUser, admin, learner, category } = await actors();
    const course = await publishFreeCourse({ instructorAgent: instructorUser.agent, adminAgent: admin.agent, categoryId: category.id });

    await learner.agent.post(`${API_PREFIX}/marketplace/checkout/enroll-free`).send({ courseId: course.id }).expect(201);
    await learner.agent.post(`${API_PREFIX}/marketplace/checkout/enroll-free`).send({ courseId: course.id }).expect(409);
  });

  it("refuses an instructor enrolling free in their own course (FR-098's self-purchase rule applies here too)", async () => {
    const { instructorUser, admin, category } = await actors();
    const course = await publishFreeCourse({ instructorAgent: instructorUser.agent, adminAgent: admin.agent, categoryId: category.id });

    await instructorUser.agent.post(`${API_PREFIX}/marketplace/checkout/enroll-free`).send({ courseId: course.id }).expect(403);
  });

  it('refuses free enrollment in a paid course — this endpoint only ever grants a genuinely zero-value order', async () => {
    const { instructorUser, admin, learner, category } = await actors();
    const created = await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses`)
      .send({
        title: `Paid Course ${Date.now()}`,
        summary: 'Learn to pay',
        description: 'A full description of the paid course content.',
        category_id: category.id,
        level: 'beginner',
        language: 'en',
        price_minor: 5000,
        currency: 'EGP',
        cover_image_key: TEST_IMAGE_KEY,
        learning_outcomes: ['Pay up'],
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
        .send({ section_id: section.body.id, title: `Lesson ${i + 1}`, content_type: LessonContentType.TEXT, content_html: '<p>x</p>', duration_seconds: 60, is_free_preview: i === 0 })
        .expect(201);
    }
    await instructorUser.agent.post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/submit`).send({}).expect(201);
    await admin.agent.post(`${API_PREFIX}/marketplace/admin/courses/${courseId}/approve`).send({}).expect(201);
    await instructorUser.agent.post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/publish`).send({}).expect(201);

    const refused = await learner.agent.post(`${API_PREFIX}/marketplace/checkout/enroll-free`).send({ courseId }).expect(422);
    expect(refused.body).toMatchObject({ code: 'COURSE_NOT_FREE' });
    expect(await dataSource.getRepository(MarketplaceEnrollment).countBy({ course_id: courseId })).toBe(0);
    expect(await dataSource.getRepository(MarketplaceOrder).countBy({ course_id: courseId })).toBe(0);
  });

  it('refuses the 6th free-enrollment request within a minute, per account, naming per_minute (FR-121)', async () => {
    // The route-level `PerAccountThrottlerGuard` + `@Throttle(THROTTLE.DEFAULT)`
    // (5/min) run before the handler at all, so a nonexistent course is
    // enough to prove the rate is what refuses the 6th rapid request — the
    // 24h/10-enrollment cap itself (a separate, DB-derived check inside
    // `FreeEnrollmentService`) is unit-tested directly in
    // `free-enrollment.service.spec.ts`, since exercising it here would
    // require 11 requests inside one minute and collide with this same
    // per-minute limit first.
    const { learner } = await actors();
    for (let i = 0; i < 5; i++) {
      await learner.agent.post(`${API_PREFIX}/marketplace/checkout/enroll-free`).send({ courseId: '00000000-0000-4000-8000-000000000000' });
    }
    const refused = await learner.agent
      .post(`${API_PREFIX}/marketplace/checkout/enroll-free`)
      .send({ courseId: '00000000-0000-4000-8000-000000000000' })
      .expect(422);
    expect(refused.body).toMatchObject({ code: 'FREE_ENROLLMENT_RATE_LIMITED', details: ['per_minute'] });
  });
});
