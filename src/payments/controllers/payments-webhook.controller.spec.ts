import { UnauthorizedException } from '@nestjs/common';

import type {
  PaymentGateway,
  ProviderWebhookEvent,
  ProviderWebhookRequest,
} from '../providers/payment-gateway.interface';
import type {
  GatewayWebhookResponse,
  GatewayWebhookService,
} from '../services/gateway-webhook.service';
import { PaymentsWebhookController } from './payments-webhook.controller';

describe('PaymentsWebhookController', () => {
  const normalizedEvent: ProviderWebhookEvent = {
    provider: 'gateway',
    providerEventId: 'event-1',
    merchantReference: 'payment-1',
    providerOrderReference: 'order-1',
    transactionId: 'transaction-1',
    amountMinor: 10_000,
    currency: 'EGP',
    outcome: 'succeeded',
    payload: {},
  };
  const gateway = {
    verifyWebhook: jest.fn(),
    parseWebhook: jest.fn(),
  };
  const webhooks = {
    process: jest.fn(),
  };
  let controller: PaymentsWebhookController;

  beforeEach(() => {
    jest.clearAllMocks();
    gateway.verifyWebhook.mockReturnValue(true);
    gateway.parseWebhook.mockReturnValue(normalizedEvent);
    webhooks.process.mockResolvedValue({ status: 'success' });
    controller = new PaymentsWebhookController(
      gateway as unknown as PaymentGateway,
      webhooks as unknown as GatewayWebhookService,
    );
  });

  it('passes the raw payload through the central gateway', async () => {
    const payload = { provider: 'specific-shape' };

    await expect(controller.handleWebhook(payload)).resolves.toEqual({
      status: 'success',
    });

    const expectedRequest: ProviderWebhookRequest = { payload };
    expect(gateway.verifyWebhook).toHaveBeenCalledWith(expectedRequest);
    expect(gateway.parseWebhook).toHaveBeenCalledWith(expectedRequest);
    expect(webhooks.process).toHaveBeenCalledWith(normalizedEvent);
  });

  it('rejects invalid signatures before parsing or processing', async () => {
    gateway.verifyWebhook.mockReturnValue(false);

    await expect(controller.handleWebhook({})).rejects.toBeInstanceOf(UnauthorizedException);
    expect(gateway.parseWebhook).not.toHaveBeenCalled();
    expect(webhooks.process).not.toHaveBeenCalled();
  });

  it('keeps the alternative callback endpoint on the same verified flow', async () => {
    const expected: GatewayWebhookResponse = { status: 'pending' };
    webhooks.process.mockResolvedValue(expected);

    await expect(controller.handleCallback({})).resolves.toBe(expected);
    expect(gateway.verifyWebhook).toHaveBeenCalledTimes(1);
  });
});
