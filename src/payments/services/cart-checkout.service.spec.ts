import { DataSource, EntityManager } from 'typeorm';
import { ConflictException } from '@nestjs/common';

import { Cart } from '../../cart/entities/cart.entity';
import { CartItem, CartItemType } from '../../cart/entities/cart-item.entity';
import {
  CartCheckout,
  CartCheckoutStatus,
  ItemType,
  Order,
  OrderStatus,
  Payment,
  PaymentMethod,
  PaymentStatus,
} from '../entities';
import { CartCheckoutService } from './cart-checkout.service';

describe('CartCheckoutService', () => {
  const checkoutDto = {
    payment_method: PaymentMethod.CARD,
    billing_data: {
      first_name: 'Ahmed',
      last_name: 'Ali',
      email: 'ahmed@example.test',
      phone_number: '01012345678',
      city: 'Cairo',
      state: 'Cairo',
      country: 'EG' as const,
    },
    discount_code: 'SAVE10',
    idempotency_key: 'cart-retry-key',
  };

  function fixture() {
    const records = {
      cart: {
        id: 'cart-1',
        user_id: 'student-1',
        discount_code: null,
        discount_amount: 0,
      } as Cart,
      cartItems: [
        {
          id: 'cart-item-lesson',
          cart_id: 'cart-1',
          item_type: CartItemType.LESSON,
          item_id: 'lesson-1',
          price: 1,
          created_at: new Date('2026-01-01T00:00:00.000Z'),
        },
        {
          id: 'cart-item-package',
          cart_id: 'cart-1',
          item_type: CartItemType.PACKAGE,
          item_id: 'package-1',
          price: 2,
          created_at: new Date('2026-01-02T00:00:00.000Z'),
        },
      ] as CartItem[],
      checkouts: [] as CartCheckout[],
      payments: [] as Payment[],
      orders: [] as Order[],
      deletedCartItems: [] as unknown[],
      updates: [] as unknown[],
      audits: [] as unknown[],
    };
    let id = 0;
    const match = <T extends Record<string, unknown>>(value: T, where: Record<string, unknown>) =>
      Object.entries(where).every(([key, expected]) => value[key] === expected);
    const manager = {
      create: jest.fn((_entity: unknown, value: unknown) => value),
      findOne: jest.fn((entity: unknown, options: { where: Record<string, unknown> }) => {
        const where = options.where;
        if (entity === Cart)
          return Promise.resolve(match(records.cart as never, where) ? records.cart : null);
        if (entity === CartCheckout)
          return Promise.resolve(
            records.checkouts.find((item) => match(item as never, where)) ?? null,
          );
        if (entity === Payment)
          return Promise.resolve(
            records.payments.find((item) => match(item as never, where)) ?? null,
          );
        if (entity === Order)
          return Promise.resolve(
            records.orders.find((item) => match(item as never, where)) ?? null,
          );
        return Promise.resolve(null);
      }),
      find: jest.fn((entity: unknown, options: { where: Record<string, unknown> }) => {
        const where = options.where;
        if (entity === CartItem)
          return Promise.resolve(records.cartItems.filter((item) => match(item as never, where)));
        if (entity === Order)
          return Promise.resolve(records.orders.filter((item) => match(item as never, where)));
        return Promise.resolve([]);
      }),
      save: jest.fn((entity: unknown, value: Record<string, unknown>) => {
        if (entity === CartCheckout) {
          if (!value.id) value.id = `checkout-${++id}`;
          if (!records.checkouts.includes(value as CartCheckout))
            records.checkouts.push(value as CartCheckout);
        }
        if (entity === Payment) {
          if (!value.id) value.id = `payment-${++id}`;
          if (!records.payments.includes(value as Payment)) records.payments.push(value as Payment);
        }
        if (entity === Order) {
          if (!value.id) value.id = `order-${++id}`;
          if (!records.orders.includes(value as Order)) records.orders.push(value as Order);
        }
        return Promise.resolve(value);
      }),
      delete: jest.fn((entity: unknown, criteria: unknown) => {
        records.deletedCartItems.push({ entity, criteria });
        return Promise.resolve({ affected: 2 });
      }),
      update: jest.fn((_entity: unknown, criteria: unknown, value: unknown) => {
        records.updates.push({ criteria, value });
        return Promise.resolve({ affected: 1 });
      }),
      insert: jest.fn((_entity: unknown, value: unknown) => {
        records.audits.push(value);
        return Promise.resolve({ identifiers: [] });
      }),
      createQueryBuilder: jest.fn(() => {
        const chain = {
          insert: jest.fn(() => chain),
          into: jest.fn(() => chain),
          values: jest.fn(() => chain),
          orIgnore: jest.fn(() => chain),
          execute: jest.fn().mockResolvedValue({ identifiers: [] }),
        };
        return chain;
      }),
    };
    const dataSource = {
      transaction: jest.fn((work: (tx: EntityManager) => unknown) => work(manager as never)),
    };
    const products = [
      {
        cartItemId: 'cart-item-lesson',
        itemType: ItemType.LESSON,
        itemId: 'lesson-1',
        title: 'Current lesson title',
        titleAr: null,
        teacherId: 'teacher-1',
        sellerName: 'Teacher One',
        priceMinor: 10_000,
        accessDurationDays: 7,
      },
      {
        cartItemId: 'cart-item-package',
        itemType: ItemType.PACKAGE,
        itemId: 'package-1',
        title: 'Current package title',
        titleAr: null,
        teacherId: 'teacher-2',
        sellerName: 'Teacher Two',
        priceMinor: 20_000,
        accessDurationDays: null,
      },
    ];
    const orders = { prepareCartProducts: jest.fn().mockResolvedValue(products) };
    const discounts = {
      quoteCartDiscount: jest.fn().mockResolvedValue({
        discount_code_id: 'discount-1',
        discount_amount_minor: 3_000,
        applicable_subtotal_minor: 30_000,
        allocations_minor: { 'cart-item-lesson': 1_000, 'cart-item-package': 2_000 },
        snapshot: { code: 'SAVE10' },
      }),
      applyDiscount: jest.fn().mockResolvedValue(undefined),
      releaseUsageForPayment: jest.fn().mockResolvedValue(undefined),
    };
    const provider = {
      name: 'easykash',
      createCheckoutOrder: jest.fn().mockResolvedValue('gateway-order-1'),
      createCheckoutSession: jest
        .fn()
        .mockResolvedValue({ redirectUrl: 'https://gateway.test/pay' }),
    };
    const finalizer = {
      finalizeSuccessfulPayment: jest.fn(async (input: { orderId: string; paymentId: string }) => {
        const order = records.orders.find((candidate) => candidate.id === input.orderId)!;
        const payment = records.payments.find((candidate) => candidate.id === input.paymentId)!;
        order.status = OrderStatus.PAID;
        payment.status = PaymentStatus.COMPLETED;
        return { order, payment, entitlement: {}, alreadyFinalized: false };
      }),
    };
    const service = new CartCheckoutService(
      { find: jest.fn().mockResolvedValue([]) } as never,
      dataSource as unknown as DataSource,
      orders as never,
      discounts as never,
      {
        calculate: jest.fn((amount) => ({
          platformCommissionBps: 3000,
          platformCommissionMinor: Math.floor(amount * 0.3),
          teacherEarningMinor: amount - Math.floor(amount * 0.3),
        })),
        calculateGatewayFee: jest.fn(() => ({ gatewayFeeBps: 0, gatewayFeeMinor: 0 })),
      } as never,
      { getDefault: jest.fn(() => provider), get: jest.fn(() => provider) } as never,
      finalizer as never,
      { completeProviderNotificationInTransaction: jest.fn() } as never,
    );
    return { service, records, dataSource, orders, discounts, provider, finalizer };
  }

  it('charges server-priced lesson and package once, then atomically allocates access per product', async () => {
    const { service, records, dataSource, orders, discounts, provider, finalizer } = fixture();

    const started = await service.checkout('student-1', checkoutDto);
    const retried = await service.checkout('student-1', checkoutDto);

    expect(orders.prepareCartProducts).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ itemId: 'lesson-1' }),
        expect.objectContaining({ itemId: 'package-1' }),
      ]),
      'student-1',
      expect.anything(),
    );
    expect(started).toMatchObject({
      amount_minor: 30_000,
      discount_amount_minor: 3_000,
      final_amount_minor: 27_000,
    });
    expect(retried.checkout_id).toBe(started.checkout_id);
    expect(provider.createCheckoutOrder).toHaveBeenCalledTimes(1);
    expect(discounts.applyDiscount).toHaveBeenCalledWith(
      'discount-1',
      'student-1',
      started.payment_id,
      30,
      expect.anything(),
      300,
    );
    expect(records.orders.map((order) => order.final_amount_minor)).toEqual([9_000, 18_000]);
    expect(records.deletedCartItems).toHaveLength(0);

    await dataSource.transaction((manager: EntityManager) =>
      service.finalizeSuccessfulGatewayPayment(
        {
          paymentId: started.payment_id,
          sourceReference: 'gateway-transaction-1',
          verifiedAmountMinor: 27_000,
          verifiedCurrency: 'EGP',
        },
        manager,
      ),
    );

    expect(finalizer.finalizeSuccessfulPayment).toHaveBeenCalledTimes(2);
    expect(records.orders.every((order) => order.status === OrderStatus.PAID)).toBe(true);
    expect(records.payments.filter((payment) => payment.order_id !== null)).toHaveLength(2);
    expect(records.deletedCartItems).toHaveLength(1);
    expect(records.checkouts[0]?.status).toBe(CartCheckoutStatus.PAID);

    await dataSource.transaction((manager: EntityManager) =>
      service.finalizeSuccessfulGatewayPayment(
        {
          paymentId: started.payment_id,
          sourceReference: 'gateway-transaction-1',
          verifiedAmountMinor: 27_000,
          verifiedCurrency: 'EGP',
        },
        manager,
      ),
    );

    expect(finalizer.finalizeSuccessfulPayment).toHaveBeenCalledTimes(2);
    expect(records.deletedCartItems).toHaveLength(1);
  });

  it('keeps cart items and releases the single discount reservation after a declined payment', async () => {
    const { service, records, discounts } = fixture();
    const started = await service.checkout('student-1', checkoutDto);

    await expect(service.failGatewayPayment(started.payment_id, 'declined')).resolves.toBe(true);

    expect(records.deletedCartItems).toHaveLength(0);
    expect(records.checkouts[0]?.status).toBe(CartCheckoutStatus.FAILED);
    expect(discounts.releaseUsageForPayment).toHaveBeenCalledWith(
      started.payment_id,
      expect.anything(),
    );
  });

  it('rejects the whole checkout when canonical ownership validation rejects one cart product', async () => {
    const { service, records, orders, provider } = fixture();
    orders.prepareCartProducts.mockRejectedValueOnce(
      new ConflictException('You already have access to this item'),
    );

    await expect(service.checkout('student-1', checkoutDto)).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(records.checkouts).toHaveLength(0);
    expect(provider.createCheckoutOrder).not.toHaveBeenCalled();
  });
});
