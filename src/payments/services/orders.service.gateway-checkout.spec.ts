import { ConflictException } from '@nestjs/common';
import type { DataSource, EntityManager, Repository } from 'typeorm';

import { Order, OrderStatus, Payment, PaymentChannel, PaymentStatus } from '../entities';
import type { PaymentGateway } from '../providers/payment-gateway.interface';
import { OrdersService } from './orders.service';
import type { PaymentProviderRegistry } from './payment-provider-registry.service';

interface CheckoutFixture {
  service: OrdersService;
  payment: Payment;
  provider: PaymentGateway;
}

function checkoutFixture(overrides: Partial<Payment> = {}): CheckoutFixture {
  const order = {
    id: 'order-1',
    order_number: 'ORD-1',
    student_id: 'student-1',
    payment_id: 'payment-1',
    payment_channel: PaymentChannel.GATEWAY,
    final_amount_minor: 10_000,
    currency: 'EGP',
    status: OrderStatus.AWAITING_PAYMENT,
    expires_at: null,
  } as Order;
  const payment = {
    id: 'payment-1',
    order_id: order.id,
    provider: 'easykash',
    provider_reference: null,
    provider_order_reference: null,
    status: PaymentStatus.PENDING,
    failure_reason: null,
    ...overrides,
  } as Payment;
  const provider = {
    name: 'easykash',
    createCheckoutOrder: jest.fn().mockResolvedValue('555'),
    createCheckoutSession: jest.fn().mockResolvedValue({
      redirectUrl: 'https://easykash.test/checkout',
      providerReference: '555',
    }),
  } as unknown as PaymentGateway;

  let transactionTail = Promise.resolve();
  const manager = {
    findOne: jest.fn(async (entity: unknown) => {
      if (entity === Order) return order;
      if (entity === Payment) return payment;
      return null;
    }),
    save: jest.fn(async <T>(_: unknown, entity: T) => entity),
  } as unknown as EntityManager;
  const dataSource = {
    transaction: async <T>(
      callback: (transactionManager: EntityManager) => Promise<T>,
    ): Promise<T> => {
      const prior = transactionTail;
      let release: (() => void) | undefined;
      transactionTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await prior;
      try {
        return await callback(manager);
      } finally {
        release?.();
      }
    },
  } as unknown as DataSource;
  const providers = {
    get: jest.fn().mockReturnValue(provider),
  } as unknown as PaymentProviderRegistry;

  const service = new OrdersService(
    {} as Repository<Order>,
    {} as Repository<Payment>,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    dataSource,
    {} as never,
    {} as never,
    providers,
  );
  return { service, payment, provider };
}

const checkoutDto = {
  billing_data: {
    first_name: 'Test',
    last_name: 'Student',
    email: 'student@example.test',
    phone_number: '01000000000',
    city: 'Cairo',
    state: 'Cairo',
    country: 'EG',
  },
};

describe('OrdersService gateway checkout idempotency', () => {
  it('allows only one concurrent checkout request to register a EasyKash order', async () => {
    const { service, payment, provider } = checkoutFixture();
    let releaseRegistration: (() => void) | undefined;
    const registrationStarted = new Promise<void>((resolve) => {
      (provider.createCheckoutOrder as jest.Mock).mockImplementationOnce(async () => {
        resolve();
        await new Promise<void>((release) => {
          releaseRegistration = release;
        });
        return '555';
      });
    });

    const first = service.startGatewayCheckout('order-1', 'student-1', checkoutDto);
    await registrationStarted;

    await expect(
      service.startGatewayCheckout('order-1', 'student-1', checkoutDto),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(provider.createCheckoutOrder).toHaveBeenCalledTimes(1);
    expect(payment.status).toBe(PaymentStatus.PROCESSING);

    releaseRegistration?.();
    await expect(first).resolves.toMatchObject({
      payment_id: 'payment-1',
      redirect_url: 'https://easykash.test/checkout',
    });
    expect(payment.provider_order_reference).toBe('555');
    expect(provider.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: 'payment-1' }),
      '555',
    );
  });

  it('reissues a hosted session for a persisted provider order after a lost response', async () => {
    const { service, provider } = checkoutFixture({
      status: PaymentStatus.PROCESSING,
      provider_reference: '555',
      provider_order_reference: '555',
    });

    await expect(
      service.startGatewayCheckout('order-1', 'student-1', checkoutDto),
    ).resolves.toMatchObject({
      redirect_url: 'https://easykash.test/checkout',
    });

    expect(provider.createCheckoutOrder).not.toHaveBeenCalled();
    expect(provider.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: 'payment-1' }),
      '555',
    );
  });

  it('does not reopen checkout creation after an ambiguous provider-order failure', async () => {
    const { service, payment, provider } = checkoutFixture();
    (provider.createCheckoutOrder as jest.Mock).mockRejectedValueOnce(new Error('network timeout'));

    await expect(service.startGatewayCheckout('order-1', 'student-1', checkoutDto)).rejects.toThrow(
      'network timeout',
    );
    expect(payment.status).toBe(PaymentStatus.PROCESSING);

    await expect(
      service.startGatewayCheckout('order-1', 'student-1', checkoutDto),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(provider.createCheckoutOrder).toHaveBeenCalledTimes(1);
  });
});
