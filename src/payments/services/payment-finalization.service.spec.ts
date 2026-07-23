import { ConfigService } from '@nestjs/config';
import { UnprocessableEntityException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { Lesson } from '../../lessons/entities/lesson.entity';
import { Notification } from '../../notifications/entities/notification.entity';
import {
  CollectionParty,
  Entitlement,
  FinancialLedgerEntry,
  ItemType,
  LedgerDirection,
  LessonPurchase,
  Order,
  OrderStatus,
  Payment,
  PaymentAuditLog,
  PaymentChannel,
  PaymentDomainEvent,
  PaymentMethod,
  PaymentStatus,
} from '../entities';
import { PaymentFinalizationService } from './payment-finalization.service';

describe('PaymentFinalizationService', () => {
  const order = {
    id: 'order-1',
    order_number: 'LX-1',
    student_id: 'student-1',
    teacher_id: 'teacher-1',
    item_type: ItemType.LESSON,
    item_id: 'lesson-1',
    final_amount_minor: 10_000,
    currency: 'EGP',
    payment_channel: PaymentChannel.GATEWAY,
    collection_party: CollectionParty.PLATFORM,
    platform_commission_minor: 3_000,
    teacher_earning_minor: 7_000,
    product_title_snapshot: 'Lesson',
    status: OrderStatus.AWAITING_PAYMENT,
    payment_id: 'payment-1',
    activation_code_id: null,
    metadata: { access_duration_days: 7 },
  } as Order;
  const payment = {
    id: 'payment-1',
    order_id: 'order-1',
    user_id: 'student-1',
    item_type: ItemType.LESSON,
    item_id: 'lesson-1',
    amount_minor: 10_000,
    currency: 'EGP',
    payment_method: PaymentMethod.CARD,
    status: PaymentStatus.PROCESSING,
  } as Payment;

  let entitlement: Entitlement | null;
  let inserted: Array<{ target: unknown; value: Record<string, unknown> }>;
  let savedCompatibilityPurchases: unknown[];
  let manager: EntityManager;
  let service: PaymentFinalizationService;

  beforeEach(() => {
    Object.assign(order, {
      status: OrderStatus.AWAITING_PAYMENT,
      paid_at: null,
    });
    Object.assign(payment, {
      status: PaymentStatus.PROCESSING,
      completed_at: null,
    });
    entitlement = null;
    inserted = [];
    savedCompatibilityPurchases = [];

    const managerShape = {
      findOne: jest.fn((entity: unknown) => {
        if (entity === Order) return Promise.resolve(order);
        if (entity === Payment) return Promise.resolve(payment);
        if (entity === Entitlement) return Promise.resolve(entitlement);
        if (entity === Lesson) {
          return Promise.resolve({ id: 'lesson-1', available_for_days: 7 });
        }
        return Promise.resolve(null);
      }),
      create: jest.fn((_entity: unknown, value: unknown) => value),
      save: jest.fn((entity: unknown, value: unknown) => {
        if (entity === Entitlement) {
          entitlement = { id: 'entitlement-1', ...(value as object) } as Entitlement;
          return Promise.resolve(entitlement);
        }
        return Promise.resolve(value);
      }),
      insert: jest.fn((entity: unknown, value: unknown) => {
        if (entity === LessonPurchase) savedCompatibilityPurchases.push(value);
        inserted.push({
          target: entity,
          value: value as Record<string, unknown>,
        });
        return Promise.resolve({ identifiers: [] });
      }),
      increment: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(() => {
        let target: unknown;
        let value: Record<string, unknown>;
        const chain = {
          insert: jest.fn(() => chain),
          into: jest.fn((next: unknown) => {
            target = next;
            return chain;
          }),
          values: jest.fn((next: Record<string, unknown>) => {
            value = next;
            return chain;
          }),
          orIgnore: jest.fn(() => chain),
          execute: jest.fn(() => {
            inserted.push({ target, value });
            return Promise.resolve({ identifiers: [] });
          }),
        };
        return chain;
      }),
    };
    manager = managerShape as unknown as EntityManager;
    service = new PaymentFinalizationService(
      { manager } as DataSource,
      { get: jest.fn().mockReturnValue('7') } as unknown as ConfigService,
    );
  });

  it('atomically finalizes once, balances the ledger, and deduplicates repeat delivery', async () => {
    const input = {
      orderId: order.id,
      paymentId: payment.id,
      sourceReference: 'gateway-1',
      verifiedAmountMinor: 10_000,
      verifiedCurrency: 'EGP',
    };

    await expect(service.finalizeSuccessfulPayment(input, manager)).resolves.toMatchObject({
      alreadyFinalized: false,
    });
    await expect(service.finalizeSuccessfulPayment(input, manager)).resolves.toMatchObject({
      alreadyFinalized: true,
    });

    expect(order.status).toBe(OrderStatus.PAID);
    expect(payment.status).toBe(PaymentStatus.COMPLETED);
    expect(savedCompatibilityPurchases).toHaveLength(1);

    const ledger = inserted
      .filter((row) => row.target === FinancialLedgerEntry)
      .map((row) => row.value);
    const debits = ledger
      .filter((row) => row.direction === LedgerDirection.DEBIT)
      .reduce((sum, row) => sum + Number(row.amount_minor), 0);
    const credits = ledger
      .filter((row) => row.direction === LedgerDirection.CREDIT)
      .reduce((sum, row) => sum + Number(row.amount_minor), 0);
    expect(ledger).toHaveLength(3);
    expect(debits).toBe(10_000);
    expect(credits).toBe(10_000);
    expect(inserted.filter((row) => row.target === Notification)).toHaveLength(2);
    expect(inserted.filter((row) => row.target === PaymentDomainEvent)).toHaveLength(3);
    expect(inserted.filter((row) => row.target === PaymentAuditLog)).toHaveLength(1);
  });

  it('fails closed on an amount mismatch without granting access or posting ledger', async () => {
    await expect(
      service.finalizeSuccessfulPayment(
        {
          orderId: order.id,
          paymentId: payment.id,
          sourceReference: 'gateway-1',
          verifiedAmountMinor: 9_999,
          verifiedCurrency: 'EGP',
        },
        manager,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);

    expect(entitlement).toBeNull();
    expect(inserted.filter((row) => row.target === FinancialLedgerEntry)).toHaveLength(0);
    expect(savedCompatibilityPurchases).toHaveLength(0);
  });
});
