import { createHash } from 'node:crypto';

import { BadRequestException } from '@nestjs/common';

import type { ProviderWebhookEvent, ProviderWebhookRequest } from '../payment-gateway.interface';
import type { EasyKashSignedFields, EasyKashWebhookData } from './easykash.types';

const SIGNED_FIELD_ORDER = [
  'ProductCode',
  'Amount',
  'ProductType',
  'PaymentMethod',
  'status',
  'easykashRef',
  'customerReference',
] as const;

const SHA512_HEX = /^[0-9a-f]{128}$/iu;
const DECIMAL_AMOUNT = /^\d{1,9}(?:\.\d{1,2})?$/u;
const EASYKASH_CURRENCY = 'EGP';

function malformed(field: string): BadRequestException {
  return new BadRequestException(`Malformed payment gateway webhook field: ${field}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every signed value must be a non-empty string: a number or null would be
 * stringified differently by the sender and by us, so it is rejected up front.
 */
export function parseEasyKashWebhook(request: ProviderWebhookRequest): EasyKashWebhookData {
  if (!isRecord(request.payload)) throw malformed('payload');
  const payload = request.payload;
  const signed = {} as Record<string, string>;
  for (const field of SIGNED_FIELD_ORDER) {
    const value = payload[field];
    if (typeof value !== 'string' || value.trim() === '') throw malformed(field);
    signed[field] = value;
  }
  const signatureHash = payload['signatureHash'];
  if (typeof signatureHash !== 'string' || !SHA512_HEX.test(signatureHash)) {
    throw malformed('signatureHash');
  }
  const voucher = payload['voucher'];
  return {
    signed: signed as unknown as EasyKashSignedFields,
    signatureHash: signatureHash.toLowerCase(),
    ...(typeof voucher === 'string' && /^\d{1,20}$/u.test(voucher) ? { voucher } : {}),
  };
}

/** Documented HMAC input: the values concatenated without separators. */
export function easyKashHmacContent(signed: EasyKashSignedFields): string {
  return SIGNED_FIELD_ORDER.map((field) => signed[field]).join('');
}

/** Converts a decimal major-unit string ("50.5") to integer minor units. */
export function parseEasyKashAmountMinor(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
  if (typeof value !== 'string' || !DECIMAL_AMOUNT.test(value.trim())) return null;
  const [whole = '0', fraction = ''] = value.trim().split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

export function mapEasyKashWebhook(data: EasyKashWebhookData, provider: string): ProviderWebhookEvent {
  const { signed } = data;
  // The callback is only ever sent for a successful payment ("always PAID").
  if (signed.status !== 'PAID') throw malformed('status');
  const amountMinor = parseEasyKashAmountMinor(signed.Amount);
  if (amountMinor === null || amountMinor <= 0) throw malformed('Amount');
  return {
    provider,
    providerEventId: `easykash:${createHash('sha256')
      .update(`${signed.easykashRef}:${signed.customerReference}:PAID`)
      .digest('hex')}`,
    merchantReference: signed.customerReference,
    providerOrderReference: signed.ProductCode,
    transactionId: signed.easykashRef,
    amountMinor,
    // The callback carries no currency; we only ever create EGP payments and
    // reject any other currency at creation time.
    currency: EASYKASH_CURRENCY,
    // `Timestamp` is not covered by the signature, so it is deliberately not
    // trusted as `occurredAt`.
    outcome: 'succeeded',
    payload: {
      ProductCode: signed.ProductCode,
      Amount: signed.Amount,
      ProductType: signed.ProductType,
      PaymentMethod: signed.PaymentMethod,
      status: signed.status,
      easykashRef: signed.easykashRef,
      customerReference: signed.customerReference,
      ...(data.voucher === undefined ? {} : { voucher: data.voucher }),
    },
  };
}
