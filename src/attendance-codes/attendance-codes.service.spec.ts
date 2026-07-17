import { ConflictException, NotFoundException } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { Book } from '../books/entities/book.entity';
import { BookPurchase } from '../books/entities/book-purchase.entity';
import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonPackage } from '../packages/entities/lesson-package.entity';
import { ItemType, LessonPurchase, PackagePurchase, Payment, PaymentStatus } from '../payments/entities';
import { AttendanceCodesService } from './attendance-codes.service';
import { AttendanceCode, AttendanceCodeStatus, AttendanceCodeType } from './entities';

describe('AttendanceCodesService — redemption correctness', () => {
  let service: AttendanceCodesService;
  let codesRepo: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock };
  let lessonsRepo: { findOne: jest.Mock };
  let packagesRepo: { findOne: jest.Mock };
  let booksRepo: { findOne: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let manager: {
    findOne: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    insert: jest.Mock;
    increment: jest.Mock;
  };

  /** Per-entity responses for manager.findOne, settable per test. */
  let managerFindOneByEntity: Map<unknown, unknown>;

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
      expires_at: new Date(Date.now() + 86_400_000),
      ...over,
    }) as AttendanceCode;

  beforeEach(async () => {
    managerFindOneByEntity = new Map();
    manager = {
      findOne: jest.fn((entity: unknown) =>
        Promise.resolve(managerFindOneByEntity.get(entity) ?? null),
      ),
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendanceCodesService,
        { provide: getRepositoryToken(AttendanceCode), useValue: codesRepo },
        { provide: getRepositoryToken(Lesson), useValue: lessonsRepo },
        { provide: getRepositoryToken(LessonPackage), useValue: packagesRepo },
        { provide: getRepositoryToken(Book), useValue: booksRepo },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get(AttendanceCodesService);
  });

  describe('verifyAndRedeem', () => {
    it('rejects an unknown/used/expired code without side effects', async () => {
      managerFindOneByEntity.set(AttendanceCode, null);

      await expect(
        service.verifyAndRedeem({ code: 'nope' }, 'student-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(manager.save).not.toHaveBeenCalled();
      expect(manager.insert).not.toHaveBeenCalled();
    });

    it('redeems a lesson code: marks used, audits, creates a 0-amount payment, grants access', async () => {
      managerFindOneByEntity.set(AttendanceCode, buildCode());
      managerFindOneByEntity.set(LessonPurchase, null); // not already owned
      managerFindOneByEntity.set(Lesson, { id: 'lesson-1', available_for_days: 7 });

      const payment = await service.verifyAndRedeem({ code: 'abcd1234' }, 'student-1');

      // Code consumed with canonical lifecycle + audit trail.
      const savedCode = manager.save.mock.calls.find((c) => c[0] === AttendanceCode)?.[1] as
        | AttendanceCode
        | undefined;
      expect(savedCode).toMatchObject({
        is_used: true,
        status: AttendanceCodeStatus.REDEEMED,
        used_by: 'student-1',
      });
      expect(manager.insert).toHaveBeenCalled();

      // Free payment ledger entry (idempotent per code+user).
      expect(payment).toMatchObject({
        item_type: ItemType.LESSON,
        final_amount: 0,
        status: PaymentStatus.COMPLETED,
        idempotency_key: 'purchase-code-code-1-student-1',
      });

      // Access artifact + counter.
      const savedPurchase = manager.save.mock.calls.find((c) => c[0] === LessonPurchase)?.[1];
      expect(savedPurchase).toMatchObject({ student_id: 'student-1', lesson_id: 'lesson-1' });
      expect(manager.increment).toHaveBeenCalledWith(Lesson, { id: 'lesson-1' }, 'students_count', 1);
    });

    it('redeems a BOOK code into a BookPurchase (permanent access) + purchase counter', async () => {
      managerFindOneByEntity.set(
        AttendanceCode,
        buildCode({ type: AttendanceCodeType.BOOK, item_id: 'book-1' }),
      );
      managerFindOneByEntity.set(BookPurchase, null); // not already owned

      await service.verifyAndRedeem({ code: 'abcd1234' }, 'student-1');

      const savedBookPurchase = manager.save.mock.calls.find((c) => c[0] === BookPurchase)?.[1];
      expect(savedBookPurchase).toMatchObject({
        student_id: 'student-1',
        book_id: 'book-1',
        price_paid: 0,
      });
      expect(manager.increment).toHaveBeenCalledWith(Book, { id: 'book-1' }, 'purchase_count', 1);
    });

    it('refuses to burn the code when the student already owns the item (409)', async () => {
      managerFindOneByEntity.set(AttendanceCode, buildCode());
      managerFindOneByEntity.set(LessonPurchase, {
        id: 'lp-1',
        access_expires_at: new Date(Date.now() + 86_400_000),
      });

      await expect(
        service.verifyAndRedeem({ code: 'abcd1234' }, 'student-1'),
      ).rejects.toBeInstanceOf(ConflictException);

      // Nothing was consumed or granted.
      expect(manager.save).not.toHaveBeenCalled();
      expect(manager.insert).not.toHaveBeenCalled();
      const paymentSaves = manager.save.mock.calls.filter((c) => c[0] === Payment);
      expect(paymentSaves).toHaveLength(0);
    });

    it('refuses a package code when the package is already purchased', async () => {
      managerFindOneByEntity.set(
        AttendanceCode,
        buildCode({ type: AttendanceCodeType.PACKAGE, item_id: 'pkg-1' }),
      );
      managerFindOneByEntity.set(PackagePurchase, { id: 'pp-1' });

      await expect(
        service.verifyAndRedeem({ code: 'abcd1234' }, 'student-1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(manager.save).not.toHaveBeenCalled();
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
      booksRepo.findOne.mockResolvedValue({ id: 'book-1' });
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
