import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import type { DataSource } from 'typeorm';

import request from 'supertest';

import { Certificate } from '../../src/certificates/entities/certificate.entity';
import { CertificateStatus } from '../../src/certificates/entities/certificate-status.enum';
import { MarketplaceCategory, MarketplaceCourse } from '../../src/marketplace/catalog/entities';
import { MarketplaceCourseStatus } from '../../src/marketplace/common/enums';
import { MarketplaceInstructor } from '../../src/marketplace/instructors/entities/marketplace-instructor.entity';
import { CourseStatus } from '../../src/packages/entities/course-status.enum';
import { LessonPackage } from '../../src/packages/entities/lesson-package.entity';
import { buildInstructorFixture } from './factories/marketplace.factory';
import { API_PREFIX, createAuthenticatedUser, createE2EApp, resetDatabase } from './fixtures';
import { TEST_IMAGE_KEY } from './helpers/images';

/**
 * T205 (US11, release gate). `2100000000000-ExtendCertificatesForMarketplace`
 * only ADDs nullable columns (`marketplace_course_id`, `source`) to the
 * existing `certificates` table — no existing column was altered, dropped
 * or made non-nullable, and `source` defaults to `'academic'`, so every
 * pre-extension row is structurally unchanged. This suite proves the
 * consequence at the API surface: an academic certificate verifies exactly
 * as before, and the same public verification route also resolves a
 * marketplace certificate that carries no academic record (`package_id`)
 * at all — the two share one endpoint by design, not by coincidence.
 */
describe('academic certificate regression under the marketplace extension (Phase 13, T205)', () => {
  let app: INestApplication;
  let server: Server;
  let dataSource: DataSource;

  beforeAll(async () => {
    ({ app, dataSource } = await createE2EApp());
    server = app.getHttpServer() as Server;
  });

  beforeEach(async () => resetDatabase(dataSource));
  afterAll(async () => app.close());

  async function seedAcademicPackage(): Promise<LessonPackage> {
    const teacher = await createAuthenticatedUser(app, dataSource, { role: 'teacher' });
    return dataSource.getRepository(LessonPackage).save(
      dataSource.getRepository(LessonPackage).create({
        title: 'Academic Package',
        title_ar: 'Academic Package',
        teacher_id: teacher.userId,
        price: 100,
        is_active: true,
        status: CourseStatus.PUBLISHED,
      } as Partial<LessonPackage>),
    );
  }

  /** A genuine `marketplace_courses` row — `FK_certificates_marketplace_course` (2100000000000) requires a real referenced row, not an arbitrary UUID. Seeded directly via repositories; the full instructor-application/course-builder HTTP workflow is out of scope for this certificate-regression suite. */
  async function seedMarketplaceCourse(): Promise<MarketplaceCourse> {
    const instructorUser = await createAuthenticatedUser(app, dataSource);
    const instructor = await dataSource.getRepository(MarketplaceInstructor).save(buildInstructorFixture({ user_id: instructorUser.userId }));
    const category = await dataSource.getRepository(MarketplaceCategory).save({
      name_en: 'Programming',
      name_ar: 'البرمجة',
      slug: `programming-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      display_order: 1,
    });
    return dataSource.getRepository(MarketplaceCourse).save(
      dataSource.getRepository(MarketplaceCourse).create({
        instructor_id: instructor.id,
        category_id: category.id,
        slug: `cert-regression-course-${Date.now()}`,
        title: 'Marketplace Course',
        summary: 'Certificate regression coverage',
        description: 'A full description of the course content.',
        level: 'beginner',
        language: 'en',
        price_minor: 100000,
        currency: 'EGP',
        cover_image_key: TEST_IMAGE_KEY,
        status: MarketplaceCourseStatus.PUBLISHED,
      } as Partial<MarketplaceCourse>),
    );
  }

  function buildAcademicCertificate(
    studentId: string,
    packageId: string,
    overrides: Partial<Certificate> = {},
  ): Partial<Certificate> {
    return {
      certificate_number: `CERT-ACAD-${Date.now()}`,
      verification_code: `ACAD${Date.now().toString(36).toUpperCase()}`,
      student_id: studentId,
      package_id: packageId,
      marketplace_course_id: null,
      source: 'academic',
      student_name: 'Academic Student',
      course_title: 'Academic Course',
      teacher_name: 'Academic Teacher',
      completion_percentage: 100,
      is_public: false,
      status: CertificateStatus.ISSUED,
      issued_at: new Date(),
      ...overrides,
    } as Partial<Certificate>;
  }

  it('an academic certificate verifies exactly as before — no marketplace field required, no academic field disturbed', async () => {
    const student = await createAuthenticatedUser(app, dataSource);
    const academicPackage = await seedAcademicPackage();
    const certs = dataSource.getRepository(Certificate);
    const cert = await certs.save(certs.create(buildAcademicCertificate(student.userId, academicPackage.id)));

    const res = await request(server).get(`${API_PREFIX}/certificates/verify/${cert.verification_code}`).expect(200);

    expect(res.body.valid).toBe(true);
    expect(res.body.certificate.certificate_number).toBe(cert.certificate_number);
    expect(res.body.certificate.status).toBe(CertificateStatus.ISSUED);

    const unchanged = await certs.findOneByOrFail({ id: cert.id });
    expect(unchanged.package_id).toBe(academicPackage.id);
    expect(unchanged.marketplace_course_id).toBeNull();
    expect(unchanged.source).toBe('academic');
  });

  it('a revoked academic certificate still reports revoked with no status regression', async () => {
    const student = await createAuthenticatedUser(app, dataSource);
    const academicPackage = await seedAcademicPackage();
    const certs = dataSource.getRepository(Certificate);
    const cert = await certs.save(
      certs.create(
        buildAcademicCertificate(student.userId, academicPackage.id, {
          status: CertificateStatus.REVOKED,
          revoked_at: new Date(),
          revoke_reason: 'Test revocation',
        }),
      ),
    );

    const res = await request(server).get(`${API_PREFIX}/certificates/verify/${cert.verification_code}`).expect(200);

    expect(res.body.valid).toBe(false);
    expect(res.body.certificate.status).toBe(CertificateStatus.REVOKED);
    expect(res.body.certificate.revoked_at).not.toBeNull();
  });

  it('the public verification surface resolves a marketplace certificate with no academic record present at all', async () => {
    const student = await createAuthenticatedUser(app, dataSource);
    const marketplaceCourse = await seedMarketplaceCourse();
    const certs = dataSource.getRepository(Certificate);
    const cert = await certs.save(
      certs.create({
        certificate_number: `CERT-MKT-${Date.now()}`,
        verification_code: `MKT${Date.now().toString(36).toUpperCase()}`,
        student_id: student.userId,
        package_id: null, // no academic LessonPackage anywhere for this row
        marketplace_course_id: marketplaceCourse.id,
        source: 'marketplace',
        student_name: 'Marketplace Student',
        course_title: 'Marketplace Course',
        teacher_name: null,
        completion_percentage: 100,
        is_public: false,
        status: CertificateStatus.ISSUED,
        issued_at: new Date(),
      } as Partial<Certificate>),
    );

    const res = await request(server).get(`${API_PREFIX}/certificates/verify/${cert.verification_code}`).expect(200);

    expect(res.body.valid).toBe(true);
    expect(res.body.certificate.certificate_number).toBe(cert.certificate_number);
  });

  it('an unknown verification code 404s regardless of source', async () => {
    await request(server).get(`${API_PREFIX}/certificates/verify/DOES-NOT-EXIST`).expect(404);
  });
});
