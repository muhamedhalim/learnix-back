import { BadRequestException } from '@nestjs/common';

import { EasyKashWebhookDto } from '../dto/easykash-webhook.dto';
import { GatewayWebhookEvent, PaymentStatus } from '../entities';
import { GatewayWebhookService } from './gateway-webhook.service';
import { PaymentsService } from './payments.service';

describe('GatewayWebhookService', () => {
  const events = new Map<string, GatewayWebhookEvent>();
  const repository = {
    findOne: jest.fn(({ where }: { where: { provider_event_id: string } }) =>
      Promise.resolve(events.get(where.provider_event_id) ?? null),
    ),
    save: jest.fn((event: GatewayWebhookEvent) => {
      events.set(event.provider_event_id, event);
      return Promise.resolve(event);
    }),
    createQueryBuilder: jest.fn(() => {
      let value: Partial<GatewayWebhookEvent>;
      const chain = {
        insert: jest.fn(() => chain),
        into: jest.fn(() => chain),
        values: jest.fn((next: Partial<GatewayWebhookEvent>) => {
          value = next;
          return chain;
        }),
        orIgnore: jest.fn(() => chain),
        execute: jest.fn(() => {
          if (!events.has(value.provider_event_id!)) {
            events.set(value.provider_event_id!, {
              id: `event-${String(events.size + 1)}`,
              created_at: new Date(),
              updated_at: new Date(),
              ...value,
            } as GatewayWebhookEvent);
          }
          return Promise.resolve({ identifiers: [] });
        }),
      };
      return chain;
    }),
  };
  const payments = {
    getPaymentByMerchantOrderId: jest.fn(),
    processSuccessfulPayment: jest.fn(),
    processFailedPayment: jest.fn(),
    processRefundedPayment: jest.fn(),
  };

  let service: GatewayWebhookService;

  const callback = (status: string, amount = '100.00'): EasyKashWebhookDto => ({
    ProductCode: 'product',
    Amount: amount,
    ProductType: 'Direct Pay',
    PaymentMethod: 'Card',
    status,
    easykashRef: 'provider-payment-1',
    customerReference: 'payment-1',
    signatureHash: 'verified-by-controller',
  });

  beforeEach(() => {
    events.clear();
    jest.clearAllMocks();
    payments.getPaymentByMerchantOrderId.mockResolvedValue({
      id: 'payment-1',
      status: PaymentStatus.PROCESSING,
    });
    payments.processSuccessfulPayment.mockResolvedValue(undefined);
    payments.processFailedPayment.mockResolvedValue(undefined);
    payments.processRefundedPayment.mockResolvedValue(undefined);
    service = new GatewayWebhookService(
      repository as never,
      payments as unknown as PaymentsService,
    );
  });

  it('processes NEW then PAID for the same provider payment, but deduplicates an exact retry', async () => {
    await expect(service.processEasyKash(callback('NEW'))).resolves.toMatchObject({
      status: 'pending',
    });
    await expect(service.processEasyKash(callback('PAID'))).resolves.toMatchObject({
      status: 'success',
    });
    await expect(service.processEasyKash(callback('PAID'))).resolves.toMatchObject({
      status: 'already_processed',
    });

    expect(events.size).toBe(2);
    expect(payments.processSuccessfulPayment).toHaveBeenCalledTimes(1);
    expect(payments.processSuccessfulPayment).toHaveBeenCalledWith('payment-1', {
      amountCents: 10_000,
      currency: 'EGP',
      transactionId: 'provider-payment-1',
    });
  });

  it('rejects a malformed signed amount before financial finalization', async () => {
    await expect(service.processEasyKash(callback('PAID', '1e3'))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(payments.processSuccessfulPayment).not.toHaveBeenCalled();
  });

  it('does not let an out-of-order failure overwrite an already completed payment', async () => {
    payments.getPaymentByMerchantOrderId.mockResolvedValue({
      id: 'payment-1',
      status: PaymentStatus.COMPLETED,
    });

    await expect(service.processEasyKash(callback('FAILED'))).resolves.toMatchObject({
      status: 'success',
    });
    expect(payments.processFailedPayment).not.toHaveBeenCalled();
  });
});
