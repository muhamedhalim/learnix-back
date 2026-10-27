import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { retryTransaction } from '../../common/utils/transaction-retry.util';
import { IdempotencyService } from '../../idempotency/idempotency.service';
import { biBody } from '../../i18n/error-translator.util';
import type { BillingDataDto } from '../../payments/dto/billing-data.dto';
import { ItemType } from '../../payments/entities/item-type.enum';
import { Payment } from '../../payments/entities/payment.entity';
import { PaymentChannel } from '../../payments/entities/payment-channel.enum';
import { PaymentMethod } from '../../payments/entities/payment-method.enum';
import { PaymentStatus } from '../../payments/entities/payment-status.enum';
import type { PaymentGateway } from '../../payments/providers/payment-gateway.interface';
import { PAYMENT_GATEWAY } from '../../payments/providers/payment-gateway.interface';
import { isStaleUnreferencedProcessing } from '../../payments/services/orders.service';
import { MarketplaceOrderStatus } from '../common/enums';
import { MarketplaceOrder } from './entities';

export interface CheckoutResult {
  order_id: string;
  order_number: string;
  payment_id: string;
  redirect_url: string;
  amount_minor: number;
  currency: string;
}

interface ClaimedCheckout {
  order: MarketplaceOrder;
  payment: Payment;
  providerReference: string | null;
}

/**
 * FR-093 – FR-097. Reuses the platform's single `PAYMENT_GATEWAY` — no
 * second payment integration — via the exact same two-step
 * `createCheckoutOrder` → `createCheckoutSession` call the academic
 * checkout uses (`OrdersService.startGatewayCheckout`), so both flows are
 * exercised through the identical, already-hardened gateway code path.
 * The marketplace `Payment` row is the shared entity's own polymorphic
 * `item_type`/`item_id` pair (`ItemType.MARKETPLACE_COURSE`, `item_id` =
 * `MarketplaceOrder.id`) — no `marketplace_payments` table.
 *
 * Like the academic flow, the gateway call is bracketed by two short
 * transactions that lock the order and then the payment (same lock order as
 * `OrdersService`): the first CLAIMS the checkout (PROCESSING) so a concurrent
 * request cannot create a second provider order, the provider is called
 * OUTSIDE any transaction (network I/O never holds a row lock), and the second
 * persists the provider reference. A claim that never receives its reference
 * (crash, provider outage) becomes reclaimable after `STALE_CHECKOUT_CLAIM_MS`.
 */
