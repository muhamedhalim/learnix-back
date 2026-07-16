import { BadRequestException, NotFoundException } from '@nestjs/common';
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
});
