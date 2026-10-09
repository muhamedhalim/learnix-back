import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getRepositoryToken } from '@nestjs/typeorm';

import { DataSource } from 'typeorm';

import { CourseVersionItem } from '../packages/entities/course-version-item.entity';
import { LessonPackage } from '../packages/entities/lesson-package.entity';
import { LessonPackageItem } from '../packages/entities/lesson-package-item.entity';
import { LessonProgress } from '../lessons/entities/lesson-progress.entity';
import { PackagePurchase } from '../payments/entities/package-purchase.entity';
import { User } from '../users/entities/user.entity';
import { ApplicationCacheService } from '../common/cache/application-cache.service';
import { CertificateEligibilityService } from './certificate-eligibility.service';
import { CertificatePdfService } from './certificate-pdf.service';
import { CertificatesService } from './certificates.service';
import { Certificate } from './entities/certificate.entity';
import { CertificateAutoIssuanceFailure } from './entities/certificate-auto-issuance-failure.entity';
import { CertificateHistory } from './entities/certificate-history.entity';
import { CertificateStatus } from './entities/certificate-status.enum';
import { CertificateTemplate } from './entities/certificate-template.entity';
import { CertificateTemplateStatus } from './entities/certificate-template-status.enum';

function qb(result: number | unknown[]) {
  const b: Record<string, jest.Mock> = {};
  for (const m of [
    'innerJoin',
    'where',
    'andWhere',
    'select',
    'addSelect',
    'groupBy',
    'orderBy',
    'addOrderBy',
    'limit',
    'update',
    'set',
  ]) {
    b[m] = jest.fn(() => b);
  }
  b.getCount = jest.fn().mockResolvedValue(typeof result === 'number' ? result : 0);
  b.getRawMany = jest.fn().mockResolvedValue(Array.isArray(result) ? result : []);
  b.execute = jest.fn().mockResolvedValue({});
  return b;
}

