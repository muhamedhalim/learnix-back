import { BadRequestException } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';

import { Book } from '../books/entities/book.entity';
import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonPackage } from '../packages/entities/lesson-package.entity';
import { CommissionService } from '../payments/services/commission.service';
import { QUEUE_NAMES, JOB_TYPES } from '../queues/queues.constants';
import { CodeBatchesService } from './code-batches.service';
import { BulkCodeAction } from './dto';
import {
  AttendanceCode,
  AttendanceCodeAudit,
  AttendanceCodeAuditAction,
  AttendanceCodeStatus,
  AttendanceCodeType,
  CodeBatch,
} from './entities';

describe('CodeBatchesService', () => {
  let service: CodeBatchesService;

  const batchRepo = {
    create: jest.fn((v: unknown) => v),
    save: jest.fn(),
    findOne: jest.fn(),
    count: jest.fn(),
    createQueryBuilder: jest.fn(),
    update: jest.fn(),
  };
  const codeRepo = {
    delete: jest.fn(),
    createQueryBuilder: jest.fn(),
    findOne: jest.fn(),
  };
  const auditRepo = {
    insert: jest.fn(),
    create: jest.fn((v: unknown) => v),
    save: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
  const lessonsRepo = { findOne: jest.fn() };
  const packagesRepo = { findOne: jest.fn() };
  const booksRepo = { findOne: jest.fn() };
  const queue = { add: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CodeBatchesService,
        { provide: getRepositoryToken(CodeBatch), useValue: batchRepo },
        { provide: getRepositoryToken(AttendanceCode), useValue: codeRepo },
        { provide: getRepositoryToken(AttendanceCodeAudit), useValue: auditRepo },
        { provide: getRepositoryToken(Lesson), useValue: lessonsRepo },
        { provide: getRepositoryToken(LessonPackage), useValue: packagesRepo },
        { provide: getRepositoryToken(Book), useValue: booksRepo },
        { provide: getQueueToken(QUEUE_NAMES.CODE_GENERATION), useValue: queue },
        {
          provide: CommissionService,
          useValue: { resolveRate: jest.fn().mockReturnValue(3_000) },
        },
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile();
    service = module.get(CodeBatchesService);
  });

  describe('createBatch', () => {
    it('validates the item, persists the batch, audits and enqueues generation', async () => {
      lessonsRepo.findOne.mockResolvedValue({
        id: 'lesson-1',
        teacher_id: 'teacher-1',
        price: 100,
        is_group: true,
      });
      batchRepo.save.mockResolvedValue({
        id: 'batch-1',
        name: 'Spring',
        type: AttendanceCodeType.LESSON,
        item_id: 'lesson-1',
        requested_count: 500,
      });

      const result = await service.createBatch(
        {
          name: 'Spring',
          type: AttendanceCodeType.LESSON,
          item_id: 'lesson-1',
          count: 500,
          expires_at: '2030-01-01T00:00:00Z',
        },
        'admin-1',
      );

      expect(result.id).toBe('batch-1');
      expect(auditRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          batch_id: 'batch-1',
          action: AttendanceCodeAuditAction.BATCH_CREATED,
          actor_id: 'admin-1',
        }),
      );
      expect(queue.add).toHaveBeenCalledWith(JOB_TYPES.CODE.GENERATE_BATCH, {
        batchId: 'batch-1',
      });
    });

    it('rejects when the target lesson does not exist', async () => {
      lessonsRepo.findOne.mockResolvedValue(null);
      await expect(
        service.createBatch(
          {
            name: 'X',
            type: AttendanceCodeType.LESSON,
            item_id: 'missing',
            count: 1,
            expires_at: '2030-01-01T00:00:00Z',
          },
          'admin-1',
        ),
      ).rejects.toThrow('Lesson not found');
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('rejects a batch targeting an Individual lesson', async () => {
      lessonsRepo.findOne.mockResolvedValue({
        id: 'lesson-1',
        teacher_id: 'teacher-1',
        price: 100,
        is_group: false,
      });

      await expect(
        service.createBatch(
          {
            name: 'Individual',
            type: AttendanceCodeType.LESSON,
            item_id: 'lesson-1',
            count: 1,
            expires_at: '2030-01-01T00:00:00Z',
          },
          'admin-1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(batchRepo.save).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });
  });

  describe('bulkAction', () => {
    it('deletes selected codes and records a DELETED audit', async () => {
      codeRepo.delete.mockResolvedValue({ affected: 2 });
      const result = await service.bulkAction(
        { action: BulkCodeAction.DELETE, code_ids: ['a', 'b'] },
        'admin-1',
      );
      expect(result).toEqual({ affected: 2 });
      expect(auditRepo.save).toHaveBeenCalled();
    });

    it('revokes only non-redeemed codes', async () => {
      const execute = jest.fn().mockResolvedValue({ affected: 3 });
      const chain: Record<string, jest.Mock> = {};
      for (const m of ['update', 'set', 'where', 'andWhere']) {
        chain[m] = jest.fn(() => chain);
      }
      chain['execute'] = execute;
      codeRepo.createQueryBuilder.mockReturnValue(chain);

      const result = await service.bulkAction(
        { action: BulkCodeAction.REVOKE, code_ids: ['a', 'b', 'c'], reason: 'x' },
        'admin-1',
      );
      expect(result).toEqual({ affected: 3 });
      expect(chain['andWhere']).toHaveBeenCalledWith(
        expect.stringContaining('status != :redeemed'),
        expect.objectContaining({ redeemed: AttendanceCodeStatus.REDEEMED }),
      );
    });
  });

  describe('getAnalytics', () => {
    it('computes redemption rate from status counts', async () => {
      const chain: Record<string, jest.Mock> = {};
      chain['andWhere'] = jest.fn(() => chain);
      // Order: generated, redeemed, revoked, expired, remaining.
      chain['getCount'] = jest
        .fn()
        .mockResolvedValueOnce(100)
        .mockResolvedValueOnce(40)
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(10)
        .mockResolvedValueOnce(45);
      codeRepo.createQueryBuilder.mockReturnValue(chain);

      const analytics = await service.getAnalytics({ batch_id: 'batch-1' });
      expect(analytics.generated).toBe(100);
      expect(analytics.redeemed).toBe(40);
      expect(analytics.redemptionRate).toBeCloseTo(0.4);
    });
  });

  describe('getTimeline', () => {
    it('synthesizes a created event for legacy batches with no audit', async () => {
      batchRepo.findOne.mockResolvedValue({
        id: 'batch-1',
        created_at: new Date('2026-01-01T00:00:00Z'),
        requested_count: 10,
      });
      const qb: Record<string, jest.Mock> = {};
      for (const m of ['leftJoinAndSelect', 'where', 'orderBy']) {
        qb[m] = jest.fn(() => qb);
      }
      qb['getMany'] = jest.fn().mockResolvedValue([]);
      auditRepo.createQueryBuilder.mockReturnValue(qb);

      const events = await service.getTimeline('batch-1');
      expect(events).toHaveLength(1);
      expect(events[0]!.action).toBe(AttendanceCodeAuditAction.BATCH_CREATED);
    });

    it('throws when the batch is missing', async () => {
      batchRepo.findOne.mockResolvedValue(null);
      await expect(service.getTimeline('nope')).rejects.toThrow('Batch not found');
    });
  });
});
