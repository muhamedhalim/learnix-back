import type { BillingDataDto } from '../dto/billing-data.dto';

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

export interface ProviderCheckoutInput {
  paymentId: string;
  orderId: string;
  orderNumber: string;
  amountMinor: number;
  currency: string;
  billingData: BillingDataDto;
  /** When the internal order stops being payable; bounds voucher expiry. */
  expiresAt?: Date;
}

export interface ProviderCheckoutResult {
  redirectUrl: string;
  providerReference: string | null;
}

export interface ProviderRefundInput {
  providerReference: string;
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
}

export interface ProviderRefundResult {
  providerReference: string;
  status: 'processing' | 'succeeded';
}

/** A provider-authoritative transaction record used for recovery and refunds. */
export interface ProviderTransactionDetails {
  transactionId: string;
  status: 'pending' | 'succeeded' | 'failed' | 'refunded';
  amountMinor: number;
  currency: string;
  /** Absent when the provider exposes no trusted transaction time. */
  occurredAt?: Date;
  providerOrderReference: string;
  merchantReference: string;
  refundedAmountMinor: number;
  isLive?: boolean;
}

export interface ProviderWebhookRequest {
  payload: unknown;
  signature?: string;
}

export interface ProviderWebhookEvent {
  provider: string;
  providerEventId: string;
  merchantReference: string;
  providerOrderReference: string;
  transactionId: string;
  amountMinor: number;
  currency: string;
  /** Provider-signed transaction timestamp, when available. */
  occurredAt?: Date;
  isLive?: boolean;
  outcome: 'pending' | 'succeeded' | 'failed' | 'refunded';
  message?: string;
  payload: Record<string, unknown>;
}

export interface PaymentGatewayConfigurationStatus {
  enabled: boolean;
  configured: boolean;
  endpoint: string;
}

/**
 * Domain-facing provider contract. Commission, wallets and settlements never
 * depend on these capabilities; a gateway only moves and validates external
 * cash. Provider-specific DTOs and states must be normalized before crossing
 * this boundary.
 */
export interface PaymentGateway {
  readonly name: string;
  /**
   * Registers the provider-side order. The reference must be persisted before
   * a hosted payment session is requested, so retries cannot create a second
   * chargeable provider order for one internal payment.
   */
  createCheckoutOrder(input: ProviderCheckoutInput): Promise<string>;
  /** Creates or reissues a hosted session for an existing provider order. */
  createCheckoutSession(
    input: ProviderCheckoutInput,
    providerReference: string,
  ): Promise<ProviderCheckoutResult>;
  getTransactionByOrderReference(
    providerOrderReference: string,
    merchantReference: string,
  ): Promise<ProviderTransactionDetails | null>;
  refund(input: ProviderRefundInput): Promise<ProviderRefundResult>;
  verifyWebhook(request: ProviderWebhookRequest): boolean;
  parseWebhook(request: ProviderWebhookRequest): ProviderWebhookEvent;
  getConfigurationStatus(): PaymentGatewayConfigurationStatus;
  supportsRefunds(): boolean;
  supportsPayouts(): boolean;
  supportsSplitSettlement(): boolean;
}
