import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { LessonPackage } from '../../src/packages/entities/lesson-package.entity';
import { CourseStatus } from '../../src/packages/entities/course-status.enum';
import { MarketplaceCategory } from '../../src/marketplace/catalog/entities';
import { MarketplaceInstructor } from '../../src/marketplace/instructors/entities/marketplace-instructor.entity';
import { buildInstructorFixture } from './factories/marketplace.factory';
import { API_PREFIX, createAuthenticatedUser, createE2EApp, resetDatabase } from './fixtures';
import { TEST_IMAGE_KEY } from './helpers/images';

/**
 * T206 (US11, release gate). Neither domain's id-lookup routes special-case
 * "this UUID belongs to the other domain" — the guard is structural: a
 * marketplace course id simply does not exist in `lesson_packages`, and an
 * academic package id does not exist in `marketplace_courses`, so a normal
 * not-found path fires either way. This suite makes that structural
 * guarantee an explicit, durable assertion (FR-006) rather than an
 * incidental side effect nobody is watching for regressions.
 */
describe('cross-domain identifier rejection (Phase 13, T206)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    ({ app, dataSource } = await createE2EApp());
  });

  beforeEach(async () => resetDatabase(dataSource));
  afterAll(async () => app.close());

  async function seedAcademicPackage(title: string) {
    const teacher = await createAuthenticatedUser(app, dataSource, { role: 'teacher' });
    return dataSource.getRepository(LessonPackage).save(
      dataSource.getRepository(LessonPackage).create({
        title,
        title_ar: title,
        teacher_id: teacher.userId,
        price: 100,
        is_active: true,
        status: CourseStatus.PUBLISHED,
      } as Partial<LessonPackage>),
    );
  }

  it('an academic package id at a marketplace course-detail route never partially resolves', async () => {
    const academicPackage = await seedAcademicPackage('Academic Package');

    // The marketplace admin course-content route takes a raw UUID (not a
    // slug) — the sharpest place a cross-domain id could theoretically
    // slip through if any lookup query were ever accidentally unscoped.
    const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
    await admin.agent
      .get(`${API_PREFIX}/marketplace/admin/courses/${academicPackage.id}/content`)
      .expect(404);
  });

  it('a marketplace course id at the academic public package-detail route never partially resolves', async () => {
    const instructorUser = await createAuthenticatedUser(app, dataSource);
    await dataSource.getRepository(MarketplaceInstructor).save(buildInstructorFixture({ user_id: instructorUser.userId }));
    const category = await dataSource.getRepository(MarketplaceCategory).save({
      name_en: 'Programming',
      name_ar: 'البرمجة',
      slug: `programming-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      display_order: 1,
    });
    const created = await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses`)
      .send({
        title: `Cross-Domain Course ${Date.now()}`,
        summary: 'Cross-domain id rejection test',
        description: 'A full description of the course content.',
        category_id: category.id,
        level: 'beginner',
        language: 'en',
        price_minor: 5000,
        currency: 'EGP',
        cover_image_key: TEST_IMAGE_KEY,
        learning_outcomes: ['n/a'],
      })
      .expect(201);
    const marketplaceCourseId = created.body.id as string;

    await instructorUser.agent
      .get(`${API_PREFIX}/packages/${marketplaceCourseId}`)
      .expect(404);
  });

  it('a marketplace order can never be created for an academic package id passed as courseId', async () => {
    const academicPackage = await seedAcademicPackage('Academic Package 2');
    const learner = await createAuthenticatedUser(app, dataSource);

    const res = await learner.agent
      .post(`${API_PREFIX}/marketplace/checkout/orders`)
      .set('Idempotency-Key', `order-${Date.now()}`)
      .send({ courseId: academicPackage.id });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    // Never a 2xx, and no order created for it.
    const orders = await dataSource.query<Array<{ count: string }>>(
      `SELECT COUNT(*)::int AS count FROM marketplace_orders WHERE course_id = $1`,
      [academicPackage.id],
    );
    expect(Number(orders[0]!.count)).toBe(0);
  });
});
