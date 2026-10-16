import { gatewayOrderExpirationMinutes } from '../gateway-expiry';
import { createHash, randomBytes } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, LessThan, Repository } from 'typeorm';

import { Cart } from '../../cart/entities/cart.entity';
import { CartItem, CartItemType } from '../../cart/entities/cart-item.entity';
import type { CheckoutCartDto } from '../../cart/dto';
import { retryTransaction } from '../../common/utils/transaction-retry.util';
import {
  CartDiscountQuote,
  DiscountCodesService,
} from '../../discount-codes/discount-codes.service';
import { ApplicableItem } from '../../discount-codes/entities/applicable-item.enum';
import { biBody } from '../../i18n/error-translator.util';
import { EGP_CURRENCY, fromMinorUnits } from '../money.util';
import {
  CartCheckout,
  CartCheckoutStatus,
  CollectionParty,
  ItemType,
  Order,
  OrderStatus,
  Payment,
  PaymentAuditLog,
  PaymentChannel,
  PaymentDomainEvent,
  PaymentStatus,
  Refund,
  RefundStatus,
} from '../entities';
import { CommissionService } from './commission.service';
import { OrdersService, type CartCheckoutProduct } from './orders.service';
import { PaymentFinalizationService } from './payment-finalization.service';
import { PaymentProviderRegistry } from './payment-provider-registry.service';
import { RefundsService } from './refunds.service';

export interface CartGatewayCheckoutResult {
  checkout_id: string;
  checkout_number: string;
  payment_id: string;
  order_ids: string[];
  amount_minor: number;
  discount_amount_minor: number;
  final_amount_minor: number;
  currency: string;
  redirect_url: string | null;
  status: CartCheckoutStatus;
}

interface CheckoutContext {
  checkout: CartCheckout;
  payment: Payment;
  orders: Order[];
}

interface GatewayFinalizeInput {
  paymentId: string;
  sourceReference: string;
  verifiedAmountMinor: number;
  verifiedCurrency: string;
  verifiedOccurredAt?: Date;
}

/**
 * Parent checkout + child orders.
 *
 * The parent owns the one external gateway charge. Each child product order
 * receives a separate allocated Payment only inside the successful-payment
 * transaction. That is the key to preserving existing refund, entitlement,
 * ledger, and teacher-settlement semantics per product.
 */
@Injectable()
export class CartCheckoutService {
  constructor(
    @InjectRepository(CartCheckout)
    private readonly checkouts: Repository<CartCheckout>,
    private readonly dataSource: DataSource,
    private readonly orders: OrdersService,
    private readonly discounts: DiscountCodesService,
    private readonly commissions: CommissionService,
    private readonly providers: PaymentProviderRegistry,
    private readonly finalizer: PaymentFinalizationService,
    private readonly refunds: RefundsService,
  ) {}

  public async checkout(
    studentId: string,
    dto: CheckoutCartDto,
  ): Promise<CartGatewayCheckoutResult> {
    const context = await this.createOrReuseCheckout(studentId, dto);
    if (context.checkout.status === CartCheckoutStatus.PAID) {
      return this.result(context.checkout, context.payment, context.orders, null);
    }
    return this.startGatewayCheckout(context.checkout.id, studentId, dto);
  }

