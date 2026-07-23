import { NotFoundException } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { DiscountCodesService } from '../../discount-codes/discount-codes.service';
import {
  ItemType,
  LessonPurchase,
  Order,
  OrderStatus,
  PackagePurchase,
  Payment,
  PaymentStatus,
} from '../entities';
import { EntitlementsService } from './entitlements.service';
import { OrdersService } from './orders.service';
import { PaymentFinalizationService } from './payment-finalization.service';
import { PaymentsService } from './payments.service';
import { RefundsService } from './refunds.service';

describe('PaymentsService — canonical compatibility routes', () => {
  let service: PaymentsService;
  let payments: { findOne: jest.Mock };
  let orders: {
    createOrder: jest.Mock;
    startGatewayCheckout: jest.Mock;
    createReopenOrder: jest.Mock;
  };
  let finalizer: { finalizeSuccessfulPayment: jest.Mock };
  let refunds: { completeProviderNotification: jest.Mock };
  let discounts: { releaseUsageForPayment: jest.Mock };
  let manager: {
    findOne: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
  };

  const payment = (over: Partial<Payment> = {}): Payment =>
    ({
      id: 'payment-1',
      order_id: 'order-1',
      user_id: 'student-1',
      item_type: ItemType.LESSON,
      item_id: 'lesson-1',
      status: PaymentStatus.PROCESSING,
      provider_reference: 'provider-1',
      amount_minor: 10_000,
      currency: 'EGP',
      ...over,
    }) as Payment;

  beforeEach(async () => {
    payments = { findOne: jest.fn() };
    orders = {
      createOrder: jest.fn(),
      startGatewayCheckout: jest.fn(),
      createReopenOrder: jest.fn(),
    };
    finalizer = { finalizeSuccessfulPayment: jest.fn().mockResolvedValue(undefined) };
    refunds = { completeProviderNotification: jest.fn().mockResolvedValue(undefined) };
    discounts = { releaseUsageForPayment: jest.fn().mockResolvedValue(undefined) };
    manager = {
      findOne: jest.fn(),
      save: jest.fn((_entity: unknown, value: unknown) => Promise.resolve(value)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const dataSource = {
      transaction: jest.fn((a: unknown, b: unknown) => {
        const fn = (typeof a === 'function' ? a : b) as (m: typeof manager) => unknown;
        return fn(manager);
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: getRepositoryToken(Payment), useValue: payments },
        { provide: getRepositoryToken(LessonPurchase), useValue: {} },
        { provide: getRepositoryToken(PackagePurchase), useValue: {} },
        { provide: DataSource, useValue: dataSource },
        { provide: DiscountCodesService, useValue: discounts },
        { provide: OrdersService, useValue: orders },
        { provide: PaymentFinalizationService, useValue: finalizer },
        {
          provide: EntitlementsService,
          useValue: { getActive: jest.fn().mockResolvedValue(null) },
        },
        { provide: RefundsService, useValue: refunds },
      ],
    }).compile();

    service = module.get(PaymentsService);
  });

  it('routes the legacy lesson checkout endpoint through a canonical order', async () => {
    orders.createOrder.mockResolvedValue({
      order: {
        id: 'order-1',
        original_amount_minor: 10_000,
        discount_amount_minor: 1_000,
        final_amount_minor: 9_000,
      },
    });
    orders.startGatewayCheckout.mockResolvedValue({
      payment_id: 'payment-1',
      redirect_url: 'https://gateway.example/checkout',
    });

    const result = await service.purchaseLesson(
      {
        lesson_id: 'lesson-1',
        discount_code: 'SAVE10',
        idempotency_key: 'request-1',
        billing_data: {},
      } as never,
      'student-1',
    );

    expect(orders.createOrder).toHaveBeenCalledWith(
      {
        item_type: ItemType.LESSON,
        item_id: 'lesson-1',
        payment_channel: 'gateway',
        discount_code: 'SAVE10',
        idempotency_key: 'request-1',
      },
      'student-1',
    );
    expect(orders.startGatewayCheckout).toHaveBeenCalledWith('order-1', 'student-1', {
      billing_data: {},
    });
    expect(result).toMatchObject({
      payment_id: 'payment-1',
      final_amount: 90,
      iframe_url: 'https://gateway.example/checkout',
    });
  });

  it('delegates verified success exclusively to the shared finalizer', async () => {
    payments.findOne.mockResolvedValue(payment());

    await service.processSuccessfulPayment('payment-1', {
      amountCents: 10_000,
      currency: 'EGP',
      transactionId: 'transaction-1',
    });

    expect(finalizer.finalizeSuccessfulPayment).toHaveBeenCalledWith({
      orderId: 'order-1',
      paymentId: 'payment-1',
      sourceReference: 'transaction-1',
      actorId: null,
      verifiedAmountMinor: 10_000,
      verifiedCurrency: 'EGP',
    });
  });

  it('fails closed when a payment has no canonical order', async () => {
    payments.findOne.mockResolvedValue(payment({ order_id: null }));

    await expect(service.processSuccessfulPayment('payment-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(finalizer.finalizeSuccessfulPayment).not.toHaveBeenCalled();
  });

  it('delegates provider refunds to the canonical refund workflow', async () => {
    payments.findOne.mockResolvedValue(payment());

    await service.processRefundedPayment('payment-1', {
      amountCents: 10_000,
      currency: 'EGP',
      transactionId: 'refund-1',
    });

    expect(refunds.completeProviderNotification).toHaveBeenCalledWith(
      'payment-1',
      'refund-1',
      10_000,
      'EGP',
    );
  });

  it('closes the active order and releases discounts after a verified failure', async () => {
    manager.findOne.mockResolvedValue(payment());

    await service.processFailedPayment('payment-1', 'declined', {
      amountCents: 0,
      currency: 'EGP',
      transactionId: 'failure-1',
    });

    expect(manager.save).toHaveBeenCalledWith(
      Payment,
      expect.objectContaining({
        status: PaymentStatus.FAILED,
        failure_reason: 'declined',
        paymob_transaction_id: 'failure-1',
      }),
    );
    expect(manager.update).toHaveBeenCalledWith(Order, expect.objectContaining({ id: 'order-1' }), {
      status: OrderStatus.REJECTED,
    });
    expect(discounts.releaseUsageForPayment).toHaveBeenCalledWith('payment-1', manager);
  });

  it('ignores a late failure after completion', async () => {
    manager.findOne.mockResolvedValue(payment({ status: PaymentStatus.COMPLETED }));

    await service.processFailedPayment('payment-1', 'late failure');

    expect(manager.save).not.toHaveBeenCalled();
    expect(manager.update).not.toHaveBeenCalled();
    expect(discounts.releaseUsageForPayment).not.toHaveBeenCalled();
  });
});
