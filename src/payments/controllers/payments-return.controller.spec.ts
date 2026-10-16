import type { ConfigService } from '@nestjs/config';

import type { PaymentOperationsService } from '../services/payment-operations.service';
import { PaymentsReturnController } from './payments-return.controller';

const PAYMENT_ID = '3f2b8c1e-6a4d-4c43-9d55-0c1f9b2a7e10';

describe('PaymentsReturnController', () => {
  const operations = { resolveHostedReturn: jest.fn() };
  const config = { get: jest.fn().mockReturnValue('https://learnix.school/') };
  let controller: PaymentsReturnController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new PaymentsReturnController(
      operations as unknown as PaymentOperationsService,
      config as unknown as ConfigService,
    );
  });

  it('sends an academic order to the payment-return page by internal order id', async () => {
    operations.resolveHostedReturn.mockResolvedValue({ kind: 'order', id: 'order-1' });

    const result = await controller.handleReturn(PAYMENT_ID);

    expect(result.url).toBe('https://learnix.school/student/payment-return?orderId=order-1');
  });

  it('sends a marketplace purchase to its own return page', async () => {
    operations.resolveHostedReturn.mockResolvedValue({ kind: 'marketplace', id: 'm-1' });

    const result = await controller.handleReturn(PAYMENT_ID);

    expect(result.url).toBe(
      'https://learnix.school/student/marketplace-orders/payment-return?orderId=m-1',
    );
  });

  it('sends cart and unknown payments to the payments list', async () => {
    operations.resolveHostedReturn.mockResolvedValue({ kind: 'cart', id: 'c-1' });
    await expect(controller.handleReturn(PAYMENT_ID)).resolves.toEqual({
      url: 'https://learnix.school/student/payments',
    });
    operations.resolveHostedReturn.mockResolvedValue({ kind: 'unknown', id: null });
    await expect(controller.handleReturn(PAYMENT_ID)).resolves.toEqual({
      url: 'https://learnix.school/student/payments',
    });
  });

  it('forwards only a display hint and a numeric voucher, never a trusted status', async () => {
    operations.resolveHostedReturn.mockResolvedValue({ kind: 'order', id: 'order-1' });

    const result = await controller.handleReturn(PAYMENT_ID, 'SUCCESS', '32423432');

    expect(result.url).toContain('gateway_status=success');
    expect(result.url).toContain('voucher=32423432');
    // The service is only asked to resolve the target; the query never reaches it.
    expect(operations.resolveHostedReturn).toHaveBeenCalledWith(PAYMENT_ID);
  });

  it.each([['<script>'], ['paid'], ['success;drop'], [undefined]])(
    'drops an unrecognised status %p',
    async (status) => {
      operations.resolveHostedReturn.mockResolvedValue({ kind: 'order', id: 'order-1' });

      const result = await controller.handleReturn(PAYMENT_ID, status as string | undefined);

      expect(result.url).not.toContain('gateway_status');
    },
  );

  it.each([['abc123'], ['1'.repeat(21)], ['../x'], ['12 34']])(
    'drops a non-numeric or oversized voucher %p',
    async (voucher) => {
      operations.resolveHostedReturn.mockResolvedValue({ kind: 'order', id: 'order-1' });

      const result = await controller.handleReturn(PAYMENT_ID, 'pending', voucher);

      expect(result.url).not.toContain('voucher');
    },
  );
});
