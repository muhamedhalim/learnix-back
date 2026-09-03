import { BadRequestException } from '@nestjs/common';

import { GatewayWebhookEvent, Payment, PaymentStatus } from '../entities';
import { ItemType } from '../entities/item-type.enum';
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
    update: jest.fn((criteria: { id: string }, values: Partial<GatewayWebhookEvent>) => {
      const event = [...events.values()].find((candidate) => candidate.id === criteria.id);
      if (event) Object.assign(event, values, { updated_at: new Date() });
      return Promise.resolve({ affected: event ? 1 : 0 });
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
  const financialStateMachine = { apply: jest.fn() };
  const dataSource = {
    transaction: jest.fn(async (work: (manager: typeof manager) => unknown) => work(manager)),
  };
  const manager = {
    createQueryBuilder: (...args: unknown[]) => repository.createQueryBuilder(...(args as [])),
    findOne: (_entity: unknown, options: { where: { provider_event_id: string } }) =>
      repository.findOne(options),
    save: (entityOrEvent: unknown, maybeEvent?: GatewayWebhookEvent) =>
      repository.save((maybeEvent ?? entityOrEvent) as GatewayWebhookEvent),
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
    financialStateMachine.apply.mockImplementation(
      async (_eventId: string, _lease: string, paymentId: string, webhook: ProviderWebhookEvent) => {
        await payments.processSuccessfulPayment(paymentId, {
          amountCents: webhook.amountMinor,
          currency: webhook.currency,
          transactionId: webhook.transactionId,
        });
        if (webhook.outcome === 'refunded') {
          await payments.processRefundedPayment(paymentId, {
            amountCents: webhook.amountMinor,
            currency: webhook.currency,
            transactionId: webhook.transactionId,
          });
        }
        const event = [...events.values()].find((candidate) => candidate.id === _eventId);
        if (event) {
          event.status = 'processed';
          event.lease_token = null;
          event.processed_at = new Date();
        }
      },
    );
    service = new GatewayWebhookService(
      repository as never,
      dataSource as never,
      payments as unknown as PaymentsService,
      financialStateMachine as never,
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

  it('claims a concurrent webhook replay before any second financial side effect', async () => {
    let release!: () => void;
    let started!: () => void;
    const startedProcessing = new Promise<void>((resolve) => (started = resolve));
    payments.processSuccessfulPayment.mockImplementation(() => {
      started();
      return new Promise<void>((resolve) => (release = resolve));
    });
    const webhook = callback('succeeded', 'concurrent-event');
    const first = service.process(webhook);
    await startedProcessing;
    const replay = await service.process(webhook);

    expect(replay).toMatchObject({ status: 'pending' });
    expect(payments.processSuccessfulPayment).toHaveBeenCalledTimes(1);
    release();
    await expect(first).resolves.toMatchObject({ status: 'success' });
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

  it('delegates an out-of-order failure to the locked payment state machine', async () => {
    payments.getPaymentByMerchantOrderId.mockResolvedValue(payment(PaymentStatus.COMPLETED));

    await expect(service.process(callback('failed'))).resolves.toMatchObject({
      status: 'failed',
    });
    expect(payments.processFailedPayment).toHaveBeenCalledTimes(1);
  });

  it('routes a marketplace payment failure through the state machine instead of the academic processFailedPayment() path (T105)', async () => {
    payments.getPaymentByMerchantOrderId.mockResolvedValue({
      ...payment(),
      item_type: ItemType.MARKETPLACE_COURSE,
    });

    await expect(service.process(callback('failed'))).resolves.toMatchObject({ status: 'failed' });

    expect(financialStateMachine.apply).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'payment-1',
      expect.objectContaining({ outcome: 'failed' }),
    );
    expect(payments.processFailedPayment).not.toHaveBeenCalled();
  });

  it('maps a refund callback to the existing refund finalization flow', async () => {
    payments.getPaymentByMerchantOrderId.mockResolvedValue(payment(PaymentStatus.COMPLETED));

    await expect(service.process(callback('refunded'))).resolves.toMatchObject({
      status: 'refunded',
    });
    expect(payments.processSuccessfulPayment).toHaveBeenCalledTimes(1);
    expect(payments.processRefundedPayment).toHaveBeenCalledTimes(1);
  });

  it('serializes a refund that arrives before a success callback through finalization then refund', async () => {
    await expect(service.process(callback('refunded'))).resolves.toMatchObject({
      status: 'refunded',
    });
    expect(payments.processSuccessfulPayment).toHaveBeenCalledTimes(1);
    expect(payments.processRefundedPayment).toHaveBeenCalledTimes(1);
  });
});
