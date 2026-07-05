import * as crypto from 'node:crypto';

import { ConfigService } from '@nestjs/config';

import { PaymobService } from './paymob.service';
import { PaymobTransactionDto } from '../dto/paymob-webhook.dto';

const SECRET = 'test_hmac_secret';

function makeTransaction(): PaymobTransactionDto {
  return {
    id: 123,
    amount_cents: 10000,
    currency: 'EGP',
    success: true,
    pending: false,
    error_occured: false,
    is_3d_secure: true,
    is_auth: false,
    is_capture: false,
    is_refunded: false,
    is_voided: false,
    is_standalone_payment: true,
    has_parent_transaction: false,
    integration_id: 999,
    owner: 1,
    created_at: '2026-01-01T00:00:00Z',
    source_data: { pan: '2345', sub_type: 'MasterCard', type: 'card' },
    order: { id: 555, merchant_order_id: 'pay-1' },
  };
}

/** Compute the HMAC exactly as Paymob would, for the given secret. */
function signTransaction(obj: PaymobTransactionDto, secret: string): string {
  const fields = [
    obj.amount_cents,
    obj.created_at,
    obj.currency,
    obj.error_occured,
    obj.has_parent_transaction,
    obj.id,
    obj.integration_id,
    obj.is_3d_secure,
    obj.is_auth,
    obj.is_capture,
    obj.is_refunded,
    obj.is_standalone_payment,
    obj.is_voided,
    obj.order.id,
    obj.owner,
    obj.pending,
    obj.source_data.pan,
    obj.source_data.sub_type,
    obj.source_data.type,
    obj.success,
  ].join('');
  return crypto.createHmac('sha512', secret).update(fields).digest('hex');
}

function buildService(secret = SECRET): PaymobService {
  const config = {
    get: (key: string): string => (key === 'PAYMOB_HMAC_SECRET' ? secret : 'x'),
  } as unknown as ConfigService;
  return new PaymobService(config);
}

describe('PaymobService.verifyHmac', () => {
  it('accepts a correctly-signed transaction', () => {
    const service = buildService();
    const obj = makeTransaction();
    const hmac = signTransaction(obj, SECRET);
    expect(service.verifyHmac({ obj }, hmac)).toBe(true);
  });

  it('rejects a tampered amount (signature no longer matches)', () => {
    const service = buildService();
    const obj = makeTransaction();
    const hmac = signTransaction(obj, SECRET);
    const tampered = { ...obj, amount_cents: 1 }; // attacker lowers the amount
    expect(service.verifyHmac({ obj: tampered }, hmac)).toBe(false);
  });

  it('rejects a signature made with the wrong secret (forgery)', () => {
    const service = buildService();
    const obj = makeTransaction();
    const forged = signTransaction(obj, 'attacker_secret');
    expect(service.verifyHmac({ obj }, forged)).toBe(false);
  });

  it('rejects empty / malformed hmac without throwing', () => {
    const service = buildService();
    const obj = makeTransaction();
    expect(service.verifyHmac({ obj }, '')).toBe(false);
    expect(service.verifyHmac({ obj }, 'short')).toBe(false);
  });

  it('fails closed when the HMAC secret is not configured', () => {
    const service = buildService('');
    const obj = makeTransaction();
    const hmac = signTransaction(obj, '');
    expect(service.verifyHmac({ obj }, hmac)).toBe(false);
  });
});
