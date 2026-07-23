import { BadRequestException, ConflictException } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { DiscountCodesService } from '../../discount-codes/discount-codes.service';
import { StorageService } from '../../storage/storage.service';
import {
  ManualPaymentMethod,
  ManualPaymentSubmission,
  ManualPaymentSubmissionStatus,
  Order,
  OrderStatus,
} from '../entities';
import { ManualPaymentsService } from './manual-payments.service';
import { PaymentFinalizationService } from './payment-finalization.service';

describe('ManualPaymentsService — approval invariants', () => {
  let service: ManualPaymentsService;
  let finalizer: { finalizeSuccessfulPayment: jest.Mock };
  let submission: ManualPaymentSubmission;
  let order: Order;
  let manager: {
    findOne: jest.Mock;
    save: jest.Mock;
    insert: jest.Mock;
    getRepository: jest.Mock;
  };

  beforeEach(async () => {
    submission = {
      id: 'submission-1',
      order_id: 'order-1',
      student_id: 'student-1',
      manual_payment_method_id: 'method-1',
      claimed_amount_minor: 10_000,
      currency: 'EGP',
      transaction_reference: 'TRANSFER-1',
      status: ManualPaymentSubmissionStatus.SUBMITTED,
    } as ManualPaymentSubmission;
    order = {
      id: 'order-1',
      payment_id: 'payment-1',
      final_amount_minor: 10_000,
      currency: 'EGP',
      status: OrderStatus.PAYMENT_SUBMITTED,
      expires_at: new Date(Date.now() + 60_000),
    } as Order;
    const referenceQuery = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getExists: jest.fn().mockResolvedValue(false),
    };
    manager = {
      findOne: jest.fn((entity: unknown) => {
        if (entity === ManualPaymentSubmission) return Promise.resolve(submission);
        if (entity === Order) return Promise.resolve(order);
        return Promise.resolve(null);
      }),
      save: jest.fn((_entity: unknown, value: unknown) => Promise.resolve(value)),
      insert: jest.fn().mockResolvedValue(undefined),
      getRepository: jest.fn(() => ({
        createQueryBuilder: jest.fn(() => referenceQuery),
      })),
    };
    const dataSource = {
      transaction: jest.fn((a: unknown, b: unknown) => {
        const fn = (typeof a === 'function' ? a : b) as (m: typeof manager) => unknown;
        return fn(manager);
      }),
    };
    finalizer = { finalizeSuccessfulPayment: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ManualPaymentsService,
        { provide: getRepositoryToken(ManualPaymentMethod), useValue: {} },
        { provide: getRepositoryToken(ManualPaymentSubmission), useValue: {} },
        { provide: getRepositoryToken(Order), useValue: {} },
        { provide: DataSource, useValue: dataSource },
        { provide: StorageService, useValue: {} },
        { provide: PaymentFinalizationService, useValue: finalizer },
        {
          provide: DiscountCodesService,
          useValue: { releaseUsageForPayment: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(ManualPaymentsService);
  });

  it('approves only by invoking the shared finalizer inside the locked transaction', async () => {
    const result = await service.approve(
      'submission-1',
      { reviewer_note: 'Verified against bank statement' },
      'admin-1',
    );

    expect(manager.findOne).toHaveBeenCalledWith(
      ManualPaymentSubmission,
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
    expect(manager.findOne).toHaveBeenCalledWith(
      Order,
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
    expect(finalizer.finalizeSuccessfulPayment).toHaveBeenCalledWith(
      {
        orderId: 'order-1',
        paymentId: 'payment-1',
        sourceReference: 'TRANSFER-1',
        actorId: 'admin-1',
        manualSubmissionId: 'submission-1',
        verifiedAmountMinor: 10_000,
        verifiedCurrency: 'EGP',
      },
      manager,
    );
    expect(result.status).toBe(ManualPaymentSubmissionStatus.UNDER_REVIEW);
  });

  it('requires an audited reason before approving an expired order', async () => {
    order.expires_at = new Date(Date.now() - 60_000);

    await expect(service.approve('submission-1', {}, 'admin-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(finalizer.finalizeSuccessfulPayment).not.toHaveBeenCalled();
  });

  it('fails closed on amount mismatch', async () => {
    submission.claimed_amount_minor = 9_999;

    await expect(service.approve('submission-1', {}, 'admin-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(finalizer.finalizeSuccessfulPayment).not.toHaveBeenCalled();
  });

  it('rejects a second approval after the submission becomes terminal', async () => {
    submission.status = ManualPaymentSubmissionStatus.APPROVED;

    await expect(service.approve('submission-1', {}, 'admin-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(finalizer.finalizeSuccessfulPayment).not.toHaveBeenCalled();
  });
});
