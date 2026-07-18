import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getRepositoryToken } from '@nestjs/typeorm';

import { LessonPackage } from '../packages/entities/lesson-package.entity';
import { LessonPackageItem } from '../packages/entities/lesson-package-item.entity';
import { LessonProgress } from '../lessons/entities/lesson-progress.entity';
import { PackagePurchase } from '../payments/entities/package-purchase.entity';
import { User } from '../users/entities/user.entity';
import { CertificatePdfService } from './certificate-pdf.service';
import { CertificatesService } from './certificates.service';
import { Certificate } from './entities/certificate.entity';
import { CertificateStatus } from './entities/certificate-status.enum';
import { CertificateTemplate } from './entities/certificate-template.entity';
import { CertificateTemplateStatus } from './entities/certificate-template-status.enum';

function qb(result: number | unknown[]) {
  const b: Record<string, jest.Mock> = {};
  for (const m of ['innerJoin', 'where', 'andWhere', 'select', 'addSelect', 'groupBy', 'orderBy', 'limit', 'update', 'set']) {
    b[m] = jest.fn(() => b);
  }
  b.getCount = jest.fn().mockResolvedValue(typeof result === 'number' ? result : 0);
  b.getRawMany = jest.fn().mockResolvedValue(Array.isArray(result) ? result : []);
  b.execute = jest.fn().mockResolvedValue({});
  return b;
}

describe('CertificatesService', () => {
  let service: CertificatesService;

  const certificates = { findOne: jest.fn(), find: jest.fn(), create: jest.fn(), save: jest.fn(), createQueryBuilder: jest.fn() };
  const templates = {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
  const packages = { findOne: jest.fn() };
  const packageItems = { count: jest.fn() };
  const progress = { createQueryBuilder: jest.fn() };
  const purchases = { createQueryBuilder: jest.fn() };
  const users = { findOne: jest.fn() };
  const pdf = { render: jest.fn() };
  const emitter = { emit: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    templates.createQueryBuilder.mockReturnValue(qb(0));
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CertificatesService,
        { provide: getRepositoryToken(Certificate), useValue: certificates },
        { provide: getRepositoryToken(CertificateTemplate), useValue: templates },
        { provide: getRepositoryToken(LessonPackage), useValue: packages },
        { provide: getRepositoryToken(LessonPackageItem), useValue: packageItems },
        { provide: getRepositoryToken(LessonProgress), useValue: progress },
        { provide: getRepositoryToken(PackagePurchase), useValue: purchases },
        { provide: getRepositoryToken(User), useValue: users },
        { provide: CertificatePdfService, useValue: pdf },
        { provide: EventEmitter2, useValue: emitter },
      ],
    }).compile();
    service = module.get(CertificatesService);
  });

  describe('getCourseProgress', () => {
    it('returns 0% for a course with no lessons', async () => {
      packageItems.count.mockResolvedValue(0);
      const result = await service.getCourseProgress('S1', 'P1');
      expect(result).toEqual({ total: 0, completed: 0, percentage: 0 });
    });

    it('computes percentage from completed/total', async () => {
      packageItems.count.mockResolvedValue(4);
      progress.createQueryBuilder.mockReturnValue(qb(3));
      const result = await service.getCourseProgress('S1', 'P1');
      expect(result).toEqual({ total: 4, completed: 3, percentage: 75 });
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
      packageItems.count.mockResolvedValue(4);
      progress.createQueryBuilder.mockReturnValue(qb(2)); // 50%
      await expect(service.issueForCourse('S1', 'P1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('issues, snapshots names, and emits when complete', async () => {
      certificates.findOne
        .mockResolvedValueOnce(null) // no existing cert
        .mockResolvedValue(null); // unique number/code checks
      packageItems.count.mockResolvedValue(2);
      progress.createQueryBuilder.mockReturnValue(qb(2)); // 100%
      users.findOne.mockResolvedValue({ id: 'S1', name: 'Ada Lovelace' });
      packages.findOne.mockResolvedValue({
        id: 'P1',
        title: 'Algorithms',
        teacher: { name: 'Prof X' },
      });
      templates.findOne.mockResolvedValue({ id: 't1' });
      certificates.create.mockImplementation((v: unknown) => v);
      certificates.save.mockImplementation((v: Certificate) => Promise.resolve({ ...v, id: 'new' }));

      const result = await service.issueForCourse('S1', 'P1');

      expect(result.student_name).toBe('Ada Lovelace');
      expect(result.course_title).toBe('Algorithms');
      expect(result.teacher_name).toBe('Prof X');
      expect(result.status).toBe(CertificateStatus.ISSUED);
      expect(result.certificate_number).toMatch(/^CERT-\d{4}-/);
      expect(emitter.emit).toHaveBeenCalled();
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
      packageItems.count.mockResolvedValue(1);
      progress.createQueryBuilder.mockReturnValue(qb(1)); // 100%
      users.findOne.mockResolvedValue({ id: 'S1', name: 'Ada' });
      packages.findOne.mockResolvedValue({ id: 'P1', title: 'Course', teacher: null });
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

    it('revoking an already-revoked certificate is rejected', async () => {
      certificates.findOne.mockResolvedValue({ id: 'c1', status: CertificateStatus.REVOKED });
      await expect(service.revokeCertificate('c1')).rejects.toBeInstanceOf(BadRequestException);
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

      const result = await service.reissueCertificate('c1');

      expect(result.status).toBe(CertificateStatus.ISSUED);
      expect(result.certificate_number).not.toBe('CERT-OLD');
      expect(result.verification_code).not.toBe('OLDCODE');
      expect(result.revoked_at).toBeNull();
      expect(result.template_snapshot).toMatchObject({ title: 'Frozen' });
      expect(emitter.emit).toHaveBeenCalled();
    });

    it('reissue refuses a certificate that is not revoked', async () => {
      certificates.findOne.mockResolvedValue({ id: 'c1', status: CertificateStatus.ISSUED });
      await expect(service.reissueCertificate('c1')).rejects.toBeInstanceOf(BadRequestException);
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
