import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import {
  MarketplaceCategory,
  MarketplaceCourse,
  MarketplaceCourseRemoval,
} from '../../src/marketplace/catalog/entities';
import { LessonContentType } from '../../src/marketplace/common/enums';
import { MarketplaceInstructor } from '../../src/marketplace/instructors/entities/marketplace-instructor.entity';
import { FINANCE_PERMISSIONS } from '../../src/payments/finance-permissions';
import { User } from '../../src/users/entities';
import { buildInstructorFixture } from './factories/marketplace.factory';
import { API_PREFIX, createAuthenticatedUser, createE2EApp, resetDatabase } from './fixtures';

/**
 * T142's synchronous half: unpublish, stamp removal, create the summary
 * row, and (for a course with no active enrollments) mark it complete
 * immediately. The per-learner queued fan-out itself cannot be exercised
 * here — `E2E_DISABLE_BACKGROUND_WORKERS=true` in `.env.test` makes every
 * BullMQ queue a `NoopQueue` in this environment (see `register-queues.util.ts`),
 * so an enqueued job is never actually delivered to a worker. That per-order
 * logic (zero-value direct revoke vs. removal-driven refund, retry safety,
 * counter correctness) is proven exhaustively at the unit level instead
 * (`course-removal.service.spec.ts`), the same split already established for
 * video readiness (AWS MediaConvert) and the live EasyKash gateway elsewhere in this
 * suite.
 */
describe('marketplace course removal — synchronous half (T142, FR-054a)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    ({ app, dataSource } = await createE2EApp());
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
  }) {
    const created = await opts.instructorAgent
      .post(`${API_PREFIX}/marketplace/instructor/courses`)
      .send({
        title: `Removal Flow Course ${Date.now()}-${Math.random().toString(36).slice(2)}`,
        summary: 'A course that will be removed',
        description: 'A full description of the course content.',
        category_id: opts.categoryId,
        level: 'beginner',
        language: 'en',
        price_minor: 5000,
        currency: 'EGP',
        cover_image_key: 'covers/removal-101.jpg',
        learning_outcomes: ['Understand removal'],
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
    return dataSource.getRepository(MarketplaceCourse).findOneOrFail({ where: { id: courseId } });
  }

  async function actors() {
    const instructorUser = await createAuthenticatedUser(app, dataSource);
    await seedInstructor(instructorUser.userId);
    const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
    const category = await seedCategory();
    const course = await publishCourse({
      instructorAgent: instructorUser.agent,
      adminAgent: admin.agent,
      categoryId: category.id,
    });
    return { instructorUser, admin, course };
  }

  it('denies removal without marketplace.refunds.process', async () => {
    const { admin, course } = await actors();
    await dataSource.getRepository(User).update({ id: admin.userId }, { finance_permissions: [] });

    await admin.agent
      .post(`${API_PREFIX}/marketplace/admin/courses/${course.id}/remove`)
      .send({ cause: 'policy_violation', reason: 'Terms of service violation' })
      .expect(403);
  });

  it('unpublishes, stamps the removal, and — with no active enrollments — completes immediately', async () => {
    const { admin, course } = await actors();
    await dataSource
      .getRepository(User)
      .update({ id: admin.userId }, { finance_permissions: [...FINANCE_PERMISSIONS] });

    const res = await admin.agent
      .post(`${API_PREFIX}/marketplace/admin/courses/${course.id}/remove`)
      .send({ cause: 'policy_violation', reason: 'Terms of service violation' })
      .expect(201);

    expect(res.body).toMatchObject({
      cause: 'policy_violation',
      reason: 'Terms of service violation',
    });
    expect(res.body.completed_at).not.toBeNull();

    const updated = await dataSource
      .getRepository(MarketplaceCourse)
      .findOneByOrFail({ id: course.id });
    expect(updated.status).toBe('unpublished');
    expect(updated.removed_at).not.toBeNull();
    expect(updated.removal_reason).toBe('Terms of service violation');
  });

  it('removes the course from the public listing (status filter alone excludes it)', async () => {
    const { admin, course } = await actors();
    await dataSource
      .getRepository(User)
      .update({ id: admin.userId }, { finance_permissions: [...FINANCE_PERMISSIONS] });

    await admin.agent
      .post(`${API_PREFIX}/marketplace/admin/courses/${course.id}/remove`)
      .send({ cause: 'legal_takedown', reason: 'Legal takedown notice' })
      .expect(201);

    const listing = await admin.agent.get(`${API_PREFIX}/marketplace/courses`).expect(200);
    expect((listing.body.items as Array<{ id: string }>).some((c) => c.id === course.id)).toBe(
      false,
    );
  });

  it('is idempotent: removing an already-removed course returns the existing record and changes nothing further', async () => {
    const { admin, course } = await actors();
    await dataSource
      .getRepository(User)
      .update({ id: admin.userId }, { finance_permissions: [...FINANCE_PERMISSIONS] });

    const first = await admin.agent
      .post(`${API_PREFIX}/marketplace/admin/courses/${course.id}/remove`)
      .send({ cause: 'policy_violation', reason: 'First reason' })
      .expect(201);
    const second = await admin.agent
      .post(`${API_PREFIX}/marketplace/admin/courses/${course.id}/remove`)
      .send({ cause: 'legal_takedown', reason: 'Different reason, ignored' })
      .expect(201);

    expect(second.body.id).toBe(first.body.id);
    expect(
      await dataSource.getRepository(MarketplaceCourseRemoval).countBy({ course_id: course.id }),
    ).toBe(1);
    const updated = await dataSource
      .getRepository(MarketplaceCourse)
      .findOneByOrFail({ id: course.id });
    expect(updated.removal_reason).toBe('First reason');
  });

  it('never lets a permanently removed course be republished (FR-054a)', async () => {
    const { instructorUser, admin, course } = await actors();
    await dataSource
      .getRepository(User)
      .update({ id: admin.userId }, { finance_permissions: [...FINANCE_PERMISSIONS] });
    await admin.agent
      .post(`${API_PREFIX}/marketplace/admin/courses/${course.id}/remove`)
      .send({ cause: 'policy_violation', reason: 'Removed' })
      .expect(201);

    await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${course.id}/republish`)
      .send({})
      .expect(409);
  });

  it('refuses to remove a course that has never been published (still draft)', async () => {
    const instructorUser = await createAuthenticatedUser(app, dataSource);
    await seedInstructor(instructorUser.userId);
    const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
    await dataSource
      .getRepository(User)
      .update({ id: admin.userId }, { finance_permissions: [...FINANCE_PERMISSIONS] });
    const category = await seedCategory();
    const created = await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses`)
      .send({
        title: `Draft Course ${Date.now()}`,
        summary: 'Never published',
        description: 'A full description of the course content.',
        category_id: category.id,
        level: 'beginner',
        language: 'en',
        price_minor: 5000,
        currency: 'EGP',
        cover_image_key: 'covers/draft.jpg',
        learning_outcomes: ['x'],
      })
      .expect(201);

    await admin.agent
      .post(`${API_PREFIX}/marketplace/admin/courses/${created.body.id}/remove`)
      .send({ cause: 'policy_violation', reason: 'x' })
      .expect(409);
  });
});
