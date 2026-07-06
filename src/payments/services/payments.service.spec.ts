import { BadRequestException, ConflictException } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { Book } from '../../books/entities/book.entity';
import { BookPurchase } from '../../books/entities/book-purchase.entity';
import { DiscountCodesService } from '../../discount-codes/discount-codes.service';
import { IdempotencyService } from '../../idempotency/idempotency.service';
import { Lesson } from '../../lessons/entities/lesson.entity';
import { LessonPackage } from '../../packages/entities/lesson-package.entity';
import { ItemType, LessonPurchase, PackagePurchase, Payment, PaymentStatus } from '../entities';
import { EasyKashService } from './easykash.service';
import { PaymentsService } from './payments.service';

describe('PaymentsService — financial correctness', () => {
  let service: PaymentsService;
  let paymentsRepo: { update: jest.Mock };
  let lessonsRepo: { findOne: jest.Mock };
  let lessonPurchasesRepo: { findOne: jest.Mock };
  let idempotency: { checkPaymentRequest: jest.Mock; storePaymentResult: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let manager: {
    findOne: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    increment: jest.Mock;
    update: jest.Mock;
  };

  beforeEach(async () => {
    manager = {
      findOne: jest.fn(),
      save: jest.fn((_entity: unknown, obj: unknown) => Promise.resolve(obj)),
      create: jest.fn((_entity: unknown, obj: unknown) => obj),
      increment: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    dataSource = {
      // Mirror retryTransaction's call: dataSource.transaction(fn).
      transaction: jest.fn((a: unknown, b: unknown) => {
        const fn = (typeof a === 'function' ? a : b) as (m: unknown) => unknown;
        return fn(manager);
      }),
    };
    paymentsRepo = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
    lessonsRepo = { findOne: jest.fn() };
    lessonPurchasesRepo = { findOne: jest.fn() };
    idempotency = {
      checkPaymentRequest: jest.fn().mockResolvedValue({ isProcessed: false }),
      storePaymentResult: jest.fn().mockResolvedValue(undefined),
    };

    const noopRepo = {};
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: getRepositoryToken(Payment), useValue: paymentsRepo },
        { provide: getRepositoryToken(LessonPurchase), useValue: lessonPurchasesRepo },
        { provide: getRepositoryToken(PackagePurchase), useValue: noopRepo },
        { provide: getRepositoryToken(Lesson), useValue: lessonsRepo },
        { provide: getRepositoryToken(LessonPackage), useValue: noopRepo },
        { provide: getRepositoryToken(Book), useValue: noopRepo },
        { provide: getRepositoryToken(BookPurchase), useValue: noopRepo },
        { provide: DataSource, useValue: dataSource },
        { provide: EasyKashService, useValue: {} },
        { provide: IdempotencyService, useValue: idempotency },
        { provide: DiscountCodesService, useValue: {} },
      ],
    }).compile();

    service = module.get(PaymentsService);
  });

  const buildPayment = (over: Partial<Payment> = {}): Payment =>
    ({
      id: 'pay-1',
      user_id: 'user-1',
      item_type: ItemType.LESSON,
      item_id: 'lesson-1',
      final_amount: '100.00',
      status: PaymentStatus.PROCESSING,
      ...over,
    }) as unknown as Payment;

  describe('processSuccessfulPayment — amount/currency verification', () => {
    it('rejects an underpayment (captured < expected) and grants nothing', async () => {
      manager.findOne.mockResolvedValue(buildPayment());

      await expect(
        service.processSuccessfulPayment('pay-1', {
          amountCents: 5000, // expected 10000
          currency: 'EGP',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      // Never completed, never granted access.
      expect(manager.save).not.toHaveBeenCalled();
      expect(manager.increment).not.toHaveBeenCalled();
    });

    it('rejects a currency mismatch', async () => {
      manager.findOne.mockResolvedValue(buildPayment());

      await expect(
        service.processSuccessfulPayment('pay-1', {
          amountCents: 10000,
          currency: 'USD',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('completes and grants access when amount + currency match', async () => {
      manager.findOne.mockImplementation((entity: unknown) => {
        if (entity === Payment) return Promise.resolve(buildPayment());
        if (entity === Lesson) return Promise.resolve({ id: 'lesson-1', available_for_days: 7 });
        return Promise.resolve(null);
      });

      await service.processSuccessfulPayment('pay-1', {
        amountCents: 10000,
        currency: 'EGP',
        transactionId: 'txn-9',
      });

      // Payment saved as COMPLETED with the gateway transaction id persisted.
      const savedPayment = manager.save.mock.calls.find(
        (c) => (c[1] as Payment).id === 'pay-1',
      )?.[1] as Payment;
      expect(savedPayment.status).toBe(PaymentStatus.COMPLETED);
      expect(savedPayment.paymob_transaction_id).toBe('txn-9');
      // Access granted (LessonPurchase created + students_count incremented).
      expect(manager.increment).toHaveBeenCalled();
    });

    it('is idempotent — already COMPLETED skips without re-granting', async () => {
      manager.findOne.mockResolvedValue(buildPayment({ status: PaymentStatus.COMPLETED }));

      await service.processSuccessfulPayment('pay-1', {
        amountCents: 10000,
        currency: 'EGP',
      });

      expect(manager.save).not.toHaveBeenCalled();
      expect(manager.increment).not.toHaveBeenCalled();
    });

    it('refuses to complete a REFUNDED payment (no resurrection)', async () => {
      manager.findOne.mockResolvedValue(buildPayment({ status: PaymentStatus.REFUNDED }));

      await service.processSuccessfulPayment('pay-1', {
        amountCents: 10000,
        currency: 'EGP',
      });

      expect(manager.save).not.toHaveBeenCalled();
    });
  });

  describe('processFailedPayment — terminal-state guard', () => {
    it('only transitions open (pending/processing) payments to FAILED', async () => {
      await service.processFailedPayment('pay-1', 'declined', {
        amountCents: 0,
        currency: 'EGP',
        transactionId: 'txn-1',
      });

      const [where, patch] = paymentsRepo.update.mock.calls[0] as [
        Record<string, unknown>,
        Record<string, unknown>,
      ];
      expect(where).toMatchObject({ id: 'pay-1' });
      // The where-clause restricts to the open states via an In(...) filter.
      expect(where['status']).toBeDefined();
      expect(patch).toMatchObject({ status: PaymentStatus.FAILED });
    });

    it('does not error when nothing was updated (already terminal)', async () => {
      paymentsRepo.update.mockResolvedValue({ affected: 0 });
      await expect(service.processFailedPayment('pay-1', 'late failure')).resolves.toBeUndefined();
    });
  });

  describe('processRefundedPayment', () => {
    it('marks the payment REFUNDED via a guarded update', async () => {
      await service.processRefundedPayment('pay-1', {
        amountCents: 10000,
        currency: 'EGP',
        transactionId: 'txn-refund',
      });

      const [where, patch] = paymentsRepo.update.mock.calls[0] as [
        Record<string, unknown>,
        Record<string, unknown>,
      ];
      expect(where).toMatchObject({ id: 'pay-1' });
      expect(patch).toMatchObject({
        status: PaymentStatus.REFUNDED,
        paymob_transaction_id: 'txn-refund',
      });
    });
  });

  describe('purchaseLesson — concurrent double-charge guard', () => {
    const dto = {
      lesson_id: 'lesson-1',
      billing_data: {},
    } as unknown as Parameters<PaymentsService['purchaseLesson']>[0];

    beforeEach(() => {
      lessonsRepo.findOne.mockResolvedValue({ id: 'lesson-1', price: 100 });
      // checkLessonAccess -> no active purchase.
      lessonPurchasesRepo.findOne.mockResolvedValue(null);
    });

    it('rejects (409) when a fresh in-flight payment already exists', async () => {
      // The open-payment reservation query finds a recent PROCESSING payment.
      manager.findOne.mockResolvedValue({
        id: 'open-1',
        status: PaymentStatus.PROCESSING,
        created_at: new Date(), // fresh -> blocks
      });

      await expect(service.purchaseLesson(dto, 'user-1')).rejects.toBeInstanceOf(ConflictException);
      // Never created a new payment / gateway order.
      expect(manager.create).not.toHaveBeenCalled();
    });

    it('expires a stale in-flight payment instead of blocking', async () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      manager.findOne.mockResolvedValue({
        id: 'stale-1',
        status: PaymentStatus.PENDING,
        created_at: twoHoursAgo,
      });
      // After freeing the slot, creation proceeds; short-circuit the rest by
      // throwing from create so we only assert the stale-expiry happened.
      manager.create.mockImplementation(() => {
        throw new Error('stop-after-reservation');
      });

      await expect(service.purchaseLesson(dto, 'user-1')).rejects.toThrow('stop-after-reservation');
      // The stale payment was expired (guarded update) to free the unique slot.
      expect(manager.update).toHaveBeenCalledWith(
        Payment,
        expect.objectContaining({ id: 'stale-1' }),
        expect.objectContaining({ status: PaymentStatus.EXPIRED }),
      );
    });

    it('translates the DB unique-index race violation into a 409', async () => {
      manager.findOne.mockResolvedValue(null); // reservation sees no open payment
      // Simulate the partial-unique-index violation on concurrent insert.
      dataSource.transaction.mockRejectedValue({
        code: '23505',
        constraint: 'UQ_payments_open_per_user_item',
      });

      await expect(service.purchaseLesson(dto, 'user-1')).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
