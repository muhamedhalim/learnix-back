import { BadRequestException } from '@nestjs/common';

import { GatewayWebhookEvent, Payment, PaymentStatus } from '../entities';
import type { ProviderWebhookEvent } from '../providers/payment-gateway.interface';
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

  const payment = (status = PaymentStatus.PROCESSING): Payment =>
    ({
      id: 'payment-1',
      status,
      amount_minor: 10_000,
      final_amount: 100,
      currency: 'EGP',
      provider: 'configured-gateway',
      provider_reference: 'provider-order-1',
      paymob_order_id: 'provider-order-1',
    }) as Payment;

  const callback = (
    outcome: ProviderWebhookEvent['outcome'],
    eventId = `event-${outcome}`,
  ): ProviderWebhookEvent => ({
    provider: 'configured-gateway',
    providerEventId: eventId,
    merchantReference: 'payment-1',
    providerOrderReference: 'provider-order-1',
    transactionId: 'provider-transaction-1',
    amountMinor: 10_000,
    currency: 'EGP',
    outcome,
    payload: { transaction_id: 1 },
  });

  beforeEach(() => {
    events.clear();
    jest.clearAllMocks();
    payments.getPaymentByMerchantOrderId.mockResolvedValue(payment());
    payments.processSuccessfulPayment.mockResolvedValue(undefined);
    payments.processFailedPayment.mockResolvedValue(undefined);
    payments.processRefundedPayment.mockResolvedValue(undefined);
    service = new GatewayWebhookService(
      repository as never,
      payments as unknown as PaymentsService,
    );
  });

  it('processes a successful callback once and deduplicates the exact retry', async () => {
    const webhook = callback('succeeded');
    await expect(service.process(webhook)).resolves.toMatchObject({ status: 'success' });
    await expect(service.process(webhook)).resolves.toMatchObject({
      status: 'already_processed',
    });

    expect(events.size).toBe(1);
    expect(payments.processSuccessfulPayment).toHaveBeenCalledTimes(1);
    expect(payments.processSuccessfulPayment).toHaveBeenCalledWith('payment-1', {
      amountCents: 10_000,
      currency: 'EGP',
      transactionId: 'provider-transaction-1',
    });
  });

  it('rejects amount, currency, provider, or checkout-order mismatches before side effects', async () => {
    const mismatches: ProviderWebhookEvent[] = [
      { ...callback('succeeded', 'amount'), amountMinor: 9_999 },
      { ...callback('succeeded', 'currency'), currency: 'USD' },
      { ...callback('succeeded', 'provider'), provider: 'other' },
      {
        ...callback('succeeded', 'order'),
        providerOrderReference: 'different-order',
      },
    ];
    for (const webhook of mismatches) {
      await expect(service.process(webhook)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(payments.processSuccessfulPayment).not.toHaveBeenCalled();
    expect(payments.processFailedPayment).not.toHaveBeenCalled();
    expect(payments.processRefundedPayment).not.toHaveBeenCalled();
  });

  it('does not let an out-of-order failure overwrite a completed payment', async () => {
    payments.getPaymentByMerchantOrderId.mockResolvedValue(payment(PaymentStatus.COMPLETED));

    await expect(service.process(callback('failed'))).resolves.toMatchObject({
      status: 'success',
    });
    expect(payments.processFailedPayment).not.toHaveBeenCalled();
  });

  it('maps a refund callback to the existing refund finalization flow', async () => {
    payments.getPaymentByMerchantOrderId.mockResolvedValue(payment(PaymentStatus.COMPLETED));

    await expect(service.process(callback('refunded'))).resolves.toMatchObject({
      status: 'refunded',
    });
    expect(payments.processRefundedPayment).toHaveBeenCalledTimes(1);
  });

  it('treats a void before completion as a failed payment without granting access', async () => {
    await expect(service.process(callback('refunded'))).resolves.toMatchObject({
      status: 'failed',
    });
    expect(payments.processFailedPayment).toHaveBeenCalledTimes(1);
    expect(payments.processRefundedPayment).not.toHaveBeenCalled();
  });
});
