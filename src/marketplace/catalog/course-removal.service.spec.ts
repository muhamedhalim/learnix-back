import { ConflictException } from '@nestjs/common';
import type { FindOperator } from 'typeorm';

import { Certificate } from '../../certificates/entities/certificate.entity';
import { CertificateStatus } from '../../certificates/entities/certificate-status.enum';
import { CourseRemovalCause, MarketplaceCourseStatus } from '../common/enums';
import { MarketplaceEnrollmentStatus, RefundRequestStatus } from '../common/enums';
import { MarketplaceEnrollment } from '../commerce/entities';
import { MarketplaceCourseReview } from '../reviews/entities/marketplace-course-review.entity';
import { CourseRemovalService } from './course-removal.service';

function buildCourse(overrides: Record<string, unknown> = {}) {
  return {
    id: 'course-1',
    title: 'Removed Course',
    status: MarketplaceCourseStatus.PUBLISHED,
    removed_at: null,
    ...overrides,
  };
}

function buildEnrollment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'enrollment-1',
    course_id: 'course-1',
    order_id: 'order-1',
    learner_id: 'learner-1',
    status: MarketplaceEnrollmentStatus.ACTIVE,
    order: { is_zero_value: false },
    ...overrides,
  };
}

describe('CourseRemovalService (T142)', () => {
  let coursesRepo: { findOne: jest.Mock; update: jest.Mock };
  let removalsRepo: {
    save: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    findOneOrFail: jest.Mock;
    increment: jest.Mock;
  };
  let enrollmentsRepo: { createQueryBuilder: jest.Mock };
  let qb: {
    innerJoinAndSelect: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    getMany: jest.Mock;
  };
  let marketplaceQueue: { addBulk: jest.Mock };
  let dataSource: { transaction: jest.Mock; getRepository: jest.Mock };
  let lifecycle: { adminUnpublish: jest.Mock };
  let refundRequests: { createRemovalDrivenRefund: jest.Mock };
  let refundProcessing: { process: jest.Mock };
  let activityLogs: { recordAuditEvent: jest.Mock };
  let service: CourseRemovalService;

  beforeEach(() => {
    coursesRepo = { findOne: jest.fn(), update: jest.fn() };
    removalsRepo = {
      save: jest.fn(async (data: Record<string, unknown>) => ({
        id: 'removal-1',
        enrollments_revoked: 0,
        refunds_issued: 0,
        refunds_failed: 0,
        earnings_reversed_minor: 0,
        completed_at: null,
        ...data,
      })),
      create: jest.fn((data: Record<string, unknown>) => data),
      update: jest.fn().mockResolvedValue(undefined),
      findOneOrFail: jest.fn(),
      increment: jest.fn().mockResolvedValue(undefined),
    };
    qb = {
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    enrollmentsRepo = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
    marketplaceQueue = { addBulk: jest.fn().mockResolvedValue(undefined) };
    dataSource = {
      transaction: jest.fn(async (fn: (manager: unknown) => unknown) =>
        fn({
          findOne: jest.fn(),
          save: jest.fn((_e: unknown, data: unknown) => data),
        }),
      ),
      getRepository: jest.fn(),
    };
    lifecycle = { adminUnpublish: jest.fn().mockResolvedValue(undefined) };
    refundRequests = { createRemovalDrivenRefund: jest.fn() };
    refundProcessing = { process: jest.fn() };
    activityLogs = { recordAuditEvent: jest.fn().mockResolvedValue(undefined) };

    service = new CourseRemovalService(
      coursesRepo as never,
      removalsRepo as never,
      enrollmentsRepo as never,
      marketplaceQueue as never,
      dataSource as never,
      lifecycle as never,
      refundRequests as never,
      refundProcessing as never,
      activityLogs as never,
    );
  });

  describe('removeCourse', () => {
    it('unpublishes a published course, stamps removal, and records an audit event', async () => {
      coursesRepo.findOne.mockResolvedValue(buildCourse());
      removalsRepo.findOneOrFail.mockResolvedValue({ id: 'removal-1', completed_at: new Date() });

      await service.removeCourse(
        'admin-1',
        'course-1',
        CourseRemovalCause.POLICY_VIOLATION,
        'Terms violation',
      );

      expect(lifecycle.adminUnpublish).toHaveBeenCalledWith(
        'admin-1',
        'course-1',
        'Terms violation',
      );
      expect(coursesRepo.update).toHaveBeenCalledWith(
        'course-1',
        expect.objectContaining({ removed_by: 'admin-1', removal_reason: 'Terms violation' }),
      );
      expect(activityLogs.recordAuditEvent).toHaveBeenCalled();
    });

    it('is idempotent: a course already removed returns the existing removal record without redoing anything', async () => {
      coursesRepo.findOne.mockResolvedValue(buildCourse({ removed_at: new Date() }));
      removalsRepo.findOneOrFail.mockResolvedValue({ id: 'removal-1' });

      const result = await service.removeCourse(
        'admin-1',
        'course-1',
        CourseRemovalCause.POLICY_VIOLATION,
        'again',
      );

      expect(result).toMatchObject({ id: 'removal-1' });
      expect(lifecycle.adminUnpublish).not.toHaveBeenCalled();
      expect(coursesRepo.update).not.toHaveBeenCalled();
    });

    it('refuses a course that is not published or unpublished (e.g. still draft)', async () => {
      coursesRepo.findOne.mockResolvedValue(buildCourse({ status: MarketplaceCourseStatus.DRAFT }));

      await expect(
        service.removeCourse('admin-1', 'course-1', CourseRemovalCause.POLICY_VIOLATION, 'x'),
      ).rejects.toThrow(ConflictException);
    });

    it('marks completed immediately when the course has no active/suspended enrollments', async () => {
      coursesRepo.findOne.mockResolvedValue(buildCourse());
      qb.getMany.mockResolvedValue([]);
      removalsRepo.findOneOrFail.mockResolvedValue({ id: 'removal-1', completed_at: new Date() });

      const result = await service.removeCourse(
        'admin-1',
        'course-1',
        CourseRemovalCause.LEGAL_TAKEDOWN,
        'x',
      );

      expect(marketplaceQueue.addBulk).not.toHaveBeenCalled();
      expect(removalsRepo.update).toHaveBeenCalledWith('removal-1', {
        completed_at: expect.any(Date),
      });
      expect(result.completed_at).not.toBeNull();
    });

    it('enqueues one deterministic per-order job for every active/suspended enrollment, mixing paid and zero-value', async () => {
      coursesRepo.findOne.mockResolvedValue(buildCourse());
      qb.getMany.mockResolvedValue([
        buildEnrollment({ id: 'e1', order_id: 'o1', order: { is_zero_value: false } }),
        buildEnrollment({ id: 'e2', order_id: 'o2', order: { is_zero_value: true } }),
      ]);

      await service.removeCourse(
        'admin-1',
        'course-1',
        CourseRemovalCause.INSTRUCTOR_DEPARTURE,
        'x',
      );

      expect(marketplaceQueue.addBulk).toHaveBeenCalledWith([
        expect.objectContaining({
          data: expect.objectContaining({ orderId: 'o1', isZeroValue: false, totalCount: 2 }),
          opts: { jobId: 'marketplace.removal.o1' },
        }),
        expect.objectContaining({
          data: expect.objectContaining({ orderId: 'o2', isZeroValue: true, totalCount: 2 }),
          opts: { jobId: 'marketplace.removal.o2' },
        }),
      ]);
    });
  });

  describe('processRemovalOrder', () => {
    const baseJob = {
      removalId: 'removal-1',
      courseId: 'course-1',
      orderId: 'order-1',
      enrollmentId: 'enrollment-1',
      learnerId: 'learner-1',
      isZeroValue: false,
      totalCount: 1,
    };

    function buildZeroValueManager(opts: {
      enrollment?: Record<string, unknown> | null;
      certificate?: Record<string, unknown> | null;
      review?: Record<string, unknown> | null;
    }) {
      const state = {
        enrollment:
          opts.enrollment === undefined
            ? {
                id: 'enrollment-1',
                learner_id: 'learner-1',
                course_id: 'course-1',
                status: MarketplaceEnrollmentStatus.ACTIVE,
              }
            : opts.enrollment,
        certificate: opts.certificate === undefined ? null : opts.certificate,
        review: opts.review === undefined ? null : opts.review,
      };
      const saved: Record<string, unknown[]> = { enrollment: [], certificate: [], review: [] };
      const entityKey = new Map<unknown, keyof typeof state>([
        [MarketplaceEnrollment, 'enrollment'],
        [Certificate, 'certificate'],
        [MarketplaceCourseReview, 'review'],
      ]);
      const manager = {
        findOne: jest.fn(async (entity: unknown) => {
          const key = entityKey.get(entity);
          return key ? state[key] : null;
        }),
        save: jest.fn(async (entity: unknown, data: Record<string, unknown>) => {
          const key = entityKey.get(entity);
          if (key) saved[key]!.push(data);
          return data;
        }),
      };
      return { manager, state, saved };
    }

    it('directly revokes a zero-value enrollment and counts it as revoked, never as a refund', async () => {
      const { manager, saved } = buildZeroValueManager({});
      dataSource.transaction.mockImplementation(async (fn: (m: unknown) => unknown) => fn(manager));

      await service.processRemovalOrder({ ...baseJob, isZeroValue: true });

      expect(saved.enrollment).toEqual([
        expect.objectContaining({
          status: MarketplaceEnrollmentStatus.REVOKED,
          revocation_reason: 'Course permanently removed',
        }),
      ]);
      expect(removalsRepo.increment).toHaveBeenCalledWith(
        { id: 'removal-1' },
        'enrollments_revoked',
        1,
      );
      expect(refundRequests.createRemovalDrivenRefund).not.toHaveBeenCalled();
    });

    it('also revokes the certificate and withdraws the review for a zero-value enrollment (no earning ever exists to reverse)', async () => {
      const { manager, saved } = buildZeroValueManager({
        certificate: { status: CertificateStatus.ISSUED, is_public: true },
        review: { withdrawn_at: null },
      });
      dataSource.transaction.mockImplementation(async (fn: (m: unknown) => unknown) => fn(manager));

      await service.processRemovalOrder({ ...baseJob, isZeroValue: true });

      expect(saved.certificate).toEqual([
        expect.objectContaining({ status: CertificateStatus.REVOKED, is_public: false }),
      ]);
      expect(saved.review).toEqual([expect.objectContaining({ withdrawn_at: expect.any(Date) })]);
    });

    it('never double-revokes an already-revoked zero-value enrollment (retry safety)', async () => {
      const managerFindOne = jest
        .fn()
        .mockResolvedValue({ id: 'enrollment-1', status: MarketplaceEnrollmentStatus.REVOKED });
      dataSource.transaction.mockImplementation(async (fn: (m: unknown) => unknown) =>
        fn({ findOne: managerFindOne, save: jest.fn() }),
      );

      await service.processRemovalOrder({ ...baseJob, isZeroValue: true });

      expect(removalsRepo.increment).not.toHaveBeenCalledWith(
        { id: 'removal-1' },
        'enrollments_revoked',
        1,
      );
    });

    it('creates a removal-driven refund for a paid enrollment and, on success, counts both a refund and a revocation plus the earnings reversed', async () => {
      const refundReq = { id: 'refund-1', status: RefundRequestStatus.COMPLETED };
      dataSource.getRepository.mockImplementation((entity: { name: string }) => {
        if (entity.name === 'MarketplaceRefundRequest')
          return { findOne: jest.fn().mockResolvedValue(null) };
        if (entity.name === 'InstructorEarning')
          return {
            findOne: jest.fn().mockResolvedValue({ net_amount_minor: 3500, currency: 'EGP' }),
          };
        throw new Error('unexpected repo');
      });
      refundRequests.createRemovalDrivenRefund.mockResolvedValue(refundReq);

      await service.processRemovalOrder(baseJob);

      expect(refundRequests.createRemovalDrivenRefund).toHaveBeenCalledWith(
        'order-1',
        'enrollment-1',
        'learner-1',
        'Course permanently removed',
      );
      expect(removalsRepo.increment).toHaveBeenCalledWith({ id: 'removal-1' }, 'refunds_issued', 1);
      expect(removalsRepo.increment).toHaveBeenCalledWith(
        { id: 'removal-1' },
        'enrollments_revoked',
        1,
      );
      expect(removalsRepo.increment).toHaveBeenCalledWith(
        { id: 'removal-1' },
        'earnings_reversed_minor',
        3500,
      );
    });

    it('counts a failed removal-driven refund attempt without touching enrollments_revoked', async () => {
      dataSource.getRepository.mockImplementation((entity: { name: string }) => {
        if (entity.name === 'MarketplaceRefundRequest')
          return { findOne: jest.fn().mockResolvedValue(null) };
        throw new Error('unexpected repo');
      });
      refundRequests.createRemovalDrivenRefund.mockResolvedValue({
        id: 'refund-1',
        status: RefundRequestStatus.FAILED,
      });

      await service.processRemovalOrder(baseJob);

      expect(removalsRepo.increment).toHaveBeenCalledWith({ id: 'removal-1' }, 'refunds_failed', 1);
      expect(removalsRepo.increment).not.toHaveBeenCalledWith(
        { id: 'removal-1' },
        'enrollments_revoked',
        1,
      );
    });

    it('never double-counts a retried delivery once the underlying refund request already reached a terminal state', async () => {
      dataSource.getRepository.mockImplementation((entity: { name: string }) => {
        if (entity.name === 'MarketplaceRefundRequest')
          return {
            findOne: jest
              .fn()
              .mockResolvedValue({ id: 'refund-1', status: RefundRequestStatus.COMPLETED }),
          };
        throw new Error('unexpected repo');
      });

      await service.processRemovalOrder(baseJob);

      expect(refundRequests.createRemovalDrivenRefund).not.toHaveBeenCalled();
      expect(refundProcessing.process).not.toHaveBeenCalled();
      expect(removalsRepo.increment).not.toHaveBeenCalledWith(
        expect.anything(),
        'refunds_issued',
        expect.anything(),
      );
    });

    it('resumes an existing non-terminal refund request through RefundProcessingService rather than creating a second one', async () => {
      dataSource.getRepository.mockImplementation((entity: { name: string }) => {
        if (entity.name === 'MarketplaceRefundRequest')
          return {
            findOne: jest
              .fn()
              .mockResolvedValue({ id: 'refund-1', status: RefundRequestStatus.APPROVED }),
          };
        if (entity.name === 'InstructorEarning')
          return { findOne: jest.fn().mockResolvedValue(null) };
        throw new Error('unexpected repo');
      });
      refundProcessing.process.mockResolvedValue({
        id: 'refund-1',
        status: RefundRequestStatus.COMPLETED,
      });

      await service.processRemovalOrder(baseJob);

      expect(refundProcessing.process).toHaveBeenCalledWith('refund-1');
      expect(refundRequests.createRemovalDrivenRefund).not.toHaveBeenCalled();
    });

    it('skips this delivery without incrementing anything when a concurrent delivery is already in flight', async () => {
      dataSource.getRepository.mockImplementation((entity: { name: string }) => {
        if (entity.name === 'MarketplaceRefundRequest')
          return { findOne: jest.fn().mockResolvedValue(null) };
        throw new Error('unexpected repo');
      });
      refundRequests.createRemovalDrivenRefund.mockRejectedValue(
        new ConflictException('already processing'),
      );

      await service.processRemovalOrder(baseJob);

      expect(removalsRepo.increment).not.toHaveBeenCalled();
    });

    /**
     * A refund-request lookup that honours the `where` clause: `learnerRequest` is the learner's own,
     * earlier request for this order (not removal-driven); there is no removal-driven one yet.
     */
    function refundRequestsWith(learnerRequest: { id: string; status: RefundRequestStatus }) {
      return {
        findOne: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
          if (where.is_removal_driven === true) return null;
          const status = where.status as FindOperator<RefundRequestStatus[]> | undefined;
          if (status && !status.value.includes(learnerRequest.status)) return null;
          return { ...learnerRequest, is_removal_driven: false };
        }),
      };
    }

    it.each([RefundRequestStatus.FAILED, RefundRequestStatus.REJECTED])(
      "still refunds and counts the order when the learner's own earlier request is %s (FIA-010)",
      async (learnerStatus) => {
        dataSource.getRepository.mockImplementation((entity: { name: string }) => {
          if (entity.name === 'MarketplaceRefundRequest')
            return refundRequestsWith({ id: 'learner-refund', status: learnerStatus });
          if (entity.name === 'InstructorEarning')
            return { findOne: jest.fn().mockResolvedValue(null) };
          throw new Error('unexpected repo');
        });
        // What re-processing the learner's closed request does for real: it is not approved.
        refundProcessing.process.mockRejectedValue(
          new ConflictException('This refund request must be approved before it can be processed'),
        );
        refundRequests.createRemovalDrivenRefund.mockResolvedValue({
          id: 'removal-refund',
          status: RefundRequestStatus.FAILED,
        });

        await service.processRemovalOrder(baseJob);

        expect(refundProcessing.process).not.toHaveBeenCalled();
        expect(refundRequests.createRemovalDrivenRefund).toHaveBeenCalledWith(
          'order-1',
          'enrollment-1',
          'learner-1',
          'Course permanently removed',
        );
        expect(removalsRepo.increment).toHaveBeenCalledWith(
          { id: 'removal-1' },
          'refunds_failed',
          1,
        );
      },
    );

    it("resumes the learner's own still-open request instead of opening a second refund (FIA-010)", async () => {
      dataSource.getRepository.mockImplementation((entity: { name: string }) => {
        if (entity.name === 'MarketplaceRefundRequest')
          return refundRequestsWith({ id: 'learner-refund', status: RefundRequestStatus.APPROVED });
        if (entity.name === 'InstructorEarning')
          return { findOne: jest.fn().mockResolvedValue(null) };
        throw new Error('unexpected repo');
      });
      refundProcessing.process.mockResolvedValue({
        id: 'learner-refund',
        status: RefundRequestStatus.COMPLETED,
      });

      await service.processRemovalOrder(baseJob);

      expect(refundProcessing.process).toHaveBeenCalledWith('learner-refund');
      expect(refundRequests.createRemovalDrivenRefund).not.toHaveBeenCalled();
      expect(removalsRepo.increment).toHaveBeenCalledWith({ id: 'removal-1' }, 'refunds_issued', 1);
    });
  });
});