  /** Finalizes every child in one transaction after the aggregate gateway fact is verified. */
  public async finalizeSuccessfulGatewayPayment(
    input: GatewayFinalizeInput,
    manager: EntityManager,
  ): Promise<void> {
    const payment = await manager.findOne(Payment, {
      where: { id: input.paymentId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!payment?.cart_checkout_id || payment.order_id !== null) {
      throw new NotFoundException('Cart checkout payment not found');
    }
    const checkout = await manager.findOne(CartCheckout, {
      where: { id: payment.cart_checkout_id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!checkout || checkout.payment_id !== payment.id) {
      throw new UnprocessableEntityException('Cart checkout payment does not match checkout');
    }
    const childOrders = await manager.find(Order, {
      where: { cart_checkout_id: checkout.id },
      order: { created_at: 'ASC', id: 'ASC' },
      lock: { mode: 'pessimistic_write' },
    });
    if (childOrders.length === 0) {
      throw new UnprocessableEntityException('Cart checkout has no product orders');
    }
    if (checkout.status === CartCheckoutStatus.PAID) {
      if (
        childOrders.some((order) => order.status !== OrderStatus.PAID || order.payment_id === null)
      ) {
        throw new UnprocessableEntityException(
          'Paid cart checkout has incomplete product fulfillment',
        );
      }
      return;
    }
    if (
      ![
        CartCheckoutStatus.AWAITING_PAYMENT,
        CartCheckoutStatus.PAYMENT_PROCESSING,
        CartCheckoutStatus.EXPIRED,
      ].includes(checkout.status)
    ) {
      throw new UnprocessableEntityException(
        'Cart checkout cannot be finalized in its current state',
      );
    }
    this.assertGatewayCapture(checkout, payment, input);

    // The existing finalizer locks a teacher's financial stream. A stable
    // cross-cart ordering prevents two mixed-teacher carts from deadlocking
    // by acquiring those advisory locks in opposite orders.
    const ordersForFinalization = [...childOrders].sort(
      (left, right) =>
        (left.teacher_id ?? '').localeCompare(right.teacher_id ?? '') ||
        left.id.localeCompare(right.id),
    );
    for (const order of ordersForFinalization) {
      if (![OrderStatus.AWAITING_PAYMENT, OrderStatus.EXPIRED].includes(order.status)) {
        throw new UnprocessableEntityException('Cart checkout has a non-payable product order');
      }
      if (order.payment_id !== null) {
        throw new UnprocessableEntityException(
          'Cart checkout product already has a payment allocation',
        );
      }
      const allocatedPayment = await manager.save(
        Payment,
        manager.create(Payment, {
          order_id: order.id,
          cart_checkout_id: checkout.id,
          user_id: checkout.student_id,
          item_type: order.item_type,
          item_id: order.item_id,
          amount: fromMinorUnits(order.original_amount_minor),
          discount_amount: fromMinorUnits(order.discount_amount_minor),
          final_amount: fromMinorUnits(order.final_amount_minor),
          amount_minor: order.final_amount_minor,
          currency: order.currency,
          channel: PaymentChannel.GATEWAY,
          provider: payment.provider,
          provider_reference: input.sourceReference,
          status: PaymentStatus.PROCESSING,
          payment_method: checkout.payment_method,
          provider_order_reference: payment.provider_order_reference,
          provider_transaction_id: input.sourceReference,
          idempotency_key: `cart:${checkout.id}:order:${order.id}`,
          failure_reason: null,
          completed_at: null,
        }),
      );
      order.payment_id = allocatedPayment.id;
      await manager.save(Order, order);

      // The gateway verified the aggregate total above. The per-product amount
      // passed here is the immutable server-side allocation that sums exactly
      // to that total, allowing the existing finalizer to retain its strict
      // single-order financial and entitlement invariants.
      await this.finalizer.finalizeSuccessfulPayment(
        {
          orderId: order.id,
          paymentId: allocatedPayment.id,
          sourceReference: input.sourceReference,
          actorId: null,
          verifiedAmountMinor: order.final_amount_minor,
          verifiedCurrency: order.currency,
          ...(input.verifiedOccurredAt === undefined
            ? {}
            : { verifiedOccurredAt: input.verifiedOccurredAt }),
        },
        manager,
      );
    }

    payment.status = PaymentStatus.COMPLETED;
    payment.completed_at = new Date();
    payment.provider_reference = input.sourceReference;
    payment.provider_transaction_id = input.sourceReference;
    await manager.save(Payment, payment);
    checkout.status = CartCheckoutStatus.PAID;
    checkout.paid_at = new Date();
    checkout.failure_reason = null;
    await manager.save(CartCheckout, checkout);

    const cartItemIds = this.cartItemIds(checkout);
    if (cartItemIds.length > 0) {
      await manager.delete(CartItem, { cart_id: checkout.cart_id, id: In(cartItemIds) });
    }
    await manager.update(
      Cart,
      { id: checkout.cart_id },
      { discount_code: null, discount_amount: 0 },
    );
    await manager.insert(PaymentAuditLog, {
      actor_id: null,
      action: 'cart_checkout_finalized',
      resource_type: 'cart_checkout',
      resource_id: checkout.id,
      details: {
        checkout_number: checkout.checkout_number,
        payment_id: payment.id,
        order_ids: childOrders.map((order) => order.id),
        source_reference: input.sourceReference,
        amount_minor: checkout.final_amount_minor,
        currency: checkout.currency,
      },
      ip_address: null,
    });
    await this.insertEvent(manager, 'cart_checkout.paid', `cart-checkout:${checkout.id}:paid`, {
      checkout_id: checkout.id,
      payment_id: payment.id,
      order_ids: childOrders.map((order) => order.id),
    });
  }

  /** Failed/declined gateway events never remove the cart or consume a discount. */
  public async failGatewayPayment(paymentId: string, reason: string): Promise<boolean> {
    return retryTransaction(this.dataSource, async (manager) => {
      const payment = await manager.findOne(Payment, {
        where: { id: paymentId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!payment?.cart_checkout_id || payment.order_id !== null) return false;
      const checkout = await manager.findOne(CartCheckout, {
        where: { id: payment.cart_checkout_id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!checkout || checkout.status === CartCheckoutStatus.PAID) return true;
      if (![PaymentStatus.PENDING, PaymentStatus.PROCESSING].includes(payment.status)) return true;

      payment.status = PaymentStatus.FAILED;
      payment.failure_reason = reason;
      await manager.save(Payment, payment);
      checkout.status = CartCheckoutStatus.FAILED;
      checkout.failure_reason = reason;
      await manager.save(CartCheckout, checkout);
      await manager.update(
        Order,
        { cart_checkout_id: checkout.id, status: OrderStatus.AWAITING_PAYMENT },
        { status: OrderStatus.REJECTED },
      );
      await this.discounts.releaseUsageForPayment(payment.id, manager);
      await manager.insert(PaymentAuditLog, {
        actor_id: null,
        action: 'cart_checkout_failed',
        resource_type: 'cart_checkout',
        resource_id: checkout.id,
        details: { payment_id: payment.id, reason },
        ip_address: null,
      });
      await this.insertEvent(
        manager,
        'cart_checkout.failed',
        `cart-checkout:${checkout.id}:failed`,
        {
          checkout_id: checkout.id,
          payment_id: payment.id,
          reason,
        },
      );
      return true;
    });
  }

  /**
   * Provider refund webhooks identify the aggregate charge, while refund
   * records remain product-scoped. A full aggregate refund is split across
   * all remaining child orders. A partial callback is accepted only when it
   * unambiguously matches one in-progress product refund; otherwise it is
   * fail-closed for financial reconciliation.
   */
  public async completeProviderRefundNotification(
    manager: EntityManager,
    paymentId: string,
    sourceReference: string,
    amountMinor: number,
    currency: string,
  ): Promise<void> {
    const payment = await manager.findOne(Payment, {
      where: { id: paymentId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!payment?.cart_checkout_id || payment.order_id !== null) {
      throw new NotFoundException('Cart checkout payment not found');
    }
    const checkout = await manager.findOne(CartCheckout, {
      where: { id: payment.cart_checkout_id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!checkout || checkout.payment_id !== payment.id) {
      throw new UnprocessableEntityException('Cart checkout payment does not match checkout');
    }
    if (currency.toUpperCase() !== checkout.currency.toUpperCase() || amountMinor <= 0) {
      throw new UnprocessableEntityException(
        'Provider refund does not match cart checkout currency',
      );
    }
    const orders = await manager.find(Order, {
      where: { cart_checkout_id: checkout.id },
      order: { created_at: 'ASC', id: 'ASC' },
      lock: { mode: 'pessimistic_write' },
    });
    const refundable = orders.filter(
      (order) =>
        order.payment_id !== null &&
        [OrderStatus.PAID, OrderStatus.PARTIALLY_REFUNDED].includes(order.status) &&
        order.final_amount_minor > order.refunded_amount_minor,
    );
    const remaining = refundable.reduce(
      (sum, order) => sum + order.final_amount_minor - order.refunded_amount_minor,
      0,
    );
    if (remaining === 0) return;
    if (amountMinor === remaining) {
      for (const order of refundable) {
        await this.refunds.completeProviderNotificationInTransaction(
          manager,
          order.payment_id!,
          sourceReference,
          order.final_amount_minor - order.refunded_amount_minor,
          checkout.currency,
        );
      }
      return;
    }
    const childPaymentIds = refundable.map((order) => order.payment_id!).filter(Boolean);
    const alreadyCompleted = await manager.find(Refund, {
      where: {
        payment_id: In(childPaymentIds),
        amount_minor: amountMinor,
        external_reference: sourceReference,
        status: RefundStatus.SUCCEEDED,
      },
      lock: { mode: 'pessimistic_write' },
    });
    if (alreadyCompleted.length === 1) return;
    const pending = await manager.find(Refund, {
      where: {
        payment_id: In(childPaymentIds),
        amount_minor: amountMinor,
        status: In([RefundStatus.REQUESTED, RefundStatus.APPROVED, RefundStatus.PROCESSING]),
      },
      lock: { mode: 'pessimistic_write' },
    });
    if (pending.length !== 1 || !pending[0]?.payment_id) {
      throw new UnprocessableEntityException(
        'Provider partial refund cannot be matched unambiguously to a cart product',
      );
    }
    await this.refunds.completeProviderNotificationInTransaction(
      manager,
      pending[0].payment_id,
      sourceReference,
      amountMinor,
      checkout.currency,
    );
  }

  /** Leaves a durable, visible reconciliation trail when a capture cannot fulfil atomically. */
  public async markFulfillmentReconciliation(
    manager: EntityManager,
    paymentId: string,
    sourceReference: string,
    reason: string,
  ): Promise<void> {
    const payment = await manager.findOne(Payment, {
      where: { id: paymentId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!payment?.cart_checkout_id || payment.order_id !== null) return;
    const checkout = await manager.findOne(CartCheckout, {
      where: { id: payment.cart_checkout_id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!checkout) return;
    payment.reconciliation_status = 'reconciliation_required';
    payment.reconciliation_last_provider_error = reason;
    payment.reconciliation_next_retry_at = null;
    payment.failure_reason = `reconciliation_required: cart fulfillment failed: ${reason}`;
    checkout.status = CartCheckoutStatus.RECONCILIATION_REQUIRED;
    checkout.failure_reason = reason;
    await manager.save(Payment, payment);
    await manager.save(CartCheckout, checkout);
    await manager.insert(PaymentAuditLog, {
      actor_id: null,
      action: 'cart_checkout_fulfillment_compensation_required',
      resource_type: 'cart_checkout',
      resource_id: checkout.id,
      details: { payment_id: payment.id, source_reference: sourceReference, reason },
      ip_address: null,
    });
    await this.insertEvent(
      manager,
      'cart_checkout.fulfillment_compensation_required',
      `cart-checkout:${checkout.id}:fulfillment-compensation`,
      {
        checkout_id: checkout.id,
        payment_id: payment.id,
        source_reference: sourceReference,
        reason,
      },
    );
  }

  /** Expiry closes the whole aggregate, releases the one discount use, and leaves the cart untouched. */
  public async expireDueCheckouts(limit = 500): Promise<number> {
    const due = await this.checkouts.find({
      where: {
        status: In([CartCheckoutStatus.AWAITING_PAYMENT, CartCheckoutStatus.PAYMENT_PROCESSING]),
        expires_at: LessThan(new Date()),
      },
      order: { expires_at: 'ASC' },
      take: limit,
    });
    let expired = 0;
    for (const candidate of due) {
      const changed = await retryTransaction(this.dataSource, async (manager) => {
        const checkout = await manager.findOne(CartCheckout, {
          where: { id: candidate.id },
          lock: { mode: 'pessimistic_write' },
        });
        if (
          !checkout ||
          ![CartCheckoutStatus.AWAITING_PAYMENT, CartCheckoutStatus.PAYMENT_PROCESSING].includes(
            checkout.status,
          ) ||
          !checkout.expires_at ||
          checkout.expires_at > new Date()
        ) {
          return false;
        }
        checkout.status = CartCheckoutStatus.EXPIRED;
        checkout.failure_reason = 'Checkout expired before payment confirmation';
        await manager.save(CartCheckout, checkout);
        if (checkout.payment_id) {
          await manager.update(
            Payment,
            {
              id: checkout.payment_id,
              status: In([PaymentStatus.PENDING, PaymentStatus.PROCESSING, PaymentStatus.FAILED]),
            },
            { status: PaymentStatus.EXPIRED },
          );
          await this.discounts.releaseUsageForPayment(checkout.payment_id, manager);
        }
        await manager.update(
          Order,
          { cart_checkout_id: checkout.id, status: OrderStatus.AWAITING_PAYMENT },
          { status: OrderStatus.EXPIRED },
        );
        await this.insertEvent(
          manager,
          'cart_checkout.expired',
          `cart-checkout:${checkout.id}:expired`,
          {
            checkout_id: checkout.id,
          },
        );
        return true;
      });
      if (changed) expired += 1;
    }
    return expired;
  }

  private async createOrReuseCheckout(
    studentId: string,
    dto: CheckoutCartDto,
  ): Promise<CheckoutContext> {
    return retryTransaction(this.dataSource, async (manager) => {
      if (dto.idempotency_key) {
        const replay = await manager.findOne(CartCheckout, {
          where: { student_id: studentId, idempotency_key: dto.idempotency_key },
          lock: { mode: 'pessimistic_write' },
        });
        if (replay) return this.loadContext(manager, replay);
      }
      const cart = await manager.findOne(Cart, {
        where: { user_id: studentId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!cart) {
        throw new BadRequestException(biBody('Cart is empty', 'السلة فارغة'));
      }
      const cartItems = await manager.find(CartItem, {
        where: { cart_id: cart.id },
        order: { created_at: 'ASC', id: 'ASC' },
        lock: { mode: 'pessimistic_write' },
      });
      if (cartItems.length === 0) {
        throw new BadRequestException(biBody('Cart is empty', 'السلة فارغة'));
      }
      const fingerprint = this.fingerprint(cartItems);
      const open = await manager.findOne(CartCheckout, {
        where: { student_id: studentId, cart_fingerprint: fingerprint },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        open &&
        [CartCheckoutStatus.AWAITING_PAYMENT, CartCheckoutStatus.PAYMENT_PROCESSING].includes(
          open.status,
        )
      ) {
        return this.loadContext(manager, open);
      }

      const products = await this.orders.prepareCartProducts(
        cartItems.map((item) => ({
          cartItemId: item.id,
          itemType: this.orderItemType(item.item_type),
          itemId: item.item_id,
        })),
        studentId,
        manager,
      );
      const discount = await this.discounts.quoteCartDiscount(
        products.map((product) => ({
          key: product.cartItemId,
          item_type: this.discountItemType(product),
          item_id: product.itemId,
          amount_minor: product.priceMinor,
        })),
        dto.discount_code,
        studentId,
        manager,
      );
      const originalAmount = products.reduce((sum, product) => sum + product.priceMinor, 0);
      const finalAmount = originalAmount - discount.discount_amount_minor;
      if (!Number.isSafeInteger(finalAmount) || finalAmount <= 0) {
        throw new BadRequestException(
          biBody('Cart total must be greater than zero', 'يجب أن يكون إجمالي السلة أكبر من صفر'),
        );
      }
      for (const product of products) {
        const allocated =
          product.priceMinor - (discount.allocations_minor[product.cartItemId] ?? 0);
        if (!Number.isSafeInteger(allocated) || allocated <= 0) {
          throw new BadRequestException(
            biBody(
              'A cart discount cannot reduce an item to zero',
              'لا يمكن لكود الخصم أن يجعل سعر أي عنصر في السلة صفرًا',
            ),
          );
        }
      }

      const now = new Date();
      const expiresAt = new Date(now.getTime() + gatewayOrderExpirationMinutes() * 60_000);
      const checkout = await manager.save(
        CartCheckout,
        manager.create(CartCheckout, {
          checkout_number: this.checkoutNumber(),
          student_id: studentId,
          cart_id: cart.id,
          payment_id: null,
          cart_fingerprint: fingerprint,
          original_amount_minor: originalAmount,
          discount_amount_minor: discount.discount_amount_minor,
          final_amount_minor: finalAmount,
          currency: EGP_CURRENCY,
          status: CartCheckoutStatus.AWAITING_PAYMENT,
          payment_method: dto.payment_method,
          discount_code_id: discount.discount_code_id,
          cart_snapshot: this.snapshot(products, discount, cartItems),
          idempotency_key:
            dto.idempotency_key ??
            `cart-${studentId}-${fingerprint}-${randomBytes(8).toString('hex')}`,
          failure_reason: null,
          expires_at: expiresAt,
          paid_at: null,
          cancelled_at: null,
        }),
      );
      const provider = this.providers.getDefault();
      const parentPayment = await manager.save(
        Payment,
        manager.create(Payment, {
          order_id: null,
          cart_checkout_id: checkout.id,
          user_id: studentId,
          item_type: null as never,
          item_id: null as never,
          amount: fromMinorUnits(originalAmount),
          discount_amount: fromMinorUnits(discount.discount_amount_minor),
          final_amount: fromMinorUnits(finalAmount),
          amount_minor: finalAmount,
          currency: EGP_CURRENCY,
          channel: PaymentChannel.GATEWAY,
          provider: provider.name,
          provider_reference: null,
          status: PaymentStatus.PENDING,
          payment_method: dto.payment_method,
          provider_order_reference: null,
          provider_transaction_id: null,
          idempotency_key: `cart-payment:${checkout.id}`,
          failure_reason: null,
          completed_at: null,
        }),
      );
      checkout.payment_id = parentPayment.id;
      await manager.save(CartCheckout, checkout);
      const childOrders = await this.createChildOrders(
        manager,
        checkout,
        products,
        discount,
        provider.name,
      );
      if (discount.discount_code_id) {
        await this.discounts.applyDiscount(
          discount.discount_code_id,
          studentId,
          parentPayment.id,
          fromMinorUnits(discount.discount_amount_minor),
          manager,
          fromMinorUnits(discount.applicable_subtotal_minor),
        );
      }
      await manager.insert(PaymentAuditLog, {
        actor_id: studentId,
        action: 'cart_checkout_created',
        resource_type: 'cart_checkout',
        resource_id: checkout.id,
        details: {
          checkout_number: checkout.checkout_number,
          payment_id: parentPayment.id,
          order_ids: childOrders.map((order) => order.id),
          original_amount_minor: originalAmount,
          discount_amount_minor: discount.discount_amount_minor,
          final_amount_minor: finalAmount,
        },
        ip_address: null,
      });
      return { checkout, payment: parentPayment, orders: childOrders };
    });
  }

  private async startGatewayCheckout(
    checkoutId: string,
    studentId: string,
    dto: CheckoutCartDto,
  ): Promise<CartGatewayCheckoutResult> {
    const claimed = await retryTransaction(this.dataSource, async (manager) => {
      const checkout = await manager.findOne(CartCheckout, {
        where: { id: checkoutId, student_id: studentId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!checkout || !checkout.payment_id) throw new NotFoundException('Cart checkout not found');
      const payment = await manager.findOne(Payment, {
        where: { id: checkout.payment_id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!payment || payment.cart_checkout_id !== checkout.id || payment.order_id !== null) {
        throw new UnprocessableEntityException('Cart checkout payment is invalid');
      }
      const orders = await manager.find(Order, {
        where: { cart_checkout_id: checkout.id },
        order: { created_at: 'ASC', id: 'ASC' },
      });
      if (checkout.status === CartCheckoutStatus.PAID)
        return { checkout, payment, orders, reference: null };
      if (
        ![CartCheckoutStatus.AWAITING_PAYMENT, CartCheckoutStatus.PAYMENT_PROCESSING].includes(
          checkout.status,
        ) ||
        (checkout.expires_at !== null && checkout.expires_at <= new Date())
      ) {
        throw new ConflictException(
          biBody('Cart checkout is no longer payable', 'لم تعد عملية الدفع من السلة متاحة'),
        );
      }
      if (payment.provider_order_reference !== null) {
        return { checkout, payment, orders, reference: payment.provider_order_reference };
      }
      if (payment.status === PaymentStatus.PROCESSING) {
        throw new ConflictException(
          biBody('Checkout is already being prepared', 'يجري تجهيز عملية الدفع بالفعل'),
        );
      }
      if (![PaymentStatus.PENDING, PaymentStatus.FAILED].includes(payment.status)) {
        throw new ConflictException(
          biBody(
            'Payment cannot be started in its current state',
            'لا يمكن بدء الدفع في حالته الحالية',
          ),
        );
      }
      payment.status = PaymentStatus.PROCESSING;
      payment.failure_reason = null;
      checkout.status = CartCheckoutStatus.PAYMENT_PROCESSING;
      checkout.failure_reason = null;
      await manager.save(Payment, payment);
      await manager.save(CartCheckout, checkout);
      return { checkout, payment, orders, reference: null };
    });
    if (claimed.checkout.status === CartCheckoutStatus.PAID) {
      return this.result(claimed.checkout, claimed.payment, claimed.orders, null);
    }
    const provider = this.providers.get(claimed.payment.provider);
    const providerInput = {
      paymentId: claimed.payment.id,
      orderId: claimed.checkout.id,
      orderNumber: claimed.checkout.checkout_number,
      amountMinor: claimed.checkout.final_amount_minor,
      currency: claimed.checkout.currency,
      billingData: dto.billing_data,
      ...(claimed.checkout.expires_at ? { expiresAt: claimed.checkout.expires_at } : {}),
    };
    let providerReference = claimed.reference;
    if (!providerReference) {
      const createdReference = await provider.createCheckoutOrder(providerInput);
      providerReference = await retryTransaction(this.dataSource, async (manager) => {
        const checkout = await manager.findOne(CartCheckout, {
          where: { id: claimed.checkout.id, student_id: studentId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!checkout?.payment_id) throw new NotFoundException('Cart checkout not found');
        const payment = await manager.findOne(Payment, {
          where: { id: checkout.payment_id },
          lock: { mode: 'pessimistic_write' },
        });
        if (!payment || payment.cart_checkout_id !== checkout.id) {
          throw new UnprocessableEntityException('Cart checkout payment is invalid');
        }
        if (payment.provider_order_reference !== null) return payment.provider_order_reference;
        if (payment.status !== PaymentStatus.PROCESSING) {
          throw new ConflictException('Payment cannot be started in its current state');
        }
        payment.provider_reference = createdReference;
        payment.provider_order_reference = createdReference;
        await manager.save(Payment, payment);
        return createdReference;
      });
    }
    const hosted = await provider.createCheckoutSession(providerInput, providerReference);
    return this.result(claimed.checkout, claimed.payment, claimed.orders, hosted.redirectUrl);
  }

  private async createChildOrders(
    manager: EntityManager,
    checkout: CartCheckout,
    products: CartCheckoutProduct[],
    discount: CartDiscountQuote,
    providerName: string,
  ): Promise<Order[]> {
    const orders: Order[] = [];
    for (const product of products) {
      const discountAmount = discount.allocations_minor[product.cartItemId] ?? 0;
      const finalAmount = product.priceMinor - discountAmount;
      const commission = this.commissions.calculate(finalAmount);
      const gatewayFee = this.commissions.calculateGatewayFee(finalAmount);
      orders.push(
        await manager.save(
          Order,
          manager.create(Order, {
            order_number: this.orderNumber(),
            student_id: checkout.student_id,
            teacher_id: product.teacherId,
            item_type: product.itemType,
            item_id: product.itemId,
            quantity: 1,
            original_amount_minor: product.priceMinor,
            discount_amount_minor: discountAmount,
            final_amount_minor: finalAmount,
            refunded_amount_minor: 0,
            currency: EGP_CURRENCY,
            payment_channel: PaymentChannel.GATEWAY,
            payment_method: providerName,
            status: OrderStatus.AWAITING_PAYMENT,
            discount_code_id: discountAmount > 0 ? discount.discount_code_id : null,
            activation_code_id: null,
            payment_id: null,
            cart_checkout_id: checkout.id,
            collection_party: CollectionParty.PLATFORM,
            product_title_snapshot: product.title,
            product_title_ar_snapshot: product.titleAr,
            seller_name_snapshot: product.sellerName,
            platform_commission_bps: commission.platformCommissionBps,
            platform_commission_minor: commission.platformCommissionMinor,
            teacher_earning_minor: commission.teacherEarningMinor,
            gateway_fee_bps: gatewayFee.gatewayFeeBps,
            gateway_fee_minor: gatewayFee.gatewayFeeMinor,
            discount_snapshot:
              discountAmount > 0
                ? {
                    ...(discount.snapshot ?? {}),
                    cart_checkout_id: checkout.id,
                    cart_item_id: product.cartItemId,
                    discount_amount_minor: discountAmount,
                  }
                : null,
            metadata: {
              access_duration_days: product.accessDurationDays,
              cart_checkout_id: checkout.id,
              cart_item_id: product.cartItemId,
            },
            expires_at: checkout.expires_at,
            paid_at: null,
            cancelled_at: null,
          }),
        ),
      );
    }
    return orders;
  }

  private async loadContext(
    manager: EntityManager,
    checkout: CartCheckout,
  ): Promise<CheckoutContext> {
    if (!checkout.payment_id)
      throw new UnprocessableEntityException('Cart checkout is missing payment');
    const payment = await manager.findOne(Payment, { where: { id: checkout.payment_id } });
    if (!payment || payment.cart_checkout_id !== checkout.id || payment.order_id !== null) {
      throw new UnprocessableEntityException('Cart checkout payment is invalid');
    }
    const orders = await manager.find(Order, {
      where: { cart_checkout_id: checkout.id },
      order: { created_at: 'ASC', id: 'ASC' },
    });
    return { checkout, payment, orders };
  }

  private assertGatewayCapture(
    checkout: CartCheckout,
    payment: Payment,
    input: GatewayFinalizeInput,
  ): void {
    if (
      payment.amount_minor !== checkout.final_amount_minor ||
      input.verifiedAmountMinor !== checkout.final_amount_minor ||
      payment.currency.toUpperCase() !== checkout.currency.toUpperCase() ||
      input.verifiedCurrency.toUpperCase() !== checkout.currency.toUpperCase()
    ) {
      throw new UnprocessableEntityException('Gateway capture does not match cart checkout total');
    }
    if (checkout.status === CartCheckoutStatus.EXPIRED) {
      if (!input.verifiedOccurredAt || !checkout.expires_at) {
        throw new UnprocessableEntityException(
          'Expired cart checkout requires a verified capture time',
        );
      }
      // The per-order finalizer applies the configured grace window too. This
      // guard only rules out a clearly late aggregate capture before child
      // payments are allocated.
      if (input.verifiedOccurredAt.getTime() > checkout.expires_at.getTime() + 300_000) {
        throw new UnprocessableEntityException(
          'Gateway capture occurred after cart checkout expiry',
        );
      }
    }
  }

  private result(
    checkout: CartCheckout,
    payment: Payment,
    orders: Order[],
    redirectUrl: string | null,
  ): CartGatewayCheckoutResult {
    return {
      checkout_id: checkout.id,
      checkout_number: checkout.checkout_number,
      payment_id: payment.id,
      order_ids: orders.map((order) => order.id),
      amount_minor: checkout.original_amount_minor,
      discount_amount_minor: checkout.discount_amount_minor,
      final_amount_minor: checkout.final_amount_minor,
      currency: checkout.currency,
      redirect_url: redirectUrl,
      status: checkout.status,
    };
  }

  private orderItemType(type: CartItemType): ItemType.LESSON | ItemType.PACKAGE {
    if (type === CartItemType.LESSON) return ItemType.LESSON;
    return ItemType.PACKAGE;
  }

  private discountItemType(product: CartCheckoutProduct): ApplicableItem {
    return product.itemType === ItemType.LESSON ? ApplicableItem.LESSON : ApplicableItem.PACKAGE;
  }

  private fingerprint(items: CartItem[]): string {
    const canonical = items
      .map((item) => `${item.id}:${item.item_type}:${item.item_id}`)
      .sort()
      .join('|');
    return createHash('sha256').update(canonical).digest('hex');
  }

  private snapshot(
    products: CartCheckoutProduct[],
    discount: CartDiscountQuote,
    cartItems: CartItem[],
  ): Record<string, unknown> {
    const createdAt = new Map(cartItems.map((item) => [item.id, item.created_at.toISOString()]));
    return {
      items: products.map((product) => ({
        cart_item_id: product.cartItemId,
        item_type: product.itemType,
        item_id: product.itemId,
        title: product.title,
        original_amount_minor: product.priceMinor,
        discount_amount_minor: discount.allocations_minor[product.cartItemId] ?? 0,
        final_amount_minor:
          product.priceMinor - (discount.allocations_minor[product.cartItemId] ?? 0),
        cart_item_created_at: createdAt.get(product.cartItemId) ?? null,
      })),
      discount: discount.snapshot,
    };
  }

  private cartItemIds(checkout: CartCheckout): string[] {
    const items = checkout.cart_snapshot['items'];
    if (!Array.isArray(items)) return [];
    return items
      .map((item) =>
        item && typeof item === 'object' && typeof item['cart_item_id'] === 'string'
          ? item['cart_item_id']
          : null,
      )
      .filter((id): id is string => id !== null);
  }

  private checkoutNumber(): string {
    const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    return `CART-${day}-${randomBytes(5).toString('hex').toUpperCase()}`;
  }

  private orderNumber(): string {
    const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    return `LX-${day}-${randomBytes(5).toString('hex').toUpperCase()}`;
  }

  private async insertEvent(
    manager: EntityManager,
    eventName: string,
    dedupeKey: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .insert()
      .into(PaymentDomainEvent)
      .values({
        event_name: eventName,
        dedupe_key: dedupeKey,
        payload,
        published_at: null,
        attempts: 0,
        last_error: null,
      } as never)
      .orIgnore()
      .execute();
  }
}