describe('CertificatesService', () => {
  let service: CertificatesService;

  const certificates = {
    findOne: jest.fn(),
    find: jest.fn(),
    findAndCount: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
  const certificateHistory = { create: jest.fn(), save: jest.fn() };
  const autoIssuanceFailures = { find: jest.fn(), findOne: jest.fn(), create: jest.fn(), save: jest.fn() };
  const templates = {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
  const packages = { findOne: jest.fn() };
  const packageItems = { count: jest.fn() };
  const courseVersionItems = { count: jest.fn() };
  const progress = { createQueryBuilder: jest.fn() };
  const purchases = { createQueryBuilder: jest.fn(), findOne: jest.fn(), count: jest.fn() };
  const users = { findOne: jest.fn() };
  const pdf = { render: jest.fn() };
  const emitter = { emit: jest.fn() };
  const eligibility = {
    findActivePurchase: jest.fn(),
    lockActivePurchase: jest.fn(),
    assertEligible: jest.fn(),
    applyActivePurchase: jest.fn(<T>(query: T) => query),
    ineligible: jest.fn(() => new UnprocessableEntityException('no valid purchase')),
    revokeForWithdrawnAccess: jest.fn(),
  };

  /** Route `EntityManager` calls made inside a transaction to the same mocks. */
  const repositoryFor = (entity: unknown): Record<string, jest.Mock> => {
    const byEntity = new Map<unknown, Record<string, jest.Mock>>([
      [Certificate, certificates],
      [CertificateHistory, certificateHistory],
      [CertificateTemplate, templates],
      [LessonPackage, packages],
      [LessonPackageItem, packageItems],
      [CourseVersionItem, courseVersionItems],
      [LessonProgress, progress],
      [PackagePurchase, purchases],
      [User, users],
    ]);
    const repository = byEntity.get(entity);
    if (!repository) throw new Error('Unexpected entity in transaction');
    return repository;
  };
  const manager = {
    getRepository: jest.fn((entity: unknown) => repositoryFor(entity)),
    findOne: jest.fn((entity: unknown, options: unknown) => repositoryFor(entity).findOne?.(options)),
    save: jest.fn((entity: unknown, value: unknown) => repositoryFor(entity).save?.(value)),
    create: jest.fn((entity: unknown, value: unknown) => repositoryFor(entity).create?.(value)),
  };
  const dataSource = {
    transaction: jest.fn(async (run: (m: typeof manager) => Promise<unknown>) => run(manager)),
  };
  const applicationCache = {
    getOrCompute: jest.fn((_descriptor: unknown, compute: () => unknown) => compute()),
    invalidate: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    applicationCache.getOrCompute.mockImplementation(
      (_descriptor: unknown, compute: () => unknown) => compute(),
    );
    applicationCache.invalidate.mockResolvedValue(undefined);
    templates.createQueryBuilder.mockReturnValue(qb(0));
    // Baseline: no active purchase, no locked-version snapshot yet — tests
    // opt into the "purchased/locked" path explicitly. `clearAllMocks` only
    // resets call history, not `mockResolvedValue` results, so without this
    // a value configured by an earlier test would otherwise leak forward.
    purchases.findOne.mockResolvedValue(null);
    purchases.count.mockResolvedValue(0);
    eligibility.findActivePurchase.mockResolvedValue(null);
    eligibility.lockActivePurchase.mockResolvedValue(null);
    eligibility.applyActivePurchase.mockImplementation((query: unknown) => query);
    eligibility.ineligible.mockImplementation(
      () => new UnprocessableEntityException('no valid purchase'),
    );
    courseVersionItems.count.mockResolvedValue(0);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CertificatesService,
        { provide: getRepositoryToken(Certificate), useValue: certificates },
        { provide: getRepositoryToken(CertificateHistory), useValue: certificateHistory },
        { provide: getRepositoryToken(CertificateAutoIssuanceFailure), useValue: autoIssuanceFailures },
        { provide: getRepositoryToken(CertificateTemplate), useValue: templates },
        { provide: getRepositoryToken(LessonPackage), useValue: packages },
        { provide: getRepositoryToken(LessonPackageItem), useValue: packageItems },
        { provide: getRepositoryToken(CourseVersionItem), useValue: courseVersionItems },
        { provide: getRepositoryToken(LessonProgress), useValue: progress },
        { provide: getRepositoryToken(PackagePurchase), useValue: purchases },
        { provide: getRepositoryToken(User), useValue: users },
        { provide: CertificatePdfService, useValue: pdf },
        { provide: EventEmitter2, useValue: emitter },
        { provide: CertificateEligibilityService, useValue: eligibility },
        { provide: DataSource, useValue: dataSource },
        { provide: ApplicationCacheService, useValue: applicationCache },
      ],
    }).compile();
    service = module.get(CertificatesService);
  });

  describe('getCourseProgress', () => {
    it('returns 0% for a course whose current (unlocked) version has no lessons', async () => {
      packages.findOne.mockResolvedValue({ id: 'P1', current_version_id: 'v1' });
      courseVersionItems.count.mockResolvedValue(0);
      packageItems.count.mockResolvedValue(0);
      const result = await service.getCourseProgress('S1', 'P1');
      expect(result).toEqual({ total: 0, completed: 0, percentage: 0 });
    });

    it('falls back to the live curriculum when no purchase exists (unlocked current version)', async () => {
      packages.findOne.mockResolvedValue({ id: 'P1', current_version_id: 'v1' });
      courseVersionItems.count.mockResolvedValue(0);
      packageItems.count.mockResolvedValue(4);
      progress.createQueryBuilder.mockReturnValue(qb(3));
      const result = await service.getCourseProgress('S1', 'P1');
      expect(result).toEqual({ total: 4, completed: 3, percentage: 75 });
      expect(courseVersionItems.count).toHaveBeenCalledWith({ where: { version_id: 'v1' } });
    });

    it("judges completion against the purchaser's own locked version, not live curriculum", async () => {
      eligibility.findActivePurchase.mockResolvedValue({ id: 'pp1', course_version_id: 'v1' });
      courseVersionItems.count.mockResolvedValue(3);
      progress.createQueryBuilder.mockReturnValue(qb(3));

      const result = await service.getCourseProgress('S1', 'P1');

      expect(result).toEqual({ total: 3, completed: 3, percentage: 100 });
      // A locked version's own snapshot is authoritative — live curriculum
      // (packageItems) is never consulted once a real purchase is found.
      expect(packageItems.count).not.toHaveBeenCalled();
    });
  });

  describe('eligibility is read once (T057 / E-003)', () => {
    it('getMyCourseProgress issues exactly one eligibility read', async () => {
      eligibility.findActivePurchase.mockResolvedValue({ id: 'pp1', course_version_id: 'v1' });
      courseVersionItems.count.mockResolvedValue(2);
      progress.createQueryBuilder.mockReturnValue(qb(1));

      const result = await service.getMyCourseProgress('S1', 'P1');

      expect(result).toEqual({ total: 2, completed: 1, percentage: 50 });
      expect(eligibility.findActivePurchase).toHaveBeenCalledTimes(1);
    });

    it('issuance-style callers (no resolved purchase) still resolve it under their manager', async () => {
      eligibility.findActivePurchase.mockResolvedValue({ id: 'pp1', course_version_id: 'v1' });
      courseVersionItems.count.mockResolvedValue(1);
      progress.createQueryBuilder.mockReturnValue(qb(1));
      const manager = {
        getRepository: jest.fn((entity: unknown) =>
          entity === CourseVersionItem ? courseVersionItems : progress,
        ),
      };

      await service.getCourseProgress('S1', 'P1', manager as never);

      expect(eligibility.findActivePurchase).toHaveBeenCalledWith('S1', 'P1', manager);
    });
  });

  describe('getMyCourseProgress', () => {
    it('never reveals real numbers for a course the student has not validly purchased', async () => {
      eligibility.findActivePurchase.mockResolvedValue(null);
      const result = await service.getMyCourseProgress('S1', 'P1');
      expect(result).toEqual({ total: 0, completed: 0, percentage: 0 });
      expect(packages.findOne).not.toHaveBeenCalled();
    });

    it('delegates to getCourseProgress for an owning student', async () => {
      eligibility.findActivePurchase.mockResolvedValue({ id: 'pp1' });
      const spy = jest
        .spyOn(service, 'getCourseProgress')
        .mockResolvedValue({ total: 3, completed: 3, percentage: 100 });
      const result = await service.getMyCourseProgress('S1', 'P1');
      // The already-resolved purchase is handed down so eligibility is read once (E-003).
      expect(spy).toHaveBeenCalledWith('S1', 'P1', undefined, { id: 'pp1' });
      expect(result).toEqual({ total: 3, completed: 3, percentage: 100 });
    });
  });

  describe('issueForCourse', () => {
    it('returns the existing certificate (idempotent)', async () => {
      const existing = { id: 'c1' } as Certificate;
      certificates.findOne.mockResolvedValue(existing);
      const result = await service.issueForCourse('S1', 'P1');
      expect(result).toBe(existing);
      expect(certificates.save).not.toHaveBeenCalled();
    });

    it('refuses to issue when the course is incomplete', async () => {
      certificates.findOne.mockResolvedValue(null);
      eligibility.lockActivePurchase.mockResolvedValue({ id: 'pp1', course_version_id: null });
      packages.findOne.mockResolvedValue({ id: 'P1', current_version_id: 'v1' });
      packageItems.count.mockResolvedValue(4);
      progress.createQueryBuilder.mockReturnValue(qb(2)); // 50%
      await expect(service.issueForCourse('S1', 'P1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a 100%-complete student with no valid purchase (DEF-019)', async () => {
      certificates.findOne.mockResolvedValue(null);
      eligibility.lockActivePurchase.mockResolvedValue(null);
      packageItems.count.mockResolvedValue(2);
      progress.createQueryBuilder.mockReturnValue(qb(2)); // 100%

      await expect(service.issueForCourse('S1', 'P1')).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      expect(certificates.save).not.toHaveBeenCalled();
    });

    it('refuses a refunded (revoked-purchase) student even under an admin force override', async () => {
      certificates.findOne.mockResolvedValue(null);
      eligibility.lockActivePurchase.mockResolvedValue(null);

      await expect(
        service.issueForCourse('S1', 'P1', { force: true }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(certificates.save).not.toHaveBeenCalled();
    });

    it('uses the course-assigned template before owner defaults, snapshots names, and emits when complete', async () => {
      certificates.findOne
        .mockResolvedValueOnce(null) // no existing cert
        .mockResolvedValue(null); // in-transaction re-check + unique number/code
      eligibility.lockActivePurchase.mockResolvedValue({ id: 'pp1', course_version_id: null });
      packageItems.count.mockResolvedValue(2);
      progress.createQueryBuilder.mockReturnValue(qb(2)); // 100%
      users.findOne.mockResolvedValue({ id: 'S1', name: 'Ada Lovelace' });
      packages.findOne.mockResolvedValue({
        id: 'P1',
        title: 'Algorithms',
        teacher_id: 'teacher-1',
        certificate_template_id: 'course-template',
        teacher: { name: 'Prof X' },
        current_version_id: 'v1',
      });
      templates.findOne.mockResolvedValue({
        id: 't1',
        status: CertificateTemplateStatus.PUBLISHED,
        name: 'Default certificate',
        title: 'Certificate of Completion',
        body: 'Presented to {{student}} for {{course}}.',
      });
      certificates.create.mockImplementation((v: unknown) => v);
      certificates.save.mockImplementation((v: Certificate) =>
        Promise.resolve({ ...v, id: 'new' }),
      );

      const result = await service.issueForCourse('S1', 'P1');

      expect(result.student_name).toBe('Ada Lovelace');
      expect(result.course_title).toBe('Algorithms');
      expect(result.teacher_name).toBe('Prof X');
      expect(result.status).toBe(CertificateStatus.ISSUED);
      expect(result.template_id).toBe('t1');
      expect(templates.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: 'course-template' }) }),
      );
      expect(result.certificate_number).toMatch(/^CERT-\d{4}-/);
      expect(emitter.emit).toHaveBeenCalled();
    });
  });

  describe('issueMarketplaceCertificate (T126)', () => {
    const input = {
      studentId: 'S1',
      studentName: 'Ada Lovelace',
      courseTitle: 'React Basics',
      instructorName: 'Nour Ahmed',
      marketplaceCourseId: 'MC1',
    };

    it('returns the existing certificate (idempotent — exactly one per completed enrollment, FR-248)', async () => {
      const existing = { id: 'c1', source: 'marketplace' } as Certificate;
      certificates.findOne.mockResolvedValue(existing);

      const result = await service.issueMarketplaceCertificate(input);

      expect(result).toBe(existing);
      expect(certificates.save).not.toHaveBeenCalled();
    });

    it('issues with source=marketplace, package_id=null, and the platform default template, emitting CERTIFICATE_ISSUED_EVENT', async () => {
      certificates.findOne.mockResolvedValue(null);
      templates.findOne.mockResolvedValue({
        id: 't1',
        status: CertificateTemplateStatus.PUBLISHED,
        name: 'Default certificate',
        title: 'Certificate of Completion',
        body: 'Presented to {{student}} for {{course}}.',
      });
      certificates.create.mockImplementation((v: unknown) => v);
      certificates.save.mockImplementation((v: Certificate) => Promise.resolve({ ...v, id: 'new' }));

      const result = await service.issueMarketplaceCertificate(input);

      expect(result).toMatchObject({
        source: 'marketplace',
        package_id: null,
        marketplace_course_id: 'MC1',
        student_name: 'Ada Lovelace',
        course_title: 'React Basics',
        teacher_name: 'Nour Ahmed',
        completion_percentage: 100,
        status: CertificateStatus.ISSUED,
        template_id: 't1',
      });
      expect(templates.findOne).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ is_default: true }) }));
      expect(emitter.emit).toHaveBeenCalledWith(
        'certificate.issued',
        expect.objectContaining({ studentId: 'S1', packageId: null }),
      );
    });

    it('issues even with no platform default template configured, rather than refusing', async () => {
      certificates.findOne.mockResolvedValue(null);
      templates.findOne.mockResolvedValue(null);
      certificates.create.mockImplementation((v: unknown) => v);
      certificates.save.mockImplementation((v: Certificate) => Promise.resolve({ ...v, id: 'new' }));

      const result = await service.issueMarketplaceCertificate(input);

      expect(result.template_id).toBeNull();
      expect(result.status).toBe(CertificateStatus.ISSUED);
    });

    it('never reads any academic table (packages, package purchases, lesson progress) while issuing (FR-324)', async () => {
      certificates.findOne.mockResolvedValue(null);
      templates.findOne.mockResolvedValue(null);
      certificates.create.mockImplementation((v: unknown) => v);
      certificates.save.mockImplementation((v: Certificate) => Promise.resolve({ ...v, id: 'new' }));

      await service.issueMarketplaceCertificate(input);

      expect(packages.findOne).not.toHaveBeenCalled();
      expect(purchases.findOne).not.toHaveBeenCalled();
      expect(purchases.createQueryBuilder).not.toHaveBeenCalled();
      expect(progress.createQueryBuilder).not.toHaveBeenCalled();
      expect(eligibility.assertEligible).not.toHaveBeenCalled();
      expect(eligibility.lockActivePurchase).not.toHaveBeenCalled();
    });
  });

  describe('getMarketplaceCertificateForCourse (T127)', () => {
    it('returns the certificate for the (student, marketplace course) pair, or null', async () => {
      const found = { id: 'c1' } as Certificate;
      certificates.findOne.mockResolvedValue(found);

      await expect(service.getMarketplaceCertificateForCourse('S1', 'MC1')).resolves.toBe(found);
      expect(certificates.findOne).toHaveBeenCalledWith({ where: { student_id: 'S1', marketplace_course_id: 'MC1' } });
    });
  });

  describe('getMyCertificates (T129/T131 — the marketplace listing endpoint)', () => {
    it('filters by source when given one, never mixing academic and marketplace rows for one caller', async () => {
      certificates.findAndCount.mockResolvedValue([[{ id: 'c1', source: 'marketplace' }], 1]);

      await service.getMyCertificates('S1', 1, 20, 'marketplace');

      expect(certificates.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ where: { student_id: 'S1', source: 'marketplace' } }),
      );
    });

    it('omits the source filter entirely when none is given (the academic /student/certificates route\'s existing behaviour, unchanged)', async () => {
      certificates.findAndCount.mockResolvedValue([[], 0]);

      await service.getMyCertificates('S1', 1, 20);

      expect(certificates.findAndCount).toHaveBeenCalledWith(expect.objectContaining({ where: { student_id: 'S1' } }));
    });
  });

  describe('getAnalytics (T128)', () => {
    it("filters the admin-wide total/thisMonth figures to source='academic' — a marketplace certificate never inflates them (FR-252)", async () => {
      const totalQb = qb(3);
      const monthQb = qb(1);
      const topQb = qb([]);
      certificates.createQueryBuilder
        .mockReturnValueOnce(totalQb)
        .mockReturnValueOnce(monthQb)
        .mockReturnValueOnce(topQb);

      const result = await service.getAnalytics();

      expect(totalQb.where).toHaveBeenCalledWith("c.source = 'academic'");
      expect(monthQb.where).toHaveBeenCalledWith("c.source = 'academic'");
      expect(result.total).toBe(3);
      expect(result.thisMonth).toBe(1);
    });
  });

  describe('autoIssueForCompletedLesson', () => {
    it('issues only for fully-completed purchased courses', async () => {
      purchases.createQueryBuilder.mockReturnValue(qb([{ package_id: 'P1' }]));
      const spy = jest
        .spyOn(service, 'getCourseProgress')
        .mockResolvedValue({ total: 2, completed: 2, percentage: 100 });
      const issueSpy = jest
        .spyOn(service, 'issueForCourse')
        .mockResolvedValue({ id: 'c' } as Certificate);

      await service.autoIssueForCompletedLesson('S1', 'L1');

      expect(spy).toHaveBeenCalledWith('S1', 'P1');
      expect(issueSpy).toHaveBeenCalledWith('S1', 'P1');
    });

    it('skips courses that are not yet complete', async () => {
      purchases.createQueryBuilder.mockReturnValue(qb([{ package_id: 'P1' }]));
      jest
        .spyOn(service, 'getCourseProgress')
        .mockResolvedValue({ total: 2, completed: 1, percentage: 50 });
      const issueSpy = jest.spyOn(service, 'issueForCourse');

      await service.autoIssueForCompletedLesson('S1', 'L1');

      expect(issueSpy).not.toHaveBeenCalled();
    });

    it('records a failed automatic issuance for bounded retry', async () => {
      purchases.createQueryBuilder.mockReturnValue(qb([{ package_id: 'P1' }]));
      jest.spyOn(service, 'getCourseProgress').mockResolvedValue({ total: 2, completed: 2, percentage: 100 });
      jest.spyOn(service, 'issueForCourse').mockRejectedValue(new Error('database unavailable'));
      autoIssuanceFailures.findOne.mockResolvedValue(null);
      autoIssuanceFailures.create.mockImplementation((value: unknown) => value);
      autoIssuanceFailures.save.mockResolvedValue({ id: 'failure-1' });

      await service.autoIssueForCompletedLesson('S1', 'L1');

      expect(autoIssuanceFailures.save).toHaveBeenCalledWith(
        expect.objectContaining({
          student_id: 'S1',
          lesson_id: 'L1',
          package_id: 'P1',
          attempts: 1,
          last_error: 'database unavailable',
        }),
      );
    });
  });

  describe('bulkIssue', () => {
    it('limits certificate issuance work to bounded batches', async () => {
      packages.findOne.mockResolvedValue({ id: 'P1', teacher_id: 'T1' });
      certificates.findOne.mockResolvedValue(null);

      let inFlight = 0;
      let maxInFlight = 0;
      jest.spyOn(service, 'issueForCourse').mockImplementation(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return { id: 'certificate' } as Certificate;
      });

      const studentIds = Array.from({ length: 51 }, (_, index) => `student-${String(index)}`);
      const result = await service.bulkIssue({ packageId: 'P1', studentIds }, 'T1');

      expect(result).toMatchObject({ requested: 51, issued: 51, skipped: 0, failed: [] });
      expect(maxInFlight).toBeLessThanOrEqual(50);
    });
  });

  describe('template ownership', () => {
    it('does not expose another teacher’s template', async () => {
      templates.findOne.mockResolvedValue(null);

      await expect(service.getTemplate('template-1', 'teacher-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(templates.findOne).toHaveBeenCalledWith({
        where: { id: 'template-1', owner_id: 'teacher-1' },
      });
    });

    it('assigns teacher ownership and removes markup from template text', async () => {
      const input = { name: '<b>Completion</b>', title: '<script>Certificate</script>' };
      templates.create.mockImplementation((value: unknown) => value);
      templates.save.mockImplementation((value: unknown) => Promise.resolve(value));

      const result = await service.createTemplate(input, 'teacher-1');

      expect(result).toMatchObject({
        name: 'bCompletion/b',
        title: 'scriptCertificate/script',
        owner_id: 'teacher-1',
      });
    });
  });

  describe('template lifecycle — save is a draft, publish is a gate', () => {
    beforeEach(() => {
      templates.create.mockImplementation((value: unknown) => value);
      templates.save.mockImplementation((value: unknown) => Promise.resolve(value));
    });

    it('new templates always start as DRAFTS, never defaults', async () => {
      const result = await service.createTemplate({ name: 'My design' }, 'teacher-1');
      expect(result.status).toBe(CertificateTemplateStatus.DRAFT);
      expect(result.is_default).toBe(false);
    });

    it('publish validates required design fields', async () => {
      templates.findOne.mockResolvedValue({
        id: 't1',
        name: 'Named',
        title: '',
        body: 'Body',
        status: CertificateTemplateStatus.DRAFT,
      });
      await expect(service.publishTemplate('t1')).rejects.toBeInstanceOf(BadRequestException);
      expect(templates.save).not.toHaveBeenCalled();
    });

    it('does not let a published template be edited into unresolved certificate text', async () => {
      templates.findOne.mockResolvedValue({
        id: 't1',
        name: 'Named',
        title: 'Title',
        body: 'Presented to {{student}}',
        body_ar: null,
        status: CertificateTemplateStatus.PUBLISHED,
      });

      await expect(
        service.updateTemplate('t1', { body: 'Presented to {{teacher}}' }),
      ).rejects.toThrow('Unsupported certificate placeholders');
      expect(templates.save).not.toHaveBeenCalled();
    });

    it('keeps required published fields when a PATCH DTO carries optional undefined keys', async () => {
      const template = {
        id: 't1',
        name: 'Named',
        title: 'Title',
        body: 'Presented to {{student}}',
        body_ar: null,
        status: CertificateTemplateStatus.PUBLISHED,
      };
      templates.findOne.mockResolvedValue(template);

      await service.updateTemplate('t1', {
        title: 'Updated title',
        name: undefined,
        body: undefined,
      });

      expect(templates.save).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Named',
          body: 'Presented to {{student}}',
          title: 'Updated title',
        }),
      );
    });

    it('publish flips the status and makes a teacher template the default', async () => {
      templates.findOne.mockResolvedValue({
        id: 't1',
        owner_id: 'teacher-1',
        name: 'Named',
        title: 'Title',
        body: 'Body',
        status: CertificateTemplateStatus.DRAFT,
        is_default: false,
      });
      const result = await service.publishTemplate('t1', 'teacher-1');
      expect(result.status).toBe(CertificateTemplateStatus.PUBLISHED);
      expect(result.is_default).toBe(true);
    });

    it('unpublish returns to draft and clears the default flag', async () => {
      templates.findOne.mockResolvedValue({
        id: 't1',
        status: CertificateTemplateStatus.PUBLISHED,
        is_default: true,
      });
      const result = await service.unpublishTemplate('t1');
      expect(result.status).toBe(CertificateTemplateStatus.DRAFT);
      expect(result.is_default).toBe(false);
    });

    it('duplicate copies the design as a fresh draft owned by the caller', async () => {
      templates.findOne.mockResolvedValue({
        id: 't1',
        name: 'Original',
        title: 'T',
        body: 'B',
        accent_color: '#123456',
        layout: 'modern',
        font: 'serif',
        title_font_size: 40,
        body_font_size: 18,
        text_alignment: 'left',
        status: CertificateTemplateStatus.PUBLISHED,
        is_default: true,
        owner_id: null,
      });
      const result = await service.duplicateTemplate('t1', undefined, 'teacher-9');
      expect(result).toMatchObject({
        name: 'Original (copy)',
        status: CertificateTemplateStatus.DRAFT,
        is_default: false,
        owner_id: 'teacher-9',
        layout: 'modern',
      });
    });
  });

  describe('issuance template gate', () => {
    const completeCourse = () => {
      certificates.findOne.mockResolvedValue(null);
      eligibility.lockActivePurchase.mockResolvedValue({ id: 'pp1', course_version_id: null });
      packageItems.count.mockResolvedValue(1);
      progress.createQueryBuilder.mockReturnValue(qb(1)); // 100%
      users.findOne.mockResolvedValue({ id: 'S1', name: 'Ada' });
      packages.findOne.mockResolvedValue({
        id: 'P1',
        title: 'Course',
        teacher: null,
        current_version_id: 'v1',
      });
    };

    it('refuses to issue from a DRAFT template', async () => {
      completeCourse();
      templates.findOne.mockResolvedValue({
        id: 'tpl-draft',
        status: CertificateTemplateStatus.DRAFT,
      });
      await expect(
        service.issueForCourse('S1', 'P1', { templateId: 'tpl-draft' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(certificates.save).not.toHaveBeenCalled();
    });

    it('refuses to freeze an unsupported placeholder into a certificate', async () => {
      completeCourse();
      templates.findOne.mockResolvedValue({
        id: 'tpl-invalid-token',
        name: 'Invalid token',
        title: 'Title',
        body: 'Presented to {{teacher}}',
        body_ar: null,
        status: CertificateTemplateStatus.PUBLISHED,
        owner_id: null,
      });

      await expect(
        service.issueForCourse('S1', 'P1', { templateId: 'tpl-invalid-token' }),
      ).rejects.toThrow('Unsupported certificate placeholders');
      expect(certificates.save).not.toHaveBeenCalled();
    });

    it("refuses a teacher using another teacher's template", async () => {
      completeCourse();
      templates.findOne.mockResolvedValue({
        id: 'tpl-other',
        status: CertificateTemplateStatus.PUBLISHED,
        owner_id: 'other-teacher',
      });
      await expect(
        service.issueForCourse('S1', 'P1', {
          templateId: 'tpl-other',
          restrictTemplateOwner: 'teacher-1',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('freezes the template design into the certificate at issue time', async () => {
      completeCourse();
      certificates.findOne.mockResolvedValue(null);
      templates.findOne.mockResolvedValue({
        id: 'tpl-pub',
        name: 'Frozen template',
        status: CertificateTemplateStatus.PUBLISHED,
        owner_id: null,
        title: 'Frozen Title',
        title_ar: null,
        body: 'Frozen body',
        body_ar: null,
        signature_name: null,
        signature_title: null,
        signature_title_ar: null,
        accent_color: '#ff0000',
        layout: 'classic',
        font: 'sans',
        title_font_size: 34,
        body_font_size: 16,
        text_alignment: 'center',
      });
      certificates.create.mockImplementation((v: unknown) => v);
      certificates.save.mockImplementation((v: Certificate) => Promise.resolve({ ...v, id: 'c1' }));

      const result = await service.issueForCourse('S1', 'P1', { templateId: 'tpl-pub' });

      expect(result.template_snapshot).toMatchObject({
        title: 'Frozen Title',
        accent_color: '#ff0000',
      });
    });
  });

  describe('snapshot immutability at render time', () => {
    it('renders from the frozen snapshot without touching the live template', async () => {
      pdf.render.mockResolvedValue(Buffer.from('pdf'));
      const certificate = {
        id: 'c1',
        template_id: 'tpl-1',
        template_snapshot: { title: 'Old design', accent_color: '#000000' },
      } as unknown as Certificate;

      await service.renderPdf(certificate);

      expect(templates.findOne).not.toHaveBeenCalled();
      expect(pdf.render).toHaveBeenCalledWith(
        certificate,
        expect.objectContaining({ title: 'Old design' }),
        expect.anything(),
      );
    });

    it('returns the frozen snapshot to every canonical renderer without a live lookup', async () => {
      const certificate = {
        id: 'c1',
        template_id: 'tpl-1',
        template_snapshot: { title: 'Issued design', accent_color: '#123456' },
      } as unknown as Certificate;

      await expect(service.getRenderableTemplateSnapshot(certificate)).resolves.toMatchObject({
        title: 'Issued design',
        accent_color: '#123456',
      });
      expect(templates.findOne).not.toHaveBeenCalled();
    });
  });

  describe('issuable template access', () => {
    it('returns only published platform and own teacher templates for issuance', async () => {
      templates.find.mockResolvedValue([
        { id: 'platform-template', owner_id: null, status: CertificateTemplateStatus.PUBLISHED },
        { id: 'own-template', owner_id: 'teacher-1', status: CertificateTemplateStatus.PUBLISHED },
      ]);
      certificates.createQueryBuilder.mockReturnValue(qb([]));

      const result = await service.getIssuableTemplates('teacher-1');

      expect(result).toHaveLength(2);
      expect(templates.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.arrayContaining([
            expect.objectContaining({ owner_id: 'teacher-1' }),
            expect.objectContaining({ status: CertificateTemplateStatus.PUBLISHED }),
          ]),
        }),
      );
    });
  });

  describe('revocation lifecycle', () => {
    it('revoke marks the certificate revoked and forces it private', async () => {
      certificates.findOne.mockResolvedValue({
        id: 'c1',
        status: CertificateStatus.ISSUED,
        is_public: true,
      });
      certificates.save.mockImplementation((v: unknown) => Promise.resolve(v));

      const result = await service.revokeCertificate('c1', 'cheating');

      expect(result.status).toBe(CertificateStatus.REVOKED);
      expect(result.is_public).toBe(false);
      expect(result.revoke_reason).toBe('cheating');
      expect(result.revoked_at).toBeInstanceOf(Date);
    });

    it('treats repeated revocation as an idempotent no-op', async () => {
      const certificate = { id: 'c1', status: CertificateStatus.REVOKED } as Certificate;
      certificates.findOne.mockResolvedValue(certificate);
      await expect(service.revokeCertificate('c1')).resolves.toBe(certificate);
      expect(certificates.save).not.toHaveBeenCalled();
    });

    it('a teacher cannot revoke a certificate of a course they do not own', async () => {
      certificates.findOne.mockResolvedValue({
        id: 'c1',
        package_id: 'P1',
        status: CertificateStatus.ISSUED,
      });
      packages.findOne.mockResolvedValue({ id: 'P1', teacher_id: 'someone-else' });
      await expect(service.revokeCertificate('c1', undefined, 'teacher-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('reissue restores validity under fresh credentials, keeping the snapshot', async () => {
      certificates.findOne
        .mockResolvedValueOnce({
          id: 'c1',
          status: CertificateStatus.REVOKED,
          certificate_number: 'CERT-OLD',
          verification_code: 'OLDCODE',
          template_snapshot: { title: 'Frozen' },
          revoked_at: new Date(),
          revoke_reason: 'x',
        })
        .mockResolvedValue(null); // unique number/code checks
      certificates.save.mockImplementation((v: unknown) => Promise.resolve(v));
      certificateHistory.create.mockImplementation((v: unknown) => v);
      certificateHistory.save.mockResolvedValue({ id: 'history-1' });

      const result = await service.reissueCertificate('c1');

      expect(result.status).toBe(CertificateStatus.ISSUED);
      expect(result.certificate_number).not.toBe('CERT-OLD');
      expect(result.verification_code).not.toBe('OLDCODE');
      expect(result.revoked_at).toBeNull();
      expect(result.template_snapshot).toMatchObject({ title: 'Frozen' });
      expect(certificateHistory.save).toHaveBeenCalledWith(
        expect.objectContaining({
          certificate_id: 'c1',
          certificate_number: 'CERT-OLD',
          verification_code: 'OLDCODE',
          revoke_reason: 'x',
        }),
      );
      expect(emitter.emit).toHaveBeenCalled();
    });

    it('reissue refuses a certificate that is not revoked', async () => {
      certificates.findOne.mockResolvedValue({ id: 'c1', status: CertificateStatus.ISSUED });
      await expect(service.reissueCertificate('c1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('reissue cannot resurrect a certificate whose course purchase was refunded', async () => {
      certificates.findOne.mockResolvedValue({
        id: 'c1',
        student_id: 'S1',
        package_id: 'P1',
        status: CertificateStatus.REVOKED,
      });
      eligibility.assertEligible.mockRejectedValue(
        new UnprocessableEntityException('no valid purchase'),
      );

      await expect(service.reissueCertificate('c1')).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      expect(certificates.save).not.toHaveBeenCalled();
    });

    it('records the manual revocation cause for the audit trail', async () => {
      certificates.findOne.mockResolvedValue({ id: 'c1', status: CertificateStatus.ISSUED });
      certificates.save.mockImplementation((value: unknown) => Promise.resolve(value));

      const revoked = await service.revokeCertificate('c1', 'duplicate', undefined, 'admin-9');

      expect(revoked.revoked_by).toBe('admin-9');
      expect(revoked.revocation_context).toEqual({ source: 'manual' });
    });
  });

  describe('auto-issuance retry after a refund', () => {
    it('abandons a queued retry once the student loses their purchase', async () => {
      autoIssuanceFailures.find.mockResolvedValue([
        { id: 'f1', student_id: 'S1', lesson_id: 'L1', package_id: 'P1', attempts: 1 },
      ]);
      eligibility.findActivePurchase.mockResolvedValue(null);
      const issueSpy = jest.spyOn(service, 'issueForCourse');
      autoIssuanceFailures.save.mockImplementation((value: unknown) => Promise.resolve(value));

      await service.retryPendingAutoIssuanceFailures();

      expect(issueSpy).not.toHaveBeenCalled();
      expect(autoIssuanceFailures.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'f1',
          resolved_at: expect.any(Date),
          last_error: expect.stringContaining('no longer holds a valid purchase'),
        }),
      );
    });

    it('still retries a student who is genuinely eligible', async () => {
      autoIssuanceFailures.find.mockResolvedValue([
        { id: 'f1', student_id: 'S1', lesson_id: 'L1', package_id: 'P1', attempts: 1 },
      ]);
      eligibility.findActivePurchase.mockResolvedValue({ id: 'pp1' });
      jest
        .spyOn(service, 'getCourseProgress')
        .mockResolvedValue({ total: 2, completed: 2, percentage: 100 });
      const issueSpy = jest
        .spyOn(service, 'issueForCourse')
        .mockResolvedValue({ id: 'c1' } as Certificate);
      autoIssuanceFailures.save.mockImplementation((value: unknown) => Promise.resolve(value));

      await service.retryPendingAutoIssuanceFailures();

      expect(issueSpy).toHaveBeenCalledWith('S1', 'P1');
    });
  });

  describe('bulkIssue', () => {
    it('rejects a teacher issuing for a course they do not own', async () => {
      packages.findOne.mockResolvedValue({ id: 'P1', teacher_id: 'someone-else' });
      await expect(
        service.bulkIssue({ packageId: 'P1', studentIds: ['S1'] }, 'teacher-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('skips already-certified students and reports per-student failures', async () => {
      packages.findOne.mockResolvedValue({ id: 'P1', teacher_id: 'teacher-1' });
      const issueSpy = jest.spyOn(service, 'issueForCourse');
      // S1 already has a certificate; S2 issues fine; S3 fails.
      certificates.findOne.mockImplementation(({ where }: { where: { student_id?: string } }) =>
        Promise.resolve(where.student_id === 'S1' ? { id: 'existing' } : null),
      );
      issueSpy.mockImplementation((studentId: string) =>
        studentId === 'S3'
          ? Promise.reject(new Error('boom'))
          : Promise.resolve({ id: `cert-${studentId}` } as Certificate),
      );

      const result = await service.bulkIssue(
        { packageId: 'P1', studentIds: ['S1', 'S2', 'S3'] },
        'teacher-1',
      );

      expect(result).toMatchObject({ requested: 3, issued: 1, skipped: 1 });
      expect(result.failed).toEqual([{ studentId: 'S3', reason: 'boom' }]);
    });

    it('rejects an empty target list', async () => {
      packages.findOne.mockResolvedValue({ id: 'P1', teacher_id: 'teacher-1' });
      await expect(
        service.bulkIssue({ packageId: 'P1', studentIds: [] }, 'teacher-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('public visibility', () => {
    it('a student can publish their own valid certificate', async () => {
      certificates.findOne.mockResolvedValue({
        id: 'c1',
        student_id: 'S1',
        status: CertificateStatus.ISSUED,
        is_public: false,
      });
      certificates.save.mockImplementation((v: unknown) => Promise.resolve(v));
      const result = await service.setVisibility('c1', 'S1', true);
      expect(result.is_public).toBe(true);
    });

    it('a revoked certificate can never be made public', async () => {
      certificates.findOne.mockResolvedValue({
        id: 'c1',
        student_id: 'S1',
        status: CertificateStatus.REVOKED,
      });
      await expect(service.setVisibility('c1', 'S1', true)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it("cannot toggle someone else's certificate (owner-scoped lookup)", async () => {
      certificates.findOne.mockResolvedValue(null);
      await expect(service.setVisibility('c1', 'intruder', true)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(certificates.findOne).toHaveBeenCalledWith({
        where: { id: 'c1', student_id: 'intruder' },
      });
    });
  });

  describe('public gallery', () => {
    it('only queries public + issued certificates and returns a sanitized card', async () => {
      const galleryQb = qb(0);
      galleryQb.skip = jest.fn(() => galleryQb);
      galleryQb.take = jest.fn(() => galleryQb);
      galleryQb.getManyAndCount = jest.fn().mockResolvedValue([
        [
          {
            id: 'internal-db-id',
            student_id: 'internal-student-id',
            verification_code: 'PUBCODE123',
            certificate_number: 'CERT-2026-XYZ',
            student_name: 'Ada',
            course_title: 'Algorithms',
            teacher_name: 'Prof X',
            issued_at: new Date('2026-01-01'),
            completion_percentage: 92,
          },
        ],
        1,
      ]);
      certificates.createQueryBuilder.mockReturnValue(galleryQb);

      const result = await service.getPublicCertificates({ page: 1, limit: 12 });

      expect(galleryQb.where).toHaveBeenCalledWith('c.is_public = true');
      expect(galleryQb.andWhere).toHaveBeenCalledWith('c.status = :status', {
        status: CertificateStatus.ISSUED,
      });
      const card = result.data[0] as Record<string, unknown>;
      expect(card.publicId).toBe('PUBCODE123');
      // Internal identifiers and grades never leave the server.
      expect(card).not.toHaveProperty('id');
      expect(card).not.toHaveProperty('student_id');
      expect(card).not.toHaveProperty('completion_percentage');
    });
  });
});
