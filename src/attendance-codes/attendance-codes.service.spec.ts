import { ConflictException, NotFoundException } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { Book } from '../books/entities/book.entity';
import { BookPurchase } from '../books/entities/book-purchase.entity';
import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonPackage } from '../packages/entities/lesson-package.entity';
import { LessonPurchase, PackagePurchase, Payment } from '../payments/entities';
import { CommissionService } from '../payments/services/commission.service';
import { OrdersService } from '../payments/services/orders.service';
import { PaymentFinalizationService } from '../payments/services/payment-finalization.service';
import { AttendanceCodesService } from './attendance-codes.service';
import { AttendanceCode, AttendanceCodeStatus, AttendanceCodeType } from './entities';

describe('AttendanceCodesService — redemption correctness', () => {
  let service: AttendanceCodesService;
  let codesRepo: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock };
  let lessonsRepo: { findOne: jest.Mock };
  let packagesRepo: { findOne: jest.Mock };
  let booksRepo: { findOne: jest.Mock };
  let orders: { createActivationCodeOrder: jest.Mock };
  let finalizer: { finalizeSuccessfulPayment: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let manager: {
    findOne: jest.Mock;
    getRepository: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    insert: jest.Mock;
    increment: jest.Mock;
  };

  /** Per-entity responses for manager.findOne, settable per test. */
  let managerFindOneByEntity: Map<unknown, unknown>;
  let lookupCode: AttendanceCode | null;

  const buildCode = (over: Partial<AttendanceCode> = {}): AttendanceCode =>
    ({
      id: 'code-1',
      code: 'ABCD1234',
      type: AttendanceCodeType.LESSON,
      item_id: 'lesson-1',
      batch_id: null,
      status: AttendanceCodeStatus.UNUSED,
      is_used: false,
      is_active: true,
      valid_from: null,
      expires_at: new Date(Date.now() + 86_400_000),
      redemption_count: 0,
      maximum_redemptions: 1,
      assigned_student_id: null,
      ...over,
    }) as AttendanceCode;

  beforeEach(async () => {
    managerFindOneByEntity = new Map();
    lookupCode = null;
    const queryBuilder = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn(() => Promise.resolve(lookupCode)),
    };
    manager = {
      findOne: jest.fn((entity: unknown) =>
        Promise.resolve(managerFindOneByEntity.get(entity) ?? null),
      ),
      getRepository: jest.fn(() => ({
        createQueryBuilder: jest.fn(() => queryBuilder),
      })),
      save: jest.fn((_entity: unknown, obj: unknown) =>
        Promise.resolve({ id: 'saved-1', ...(obj as object) }),
      ),
      create: jest.fn((_entity: unknown, obj: unknown) => obj),
      insert: jest.fn().mockResolvedValue(undefined),
      increment: jest.fn().mockResolvedValue(undefined),
    };
    dataSource = {
      transaction: jest.fn((a: unknown, b: unknown) => {
        const fn = (typeof a === 'function' ? a : b) as (m: unknown) => unknown;
        return fn(manager);
      }),
    };
    codesRepo = { findOne: jest.fn(), create: jest.fn((o: unknown) => o), save: jest.fn() };
    lessonsRepo = { findOne: jest.fn() };
    packagesRepo = { findOne: jest.fn() };
    booksRepo = { findOne: jest.fn() };
    orders = {
      createActivationCodeOrder: jest.fn().mockResolvedValue({
        order: { id: 'order-1', final_amount_minor: 10_000, currency: 'EGP' },
        payment: { id: 'payment-1' } as Payment,
      }),
    };
    finalizer = { finalizeSuccessfulPayment: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendanceCodesService,
        { provide: getRepositoryToken(AttendanceCode), useValue: codesRepo },
        { provide: getRepositoryToken(Lesson), useValue: lessonsRepo },
        { provide: getRepositoryToken(LessonPackage), useValue: packagesRepo },
        { provide: getRepositoryToken(Book), useValue: booksRepo },
        { provide: DataSource, useValue: dataSource },
        { provide: OrdersService, useValue: orders },
        { provide: PaymentFinalizationService, useValue: finalizer },
        {
          provide: CommissionService,
          useValue: { resolveRate: jest.fn().mockReturnValue(3_000) },
        },
      ],
    }).compile();

    service = module.get(AttendanceCodesService);
  });

  describe('verifyAndRedeem', () => {
    it('rejects an unknown/used/expired code without side effects', async () => {
      lookupCode = null;

      await expect(service.verifyAndRedeem({ code: 'nope' }, 'student-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(orders.createActivationCodeOrder).not.toHaveBeenCalled();
      expect(finalizer.finalizeSuccessfulPayment).not.toHaveBeenCalled();
    });

    it('locks a lesson code and routes redemption through the canonical finalizer', async () => {
      lookupCode = buildCode();
      managerFindOneByEntity.set(LessonPurchase, null); // not already owned

      const result = await service.verifyAndRedeem({ code: 'abcd1234' }, 'student-1');

      expect(orders.createActivationCodeOrder).toHaveBeenCalledWith(
        manager,
        lookupCode,
        'student-1',
      );
      expect(finalizer.finalizeSuccessfulPayment).toHaveBeenCalledWith(
        {
          orderId: 'order-1',
          paymentId: 'payment-1',
          sourceReference: 'activation-code-code-1',
          actorId: 'student-1',
          activationCodeId: 'code-1',
          verifiedAmountMinor: 10_000,
          verifiedCurrency: 'EGP',
        },
        manager,
      );
      expect(result).toMatchObject({ id: 'payment-1' });
    });

    it('routes a book code through the same canonical order and finalizer', async () => {
      lookupCode = buildCode({ type: AttendanceCodeType.BOOK, item_id: 'book-1' });
      managerFindOneByEntity.set(BookPurchase, null); // not already owned

      await service.verifyAndRedeem({ code: 'abcd1234' }, 'student-1');

      expect(orders.createActivationCodeOrder).toHaveBeenCalledWith(
        manager,
        lookupCode,
        'student-1',
      );
      expect(finalizer.finalizeSuccessfulPayment).toHaveBeenCalledTimes(1);
    });

    it('refuses to burn the code when the student already owns the item (409)', async () => {
      lookupCode = buildCode();
      managerFindOneByEntity.set(LessonPurchase, {
        id: 'lp-1',
        access_expires_at: new Date(Date.now() + 86_400_000),
      });

      await expect(
        service.verifyAndRedeem({ code: 'abcd1234' }, 'student-1'),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(orders.createActivationCodeOrder).not.toHaveBeenCalled();
      expect(finalizer.finalizeSuccessfulPayment).not.toHaveBeenCalled();
    });

    it('refuses a package code when the package is already purchased', async () => {
      lookupCode = buildCode({ type: AttendanceCodeType.PACKAGE, item_id: 'pkg-1' });
      managerFindOneByEntity.set(PackagePurchase, { id: 'pp-1' });

      await expect(
        service.verifyAndRedeem({ code: 'abcd1234' }, 'student-1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(orders.createActivationCodeOrder).not.toHaveBeenCalled();
    });
  });

  describe('generateCodes — item validation', () => {
    const baseDto = {
      count: 2,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    };

    it('rejects BOOK codes for a nonexistent book', async () => {
      booksRepo.findOne.mockResolvedValue(null);

      await expect(
        service.generateCodes(
          { ...baseDto, type: AttendanceCodeType.BOOK, item_id: 'ghost-book' } as never,
          'admin-1',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(codesRepo.save).not.toHaveBeenCalled();
    });

    it('generates BOOK codes when the book exists', async () => {
      booksRepo.findOne.mockResolvedValue({
        id: 'book-1',
        teacher_id: 'teacher-1',
        price: 100,
      });
      codesRepo.save.mockImplementation((codes: unknown) => Promise.resolve(codes));

      const codes = await service.generateCodes(
        { ...baseDto, type: AttendanceCodeType.BOOK, item_id: 'book-1' } as never,
        'admin-1',
      );

      expect(codes).toHaveLength(2);
      expect(codesRepo.save).toHaveBeenCalled();
    });
  });
});
