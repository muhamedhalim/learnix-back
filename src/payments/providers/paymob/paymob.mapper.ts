import { createHash } from 'node:crypto';

import { BadRequestException } from '@nestjs/common';

import type { ProviderWebhookEvent, ProviderWebhookRequest } from '../payment-gateway.interface';
import type { PaymobTransaction, PaymobWebhookData } from './paymob.types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw malformed(field);
  return value;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw malformed(field);
  return value;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw malformed(field);
  return value;
}

function numberValue(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw malformed(field);
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = numberValue(value, field);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw malformed(field);
  return parsed;
}

function nonNegativeInteger(value: unknown, field: string): number {
  const parsed = numberValue(value, field);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw malformed(field);
  return parsed;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function malformed(field: string): BadRequestException {
  return new BadRequestException(`Malformed payment gateway webhook field: ${field}`);
}

export function parsePaymobWebhook(request: ProviderWebhookRequest): PaymobWebhookData {
  const envelope = record(request.payload, 'payload');
  const transaction = record(envelope['obj'], 'obj');
  const sourceData = record(transaction['source_data'], 'obj.source_data');
  const order = record(transaction['order'], 'obj.order');
  const signature =
    request.signature ??
    (typeof envelope['hmac'] === 'string' && envelope['hmac'] !== ''
      ? envelope['hmac']
      : undefined);

  if (signature === undefined) throw malformed('hmac');
  const message =
    optionalString(transaction['data_message']) ??
    (isRecord(transaction['data']) ? optionalString(transaction['data']['message']) : undefined);

  return {
    type: stringValue(envelope['type'], 'type'),
    signature,
    transaction: {
      id: positiveInteger(transaction['id'], 'obj.id'),
      amountMinor: nonNegativeInteger(transaction['amount_cents'], 'obj.amount_cents'),
      currency: stringValue(transaction['currency'], 'obj.currency').toUpperCase(),
      success: booleanValue(transaction['success'], 'obj.success'),
      pending: booleanValue(transaction['pending'], 'obj.pending'),
      errorOccurred: booleanValue(transaction['error_occured'], 'obj.error_occured'),
      is3dSecure: booleanValue(transaction['is_3d_secure'], 'obj.is_3d_secure'),
      isAuth: booleanValue(transaction['is_auth'], 'obj.is_auth'),
      isCapture: booleanValue(transaction['is_capture'], 'obj.is_capture'),
      isRefunded: booleanValue(transaction['is_refunded'], 'obj.is_refunded'),
      isVoided: booleanValue(transaction['is_voided'], 'obj.is_voided'),
      isStandalonePayment: booleanValue(
        transaction['is_standalone_payment'],
        'obj.is_standalone_payment',
      ),
      hasParentTransaction: booleanValue(
        transaction['has_parent_transaction'],
        'obj.has_parent_transaction',
      ),
      integrationId: positiveInteger(transaction['integration_id'], 'obj.integration_id'),
      owner: positiveInteger(transaction['owner'], 'obj.owner'),
      createdAt: stringValue(transaction['created_at'], 'obj.created_at'),
      sourceData: {
        pan: stringValue(sourceData['pan'], 'obj.source_data.pan'),
        subType: stringValue(sourceData['sub_type'], 'obj.source_data.sub_type'),
        type: stringValue(sourceData['type'], 'obj.source_data.type'),
      },
      order: {
        id: positiveInteger(order['id'], 'obj.order.id'),
        merchantOrderId: stringValue(order['merchant_order_id'], 'obj.order.merchant_order_id'),
      },
      ...(message === undefined ? {} : { message }),
    },
  };
}

export function paymobHmacContent(transaction: PaymobTransaction): string {
  return [
    transaction.amountMinor,
    transaction.createdAt,
    transaction.currency,
    transaction.errorOccurred,
    transaction.hasParentTransaction,
    transaction.id,
    transaction.integrationId,
    transaction.is3dSecure,
    transaction.isAuth,
    transaction.isCapture,
    transaction.isRefunded,
    transaction.isStandalonePayment,
    transaction.isVoided,
    transaction.order.id,
    transaction.owner,
    transaction.pending,
    transaction.sourceData.pan,
    transaction.sourceData.subType,
    transaction.sourceData.type,
    transaction.success,
  ].join('');
}

export function mapPaymobWebhook(
  webhook: PaymobWebhookData,
  provider: string,
  expectedIntegrationId: number,
): ProviderWebhookEvent {
  const { transaction } = webhook;
  if (webhook.type.toUpperCase() !== 'TRANSACTION') {
    throw new BadRequestException('Unsupported payment gateway webhook type');
  }
  if (transaction.integrationId !== expectedIntegrationId) {
    throw new BadRequestException('Payment gateway integration does not match');
  }

  const outcome =
    transaction.isRefunded || transaction.isVoided
      ? 'refunded'
      : transaction.pending
        ? 'pending'
        : transaction.success && !transaction.errorOccurred
          ? 'succeeded'
          : 'failed';
  const eventMaterial = [
    transaction.id,
    transaction.order.id,
    transaction.success,
    transaction.pending,
    transaction.errorOccurred,
    transaction.isRefunded,
    transaction.isVoided,
    transaction.amountMinor,
    transaction.currency,
  ].join('\u001f');

  return {
    provider,
    providerEventId: createHash('sha256').update(eventMaterial).digest('hex'),
    merchantReference: transaction.order.merchantOrderId,
    providerOrderReference: String(transaction.order.id),
    transactionId: String(transaction.id),
    amountMinor: transaction.amountMinor,
    currency: transaction.currency,
    outcome,
    ...(transaction.message === undefined ? {} : { message: transaction.message }),
    payload: {
      type: webhook.type,
      transaction_id: transaction.id,
      provider_order_id: transaction.order.id,
      merchant_reference: transaction.order.merchantOrderId,
      amount_minor: transaction.amountMinor,
      currency: transaction.currency,
      integration_id: transaction.integrationId,
      success: transaction.success,
      pending: transaction.pending,
      error_occurred: transaction.errorOccurred,
      refunded: transaction.isRefunded,
      voided: transaction.isVoided,
      ...(transaction.message === undefined ? {} : { message: transaction.message }),
    },
  };
}
