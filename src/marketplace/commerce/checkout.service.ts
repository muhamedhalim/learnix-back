import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

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

/**
 * FR-093 – FR-097. Reuses the platform's single `PAYMENT_GATEWAY` — no
 * second payment integration — via the exact same two-step
 * `createCheckoutOrder` → `createCheckoutSession` call the academic
 * checkout uses (`OrdersService.startGatewayCheckout`), so both flows are
 * exercised through the identical, already-hardened gateway code path.
 * The marketplace `Payment` row is the shared entity's own polymorphic
 * `item_type`/`item_id` pair (`ItemType.MARKETPLACE_COURSE`, `item_id` =
 * `MarketplaceOrder.id`) — no `marketplace_payments` table.
 */
@Injectable()
export class MarketplaceCheckoutService {
  constructor(
    @Inject(PAYMENT_GATEWAY)
    private readonly gateway: PaymentGateway,
    @InjectRepository(Payment)
    private readonly payments: Repository<Payment>,
    @InjectRepository(MarketplaceOrder)
    private readonly orders: Repository<MarketplaceOrder>,
    private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * contracts §4's checkout endpoint. A client-supplied `Idempotency-Key`
   * is required by the controller (T103) and replayed here: an identical
   * retry (same learner, same key) returns the exact same cached result
   * instead of creating a second `Payment`/gateway order.
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

    const order = await this.orders.findOne({ where: { id: orderId, learner_id: learnerId } });
    if (!order) {
      throw new NotFoundException(biBody('Order not found', 'الطلب غير موجود'));
    }
    if (order.status !== MarketplaceOrderStatus.AWAITING_PAYMENT) {
      throw new ConflictException(biBody('This order is not awaiting payment', 'هذا الطلب ليس بانتظار الدفع'));
    }

    let payment = await this.payments.findOne({
      where: { item_type: ItemType.MARKETPLACE_COURSE, item_id: order.id },
    });
    if (!payment) {
      payment = this.payments.create({
        user_id: learnerId,
        item_type: ItemType.MARKETPLACE_COURSE,
        item_id: order.id,
        amount: order.net_amount_minor / 100,
        final_amount: order.net_amount_minor / 100,
        amount_minor: order.net_amount_minor,
        currency: order.currency,
        channel: PaymentChannel.GATEWAY,
        provider: this.gateway.name,
        status: PaymentStatus.PENDING,
        payment_method: PaymentMethod.CARD,
        idempotency_key: `marketplace-checkout:${order.id}`,
      });
      payment = await this.payments.save(payment);
      order.payment_id = payment.id;
      await this.orders.save(order);
    }

    const checkoutInput = {
      paymentId: payment.id,
      orderId: order.id,
      orderNumber: order.order_number,
      amountMinor: order.net_amount_minor,
      currency: order.currency,
      billingData,
    };

    let providerReference = payment.paymob_order_id;
    if (!providerReference) {
      providerReference = await this.gateway.createCheckoutOrder(checkoutInput);
      payment.paymob_order_id = providerReference;
      payment.provider_reference = providerReference;
      payment.status = PaymentStatus.PROCESSING;
      await this.payments.save(payment);
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
}
