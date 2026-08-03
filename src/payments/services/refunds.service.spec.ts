import { BadRequestException } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { Order, OrderStatus, Payment, Refund, RefundAttempt, RefundStatus } from '../entities';
import { PaymentProviderRegistry } from './payment-provider-registry.service';
import { RefundsService } from './refunds.service';

describe('RefundsService — financial validation', () => {
  let service: RefundsService;
  let refunds: { findOne: jest.Mock };
  let orders: { findOne: jest.Mock };
  let payments: { findOne: jest.Mock };
  let manager: {
    findOne: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    insert: jest.Mock;
    query: jest.Mock;
    createQueryBuilder: jest.Mock;
  };

  const paidOrder = (over: Partial<Order> = {}): Order =>
    ({
      id: 'order-1',
      status: OrderStatus.PAID,
      final_amount_minor: 10_000,
      refunded_amount_minor: 0,
      currency: 'EGP',
      payment_id: 'payment-1',
      payment_channel: 'gateway',
      student_id: 'student-1',
      ...over,
    }) as Order;

  beforeEach(async () => {
    refunds = { findOne: jest.fn().mockResolvedValue(null) };
    orders = { findOne: jest.fn() };
    payments = { findOne: jest.fn() };
    const insertQuery = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orIgnore: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue(undefined),
    };
    manager = {
      findOne: jest.fn(),
      save: jest.fn((_entity: unknown, value: unknown) =>
        Promise.resolve({ id: 'refund-1', ...(value as object) }),
      ),
      create: jest.fn((_entity: unknown, value: unknown) => value),
      insert: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(() => insertQuery),
    };
    const dataSource = {
      transaction: jest.fn((a: unknown, b: unknown) => {
        const fn = (typeof a === 'function' ? a : b) as (m: typeof manager) => unknown;
        return fn(manager);
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RefundsService,
        { provide: getRepositoryToken(Refund), useValue: refunds },
        { provide: getRepositoryToken(RefundAttempt), useValue: { update: jest.fn() } },
        { provide: getRepositoryToken(Order), useValue: orders },
        { provide: getRepositoryToken(Payment), useValue: payments },
        { provide: DataSource, useValue: dataSource },
        { provide: PaymentProviderRegistry, useValue: {} },
      ],
    }).compile();

    service = module.get(RefundsService);
  });

  it('creates a partial refund while recording the retained-entitlement policy', async () => {
    manager.findOne.mockImplementation((entity: unknown) => {
      if (entity === Order) return Promise.resolve(paidOrder());
      return Promise.resolve(null);
    });

    await expect(
      service.request(
        {
          order_id: 'order-1',
          amount_minor: 5_000,
          reason_code: 'customer_request',
        },
        'admin-1',
      ),
    ).resolves.toMatchObject({
      amount_minor: 5_000,
      metadata: { entitlement_policy: 'retain_on_partial_refund' },
    });
    expect(manager.save).toHaveBeenCalled();
  });

  it('creates a full-value refund request with an immutable amount snapshot', async () => {
    manager.findOne.mockImplementation((entity: unknown) => {
      if (entity === Order) return Promise.resolve(paidOrder());
      if (entity === Refund) return Promise.resolve(null);
      return Promise.resolve(null);
    });

    const result = await service.request(
      {
        order_id: 'order-1',
        amount_minor: 10_000,
        reason_code: 'customer_request',
      },
      'admin-1',
    );

    expect(result).toMatchObject({
      order_id: 'order-1',
      amount_minor: 10_000,
      currency: 'EGP',
      status: RefundStatus.REQUESTED,
    });
  });

  it('rejects a provider refund whose amount or currency differs from the paid order', async () => {
    manager.findOne.mockImplementation((entity: unknown) => {
      if (entity === Payment)
        return Promise.resolve({
          id: 'payment-1',
          order_id: 'order-1',
          provider: 'configured-gateway',
        } as Payment);
      if (entity === Order) return Promise.resolve(paidOrder());
      return Promise.resolve(null);
    });

    await expect(
      service.completeProviderNotification('payment-1', 'provider-refund-1', 10_001, 'EGP'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(manager.findOne).toHaveBeenCalled();
  });
});