@Injectable()
export class MarketplaceCheckoutService {
  constructor(
    @Inject(PAYMENT_GATEWAY)
    private readonly gateway: PaymentGateway,
    private readonly dataSource: DataSource,
    private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * contracts §4's checkout endpoint. A client-supplied `Idempotency-Key`
   * is required by the controller (T103) and replayed here: an identical
   * retry (same learner, same key) returns the exact same cached result
   * instead of creating a second `Payment`/gateway order. A DIFFERENT key
   * racing the same order is serialised by the claim below and gets a 409.
   */
  public async createCheckout(
    learnerId: string,
    orderId: string,
    billingData: BillingDataDto,
    idempotencyKey: string,
  ): Promise<CheckoutResult> {
    const cached = await this.idempotency.checkPaymentRequest(learnerId, idempotencyKey);
    if (cached.isProcessed && cached.cachedResult) {
      return cached.cachedResult as CheckoutResult;
    }

    const claimed = await retryTransaction(this.dataSource, (manager) =>
      this.claim(manager, learnerId, orderId),
    );
    const { order, payment } = claimed;

    const checkoutInput = {
      paymentId: payment.id,
      orderId: order.id,
      orderNumber: order.order_number,
      amountMinor: order.net_amount_minor,
      currency: order.currency,
      billingData,
    };

    let providerReference = claimed.providerReference;
    if (providerReference === null) {
      const createdReference = await this.gateway.createCheckoutOrder(checkoutInput);
      providerReference = await retryTransaction(this.dataSource, (manager) =>
        this.persistReference(manager, learnerId, orderId, createdReference),
      );
    }

    const session = await this.gateway.createCheckoutSession(checkoutInput, providerReference);

    const result: CheckoutResult = {
      order_id: order.id,
      order_number: order.order_number,
      payment_id: payment.id,
      redirect_url: session.redirectUrl,
      amount_minor: order.net_amount_minor,
      currency: order.currency,
    };
    await this.idempotency.storePaymentResult(learnerId, idempotencyKey, result);
    return result;
  }

  /** Locks order → payment, creates the payment if needed, and claims the checkout. */
  private async claim(
    manager: EntityManager,
    learnerId: string,
    orderId: string,
  ): Promise<ClaimedCheckout> {
    const order = await this.lockPayableOrder(manager, learnerId, orderId);

    const payment = await manager.findOne(Payment, {
      where: { item_type: ItemType.MARKETPLACE_COURSE, item_id: order.id },
      lock: { mode: 'pessimistic_write' },
    });

    if (!payment) {
      const created = await manager.save(
        Payment,
        manager.create(Payment, {
          user_id: learnerId,
          item_type: ItemType.MARKETPLACE_COURSE,
          item_id: order.id,
          amount: order.net_amount_minor / 100,
          final_amount: order.net_amount_minor / 100,
          amount_minor: order.net_amount_minor,
          currency: order.currency,
          channel: PaymentChannel.GATEWAY,
          provider: this.gateway.name,
          status: PaymentStatus.PROCESSING,
          payment_method: PaymentMethod.CARD,
          idempotency_key: `marketplace-checkout:${order.id}`,
        }),
      );
      order.payment_id = created.id;
      await manager.save(MarketplaceOrder, order);
      return { order, payment: created, providerReference: null };
    }

    if (payment.provider_order_reference !== null) {
      return { order, payment, providerReference: payment.provider_order_reference };
    }
    if (payment.status === PaymentStatus.PROCESSING && !isStaleUnreferencedProcessing(payment)) {
      throw new ConflictException(biBody('Checkout is already being prepared', 'جاري تجهيز الدفع'));
    }
    if (
      ![PaymentStatus.PENDING, PaymentStatus.FAILED].includes(payment.status) &&
      !isStaleUnreferencedProcessing(payment)
    ) {
      throw new ConflictException(
        biBody(
          'Payment cannot be started in its current state',
          'لا يمكن بدء الدفع بحالته الحالية',
        ),
      );
    }

    payment.status = PaymentStatus.PROCESSING;
    payment.failure_reason = null;
    // Touch the row so a concurrent retry sees a fresh claim and waits its own grace period.
    payment.updated_at = new Date();
    await manager.save(Payment, payment);
    return { order, payment, providerReference: null };
  }

  /** Persists the provider reference unless a concurrent winner already did. */
  private async persistReference(
    manager: EntityManager,
    learnerId: string,
    orderId: string,
    createdReference: string,
  ): Promise<string> {
    const order = await this.lockPayableOrder(manager, learnerId, orderId);
    const payment = await manager.findOne(Payment, {
      where: { item_type: ItemType.MARKETPLACE_COURSE, item_id: order.id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!payment) {
      throw new NotFoundException(biBody('Payment not found', 'عملية الدفع غير موجودة'));
    }
    if (payment.provider_order_reference !== null) return payment.provider_order_reference;
    if (payment.status !== PaymentStatus.PROCESSING) {
      throw new ConflictException(
        biBody(
          'Payment cannot be started in its current state',
          'لا يمكن بدء الدفع بحالته الحالية',
        ),
      );
    }

    payment.provider_reference = createdReference;
    payment.provider_order_reference = createdReference;
    payment.failure_reason = null;
    await manager.save(Payment, payment);
    return createdReference;
  }

  /** 404 (never 403) for another learner's order; 409 once it is no longer awaiting payment. */
  private async lockPayableOrder(
    manager: EntityManager,
    learnerId: string,
    orderId: string,
  ): Promise<MarketplaceOrder> {
    const order = await manager.findOne(MarketplaceOrder, {
      where: { id: orderId, learner_id: learnerId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!order) {
      throw new NotFoundException(biBody('Order not found', 'الطلب غير موجود'));
    }
    if (order.status !== MarketplaceOrderStatus.AWAITING_PAYMENT) {
      throw new ConflictException(
        biBody('This order is not awaiting payment', 'هذا الطلب ليس بانتظار الدفع'),
      );
    }
    return order;
  }
}
