import { BadRequestException } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { DiscountCodesService } from '../../discount-codes/discount-codes.service';
import { IdempotencyService } from '../../idempotency/idempotency.service';
import { Lesson } from '../../lessons/entities/lesson.entity';
import { LessonPackage } from '../../packages/entities/lesson-package.entity';
import { ItemType, LessonPurchase, PackagePurchase, Payment, PaymentStatus } from '../entities';
import { PaymentsService } from './payments.service';
import { PaymobService } from './paymob.service';

describe('PaymentsService — financial correctness', () => {
  let service: PaymentsService;
  let paymentsRepo: { update: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let manager: {
    findOne: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    increment: jest.Mock;
  };

  beforeEach(async () => {
    manager = {
      findOne: jest.fn(),
      save: jest.fn((_entity: unknown, obj: unknown) => Promise.resolve(obj)),
      create: jest.fn((_entity: unknown, obj: unknown) => obj),
      increment: jest.fn().mockResolvedValue(undefined),
    };
    dataSource = {
      // Mirror retryTransaction's call: dataSource.transaction(fn).
      transaction: jest.fn((a: unknown, b: unknown) => {
        const fn = (typeof a === 'function' ? a : b) as (m: unknown) => unknown;
        return fn(manager);
      }),
    };
    paymentsRepo = { update: jest.fn().mockResolvedValue({ affected: 1 }) };

    const noopRepo = {};
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: getRepositoryToken(Payment), useValue: paymentsRepo },
        { provide: getRepositoryToken(LessonPurchase), useValue: noopRepo },
        { provide: getRepositoryToken(PackagePurchase), useValue: noopRepo },
        { provide: getRepositoryToken(Lesson), useValue: noopRepo },
        { provide: getRepositoryToken(LessonPackage), useValue: noopRepo },
        { provide: DataSource, useValue: dataSource },
        { provide: PaymobService, useValue: {} },
        { provide: IdempotencyService, useValue: {} },
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
});
