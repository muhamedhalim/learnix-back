import { randomBytes } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, LessThanOrEqual, MoreThan, Repository } from 'typeorm';

import { AttendanceCode } from '../../attendance-codes/entities/attendance-code.entity';
import { Book } from '../../books/entities/book.entity';
import { BookPurchase } from '../../books/entities/book-purchase.entity';
import { PaginationMeta } from '../../common/interfaces/pagination.interface';
import { retryTransaction } from '../../common/utils/transaction-retry.util';
import { DiscountCodesService } from '../../discount-codes/discount-codes.service';
import { ApplicableItem } from '../../discount-codes/entities/applicable-item.enum';
import { biBody } from '../../i18n/error-translator.util';
import { Lesson } from '../../lessons/entities/lesson.entity';
import { LessonSessionsService } from '../../lessons/lesson-sessions.service';
import { LessonPackage } from '../../packages/entities/lesson-package.entity';
import { User } from '../../users/entities/user.entity';
import { CheckoutQuoteDto, CreateOrderDto, OrderFilterDto, StartGatewayCheckoutDto } from '../dto';
import {
  CollectionParty,
  Entitlement,
  EntitlementStatus,
  ItemType,
  LessonPurchase,
  ManualPaymentMethod,
  Order,
  OrderStatus,
  PackagePurchase,
  Payment,
  PaymentChannel,
  PaymentMethod,
  PaymentStatus,
} from '../entities';
import { serializeManualPaymentMethodForStudent } from '../manual-payment-method-configuration';
import { EGP_CURRENCY, fromMinorUnits, toMinorUnits } from '../money.util';
import { CommissionService } from './commission.service';
import { PaymentProviderRegistry } from './payment-provider-registry.service';

export interface ProductSnapshot {
  itemType: ItemType;
  itemId: string;
  title: string;
  titleAr: string | null;
  teacherId: string;
  sellerName: string | null;
  priceMinor: number;
  accessDurationDays: number | null;
  discountItemId?: string;
  appointmentStartAt?: Date;
  appointmentEndAt?: Date;
}

/** Input accepted by the aggregate cart checkout; Books and sessions stay out of Cart. */
export interface CartCheckoutProductInput {
  cartItemId: string;
  itemType: ItemType.LESSON | ItemType.PACKAGE;
  itemId: string;
}

export interface CartCheckoutProduct extends ProductSnapshot {
  cartItemId: string;
}

interface DiscountSnapshot {
  id: string | null;
  amountMinor: number;
  snapshot: Record<string, unknown> | null;
}

interface InternalOrderPricing {
  finalAmountMinor: number;
  snapshot: Record<string, unknown>;
  skipOwnershipCheck: boolean;
  metadata: Record<string, unknown>;
}

export interface CheckoutQuote {
  product: {
    item_type: ItemType;
    item_id: string;
    title: string;
    title_ar: string | null;
    teacher_id: string;
    seller_name: string | null;
    access_duration_days: number | null;
  };
  pricing: {
    original_amount_minor: number;
    discount_amount_minor: number;
    final_amount_minor: number;
    currency: string;
  };
  channels: {
    activation_code: boolean;
    manual: Array<{
      id: string;
      name: string;
      type: ManualPaymentMethod['type'];
      minimum_amount_minor: number | null;
      maximum_amount_minor: number | null;
      currency: string;
      proof_required: boolean;
      transaction_reference_required: boolean;
    }>;
    gateway: Array<{
      name: string;
      supportsRefunds: boolean;
    }>;
  };
  discount: Record<string, unknown> | null;
}

@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order)
    private readonly orders: Repository<Order>,
    @InjectRepository(Payment)
    private readonly payments: Repository<Payment>,
    @InjectRepository(ManualPaymentMethod)
    private readonly manualMethods: Repository<ManualPaymentMethod>,
    @InjectRepository(Lesson)
    private readonly lessons: Repository<Lesson>,
    @InjectRepository(LessonPackage)
    private readonly packages: Repository<LessonPackage>,
    @InjectRepository(Book)
    private readonly books: Repository<Book>,
    @InjectRepository(Entitlement)
    private readonly entitlements: Repository<Entitlement>,
    @InjectRepository(LessonPurchase)
    private readonly lessonPurchases: Repository<LessonPurchase>,
    @InjectRepository(PackagePurchase)
    private readonly packagePurchases: Repository<PackagePurchase>,
    @InjectRepository(BookPurchase)
    private readonly bookPurchases: Repository<BookPurchase>,
    private readonly dataSource: DataSource,
    private readonly discounts: DiscountCodesService,
    private readonly commissions: CommissionService,
    private readonly providers: PaymentProviderRegistry,
    private readonly lessonSessions: LessonSessionsService,
  ) {}

  public async quote(dto: CheckoutQuoteDto, studentId: string): Promise<CheckoutQuote> {
    const product = await this.loadProduct(dto.item_type, dto.item_id);
    if (dto.item_type === ItemType.LESSON_SESSION) {
      await this.lessonSessions.assertCheckoutReservation(dto.booking_id, studentId, dto.item_id);
    } else if (dto.booking_id !== undefined) {
      throw new BadRequestException('booking_id is only valid for lesson sessions');
    }
    await this.assertNotOwned(studentId, product.itemType, product.itemId);
    const discount = await this.resolveDiscount(product, dto.discount_code, studentId);
    const finalAmountMinor = product.priceMinor - discount.amountMinor;
    this.assertChargeable(finalAmountMinor);
    const manual = await this.manualMethods.find({
      where: { enabled: true, currency: EGP_CURRENCY },
      order: { display_order: 'ASC', name: 'ASC' },
    });
    return {
      product: {
        item_type: product.itemType,
        item_id: product.itemId,
        title: product.title,
        title_ar: product.titleAr,
        teacher_id: product.teacherId,
        seller_name: product.sellerName,
        access_duration_days: product.accessDurationDays,
      },
      pricing: {
        original_amount_minor: product.priceMinor,
        discount_amount_minor: discount.amountMinor,
        final_amount_minor: finalAmountMinor,
        currency: EGP_CURRENCY,
      },
      channels: {
        activation_code: product.itemType !== ItemType.LESSON_SESSION,
        manual: manual
          .filter(
            (method) =>
              this.withinLimits(method, finalAmountMinor) &&
              (!product.appointmentStartAt ||
                this.lessonSessions.canPaymentWindowFit(
                  product.appointmentStartAt,
                  method.order_expiration_minutes,
                )),
          )
          .map((method) => ({
            id: method.id,
            name: method.name,
            type: method.type,
            minimum_amount_minor: method.minimum_amount_minor,
            maximum_amount_minor: method.maximum_amount_minor,
            currency: method.currency,
            proof_required: method.proof_required,
            transaction_reference_required: method.transaction_reference_required,
          })),
        gateway: this.providers
          .list()
          .filter(
            () =>
              !product.appointmentStartAt ||
              this.lessonSessions.canPaymentWindowFit(product.appointmentStartAt, 60),
          )
          .map((provider) => ({
            name: provider.name,
            supportsRefunds: provider.supportsRefunds,
          })),
      },
      discount: discount.snapshot,
    };
  }

  /**
   * Reuses the canonical product and ownership rules for the cart.  It runs
   * under the caller's transaction so checkout cannot rely on cart snapshots
   * or race a concurrent individual order for the same product.
   */
  public async prepareCartProducts(
    items: CartCheckoutProductInput[],
    studentId: string,
    manager: EntityManager,
  ): Promise<CartCheckoutProduct[]> {
    const seen = new Set<string>();
    const products: CartCheckoutProduct[] = [];
    for (const item of items) {
      const key = `${item.itemType}:${item.itemId}`;
      if (seen.has(key)) {
        throw new BadRequestException(
          biBody('Cart contains a duplicate product', 'تحتوي السلة على منتج مكرر'),
        );
      }
      seen.add(key);
      const product = await this.loadProduct(item.itemType, item.itemId, manager);
      await this.assertNotOwned(studentId, product.itemType, product.itemId, manager);
      await this.assertNoActiveOrder(manager, studentId, product.itemType, product.itemId);
      products.push({ ...product, cartItemId: item.cartItemId });
    }
    return products;
  }

  public async createOrder(
    dto: CreateOrderDto,
    studentId: string,
    internalPricing?: InternalOrderPricing,
  ): Promise<{ order: Order; payment: Payment }> {
    if (
      dto.payment_channel !== PaymentChannel.MANUAL &&
      dto.payment_channel !== PaymentChannel.GATEWAY
    ) {
      throw new BadRequestException(
        biBody(
          'Activation-code orders are created by code redemption',
          'يتم إنشاء طلب رمز التفعيل عند استرداد الرمز',
        ),
      );
    }

    const existing = dto.idempotency_key
      ? await this.payments.findOne({
          where: { user_id: studentId, idempotency_key: dto.idempotency_key },
        })
      : null;
    if (existing?.order_id) {
      const order = await this.orders.findOne({ where: { id: existing.order_id } });
      if (order) return { order, payment: existing };
    }

    const product = await this.loadProduct(dto.item_type, dto.item_id);
    if (dto.item_type === ItemType.LESSON_SESSION) {
      await this.lessonSessions.assertCheckoutReservation(dto.booking_id, studentId, dto.item_id);
    } else if (dto.booking_id !== undefined) {
      throw new BadRequestException('booking_id is only valid for lesson sessions');
    }
    if (!internalPricing?.skipOwnershipCheck) {
      await this.assertNotOwned(studentId, product.itemType, product.itemId);
    }
    const discount = internalPricing
      ? {
          id: null,
          amountMinor: product.priceMinor - internalPricing.finalAmountMinor,
          snapshot: internalPricing.snapshot,
        }
      : await this.resolveDiscount(product, dto.discount_code, studentId);
    const finalAmountMinor =
      internalPricing?.finalAmountMinor ?? product.priceMinor - discount.amountMinor;
    this.assertChargeable(finalAmountMinor);

    let method: ManualPaymentMethod | null = null;
    if (dto.payment_channel === PaymentChannel.MANUAL) {
      if (!dto.manual_payment_method_id) {
        throw new BadRequestException(
          biBody('A manual payment method is required', 'يجب اختيار طريقة دفع يدوي'),
        );
      }
      method = await this.manualMethods.findOne({
        where: {
          id: dto.manual_payment_method_id,
          enabled: true,
        },
      });
      if (
        !method ||
        method.currency !== EGP_CURRENCY ||
        !this.withinLimits(method, finalAmountMinor)
      ) {
        throw new BadRequestException(
          biBody(
            'Manual payment method is unavailable for this order',
            'طريقة الدفع اليدوي غير متاحة لهذا الطلب',
          ),
        );
      }
    }

    const commission = this.commissions.calculate(finalAmountMinor);
    const gatewayFee =
      dto.payment_channel === PaymentChannel.GATEWAY
        ? this.commissions.calculateGatewayFee(finalAmountMinor)
        : { gatewayFeeBps: 0, gatewayFeeMinor: 0 };
    const gatewayName = this.providers.getDefault().name;
    const idempotencyKey =
      dto.idempotency_key ??
      `order-${studentId}-${dto.item_type}-${dto.item_id}-${randomBytes(8).toString('hex')}`;

    try {
      return await retryTransaction(this.dataSource, async (manager) => {
        await this.assertNoActiveOrder(manager, studentId, dto.item_type, dto.item_id);
        const now = new Date();
        const normalExpiresAt = new Date(
          now.getTime() + (method?.order_expiration_minutes ?? 60) * 60 * 1000,
        );
        const expiresAt = product.appointmentStartAt
          ? new Date(
              Math.min(
                normalExpiresAt.getTime(),
                product.appointmentStartAt.getTime() - 60 * 60_000,
              ),
            )
          : normalExpiresAt;
        const order = manager.create(Order, {
          order_number: this.generateOrderNumber(),
          student_id: studentId,
          teacher_id: product.teacherId,
          item_type: product.itemType,
          item_id: product.itemId,
          quantity: 1,
          original_amount_minor: product.priceMinor,
          discount_amount_minor: discount.amountMinor,
          final_amount_minor: finalAmountMinor,
          refunded_amount_minor: 0,
          currency: EGP_CURRENCY,
          payment_channel: dto.payment_channel,
          payment_method:
            dto.payment_channel === PaymentChannel.GATEWAY ? gatewayName : (method?.id ?? null),
          status: OrderStatus.AWAITING_PAYMENT,
          discount_code_id: discount.id,
          activation_code_id: null,
          payment_id: null,
          collection_party:
            dto.payment_channel === PaymentChannel.GATEWAY
              ? CollectionParty.PLATFORM
              : (method?.collection_party ?? CollectionParty.UNKNOWN),
          product_title_snapshot: product.title,
          product_title_ar_snapshot: product.titleAr,
          seller_name_snapshot: product.sellerName,
          platform_commission_bps: commission.platformCommissionBps,
          platform_commission_minor: commission.platformCommissionMinor,
          teacher_earning_minor: commission.teacherEarningMinor,
          gateway_fee_bps: gatewayFee.gatewayFeeBps,
          gateway_fee_minor: gatewayFee.gatewayFeeMinor,
          discount_snapshot: discount.snapshot,
          metadata: {
            access_duration_days: product.accessDurationDays,
            manual_payment_method_id: method?.id ?? null,
            ...(product.discountItemId ? { parent_lesson_id: product.discountItemId } : {}),
            ...(product.appointmentStartAt
              ? { appointment_start_at: product.appointmentStartAt.toISOString() }
              : {}),
            ...(product.appointmentEndAt
              ? { appointment_end_at: product.appointmentEndAt.toISOString() }
              : {}),
            ...(internalPricing?.metadata ?? {}),
          },
          expires_at: expiresAt,
          paid_at: null,
          cancelled_at: null,
        });
        const savedOrder = await manager.save(Order, order);

        const payment = manager.create(Payment, {
          order_id: savedOrder.id,
          user_id: studentId,
          item_type: product.itemType,
          item_id: product.itemId,
          amount: fromMinorUnits(product.priceMinor),
          discount_amount: fromMinorUnits(discount.amountMinor),
          final_amount: fromMinorUnits(finalAmountMinor),
          amount_minor: finalAmountMinor,
          currency: EGP_CURRENCY,
          channel: dto.payment_channel,
          provider: dto.payment_channel === PaymentChannel.GATEWAY ? gatewayName : null,
          provider_reference: null,
          status: PaymentStatus.PENDING,
          payment_method:
            dto.payment_channel === PaymentChannel.GATEWAY
              ? PaymentMethod.CARD
              : PaymentMethod.MANUAL,
          paymob_order_id: null,
          paymob_transaction_id: null,
          idempotency_key: idempotencyKey,
          failure_reason: null,
          completed_at: null,
        });
        const savedPayment = await manager.save(Payment, payment);
        savedOrder.payment_id = savedPayment.id;
        await manager.save(Order, savedOrder);

        if (product.itemType === ItemType.LESSON_SESSION) {
          await this.lessonSessions.attachOrder(
            manager,
            dto.booking_id!,
            studentId,
            savedOrder,
            savedPayment,
            expiresAt,
          );
        }

        if (discount.id) {
          await this.discounts.applyDiscount(
            discount.id,
            studentId,
            savedPayment.id,
            fromMinorUnits(discount.amountMinor),
            manager,
            fromMinorUnits(product.priceMinor),
          );
        }

        return { order: savedOrder, payment: savedPayment };
      });
    } catch (error) {
      const dbError = error as { code?: string; constraint?: string };
      if (dbError.code === '23505') {
        throw new ConflictException(
          biBody('An active order for this item already exists', 'يوجد بالفعل طلب نشط لهذا العنصر'),
        );
      }
      throw error;
    }
  }

  public async createReopenOrder(
    lessonId: string,
    studentId: string,
  ): Promise<{ order: Order; payment: Payment }> {
    const expiredPurchase = await this.lessonPurchases.findOne({
      where: {
        student_id: studentId,
        lesson_id: lessonId,
        access_expires_at: LessThanOrEqual(new Date()),
        revoked_at: IsNull(),
      },
    });
    if (!expiredPurchase) {
      throw new BadRequestException(
        biBody(
          'You have not previously purchased this lesson or access is still active',
          'لم تشتر هذا الدرس من قبل أو أن صلاحية الوصول ما زالت سارية',
        ),
      );
    }
    const product = await this.loadProduct(ItemType.LESSON, lessonId);
    const finalAmountMinor = Math.round(product.priceMinor / 2);
    this.assertChargeable(finalAmountMinor);
    return this.createOrder(
      {
        item_type: ItemType.LESSON,
        item_id: lessonId,
        payment_channel: PaymentChannel.GATEWAY,
        idempotency_key: `reopen-${studentId}-${lessonId}-${expiredPurchase.id}`,
      },
      studentId,
      {
        finalAmountMinor,
        skipOwnershipCheck: true,
        snapshot: {
          kind: 'lesson_reopen',
          discount_percent: 50,
          discount_amount_minor: product.priceMinor - finalAmountMinor,
        },
        metadata: {
          purchase_mode: 'lesson_reopen',
          prior_purchase_id: expiredPurchase.id,
        },
      },
    );
  }

  public async createActivationCodeOrder(
    manager: EntityManager,
    code: AttendanceCode,
    studentId: string,
  ): Promise<{ order: Order; payment: Payment }> {
    const itemType = this.itemTypeFromCode(code);
    const product = await this.loadProduct(itemType, code.item_id, manager);
    const amountMinor = code.face_value_minor ?? product.priceMinor;
    this.assertChargeable(amountMinor);
    const commission = this.commissions.calculate(amountMinor, code.platform_commission_bps);
    await this.assertNoActiveOrder(manager, studentId, itemType, code.item_id);
    const order = await manager.save(
      Order,
      manager.create(Order, {
        order_number: this.generateOrderNumber(),
        student_id: studentId,
        teacher_id: code.teacher_id ?? product.teacherId,
        item_type: itemType,
        item_id: code.item_id,
        quantity: 1,
        original_amount_minor: amountMinor,
        discount_amount_minor: 0,
        final_amount_minor: amountMinor,
        refunded_amount_minor: 0,
        currency: code.currency || EGP_CURRENCY,
        payment_channel: PaymentChannel.ACTIVATION_CODE,
        payment_method: PaymentMethod.PURCHASE_CODE,
        status: OrderStatus.AWAITING_PAYMENT,
        discount_code_id: null,
        activation_code_id: code.id,
        payment_id: null,
        collection_party: code.collection_party,
        product_title_snapshot: product.title,
        product_title_ar_snapshot: product.titleAr,
        seller_name_snapshot: product.sellerName,
        platform_commission_bps: commission.platformCommissionBps,
        platform_commission_minor: commission.platformCommissionMinor,
        teacher_earning_minor: commission.teacherEarningMinor,
        gateway_fee_bps: 0,
        gateway_fee_minor: 0,
        discount_snapshot: null,
        metadata: {
          access_duration_days: product.accessDurationDays,
          code_batch_id: code.batch_id,
        },
        expires_at: code.expires_at,
        paid_at: null,
        cancelled_at: null,
      }),
    );
    const payment = await manager.save(
      Payment,
      manager.create(Payment, {
        order_id: order.id,
        user_id: studentId,
        item_type: itemType,
        item_id: code.item_id,
        amount: fromMinorUnits(amountMinor),
        discount_amount: 0,
        final_amount: fromMinorUnits(amountMinor),
        amount_minor: amountMinor,
        currency: code.currency || EGP_CURRENCY,
        channel: PaymentChannel.ACTIVATION_CODE,
        provider: null,
        provider_reference: code.id,
        status: PaymentStatus.PENDING,
        payment_method: PaymentMethod.PURCHASE_CODE,
        paymob_order_id: null,
        paymob_transaction_id: null,
        idempotency_key: `activation-code-${code.id}`,
        failure_reason: null,
        completed_at: null,
      }),
    );
    order.payment_id = payment.id;
    await manager.save(Order, order);
    return { order, payment };
  }

  public async startGatewayCheckout(
    orderId: string,
    studentId: string,
    dto: StartGatewayCheckoutDto,
  ): Promise<{
    order_id: string;
    order_number: string;
    payment_id: string;
    redirect_url: string;
    amount_minor: number;
    currency: string;
  }> {
    const claimed = await retryTransaction(this.dataSource, async (manager) => {
      const order = await manager.findOne(Order, {
        where: { id: orderId, student_id: studentId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!order || order.payment_channel !== PaymentChannel.GATEWAY || !order.payment_id) {
        throw new NotFoundException(
          biBody('Gateway order not found', 'طلب الدفع الإلكتروني غير موجود'),
        );
      }
      this.assertOrderPayable(order);

      const payment = await manager.findOne(Payment, {
        where: { id: order.payment_id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!payment) {
        throw new NotFoundException(biBody('Payment not found', 'عملية الدفع غير موجودة'));
      }

      if (payment.paymob_order_id !== null) {
        return { order, payment, providerReference: payment.paymob_order_id };
      }
      if (payment.status === PaymentStatus.PROCESSING) {
        throw new ConflictException(
          biBody(
            'Checkout is already being prepared',
            '\u062c\u0627\u0631\u064a \u062a\u062c\u0647\u064a\u0632 \u0627\u0644\u062f\u0641\u0639',
          ),
        );
      }
      if (![PaymentStatus.PENDING, PaymentStatus.FAILED].includes(payment.status)) {
        throw new ConflictException(
          biBody(
            'Payment cannot be started in its current state',
            '\u0644\u0627 \u064a\u0645\u0643\u0646 \u0628\u062f\u0621 \u0627\u0644\u062f\u0641\u0639 \u0628\u062d\u0627\u0644\u062a\u0647 \u0627\u0644\u062d\u0627\u0644\u064a\u0629',
          ),
        );
      }

      payment.status = PaymentStatus.PROCESSING;
      payment.failure_reason = null;
      await manager.save(Payment, payment);
      return { order, payment, providerReference: null };
    });

    const provider = this.providers.get(claimed.payment.provider);
    const checkoutInput = {
      paymentId: claimed.payment.id,
      orderId: claimed.order.id,
      orderNumber: claimed.order.order_number,
      amountMinor: claimed.order.final_amount_minor,
      currency: claimed.order.currency,
      billingData: dto.billing_data,
    };

    let providerReference = claimed.providerReference;
    if (providerReference === null) {
      const createdReference = await provider.createCheckoutOrder(checkoutInput);
      providerReference = await retryTransaction(this.dataSource, async (manager) => {
        const order = await manager.findOne(Order, {
          where: { id: orderId, student_id: studentId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!order || order.payment_channel !== PaymentChannel.GATEWAY || !order.payment_id) {
          throw new NotFoundException(
            biBody('Gateway order not found', 'طلب الدفع الإلكتروني غير موجود'),
          );
        }
        this.assertOrderPayable(order);

        const payment = await manager.findOne(Payment, {
          where: { id: order.payment_id },
          lock: { mode: 'pessimistic_write' },
        });
        if (!payment) {
          throw new NotFoundException(biBody('Payment not found', 'عملية الدفع غير موجودة'));
        }
        if (payment.paymob_order_id !== null) return payment.paymob_order_id;
        if (payment.status !== PaymentStatus.PROCESSING) {
          throw new ConflictException(
            biBody(
              'Payment cannot be started in its current state',
              '\u0644\u0627 \u064a\u0645\u0643\u0646 \u0628\u062f\u0621 \u0627\u0644\u062f\u0641\u0639 \u0628\u062d\u0627\u0644\u062a\u0647 \u0627\u0644\u062d\u0627\u0644\u064a\u0629',
            ),
          );
        }

        payment.provider_reference = createdReference;
        payment.paymob_order_id = createdReference;
        payment.failure_reason = null;
        await manager.save(Payment, payment);
        return createdReference;
      });
    }

    const checkout = await provider.createCheckoutSession(checkoutInput, providerReference);
    return {
      order_id: claimed.order.id,
      order_number: claimed.order.order_number,
      payment_id: claimed.payment.id,
      redirect_url: checkout.redirectUrl,
      amount_minor: claimed.order.final_amount_minor,
      currency: claimed.order.currency,
    };
  }

  public async getStudentOrder(
    orderId: string,
    studentId: string,
  ): Promise<Record<string, unknown>> {
    const order = await this.orders.findOne({
      where: { id: orderId, student_id: studentId },
    });
    if (!order) {
      throw new NotFoundException(biBody('Order not found', 'الطلب غير موجود'));
    }
    let manual_method: Record<string, unknown> | null = null;
    if (order.payment_channel === PaymentChannel.MANUAL) {
      const methodId = (order.metadata?.['manual_payment_method_id'] as string | null) ?? null;
      const method = methodId
        ? await this.manualMethods.findOne({ where: { id: methodId } })
        : null;
      if (method && this.isPayableStatus(order.status)) {
        manual_method = serializeManualPaymentMethodForStudent(method);
      }
    }
    return { ...order, manual_method };
  }

  public async getStudentOrders(
    studentId: string,
    filter: OrderFilterDto,
  ): Promise<{ data: Order[]; meta: PaginationMeta }> {
    return this.findOrders({ ...filter, student_id: studentId });
  }

  public async findOrders(
    filter: OrderFilterDto,
  ): Promise<{ data: Order[]; meta: PaginationMeta }> {
    const page = filter.page ?? 1;
    const limit = filter.limit ?? 20;
    const query = this.orders
      .createQueryBuilder('order')
      .leftJoinAndSelect('order.student', 'student')
      .leftJoinAndSelect('order.teacher', 'teacher');
    if (filter.student_id)
      query.andWhere('order.student_id = :studentId', { studentId: filter.student_id });
    if (filter.teacher_id)
      query.andWhere('order.teacher_id = :teacherId', { teacherId: filter.teacher_id });
    if (filter.status) query.andWhere('order.status = :status', { status: filter.status });
    if (filter.channel)
      query.andWhere('order.payment_channel = :channel', { channel: filter.channel });
    if (filter.item_type)
      query.andWhere('order.item_type = :itemType', { itemType: filter.item_type });
    if (filter.currency)
      query.andWhere('order.currency = :currency', { currency: filter.currency.toUpperCase() });
    if (filter.from) query.andWhere('order.created_at >= :from', { from: filter.from });
    if (filter.to) query.andWhere('order.created_at <= :to', { to: filter.to });
    if (filter.search?.trim()) {
      query.andWhere(
        '(order.order_number ILIKE :search OR order.product_title_snapshot ILIKE :search OR student.name ILIKE :search OR student.email ILIKE :search)',
        { search: `%${filter.search.trim()}%` },
      );
    }
    const [data, total] = await query
      .orderBy('order.created_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    const totalPages = Math.ceil(total / limit);
    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  }

  /**
   * Teacher finance responses intentionally avoid the admin order projection.
   * A teacher can identify the buyer by name for their own content, but never
   * receives contact details or other fields from the User entity.
   */
  public async findTeacherOrders(
    filter: OrderFilterDto,
  ): Promise<{ data: Order[]; meta: PaginationMeta }> {
    const page = filter.page ?? 1;
    const limit = filter.limit ?? 20;
    const query = this.teacherOrdersQuery(filter);
    const [data, total] = await query
      .orderBy('order.created_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    const totalPages = Math.ceil(total / limit);
    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  }

  public async findTeacherOrder(orderId: string, teacherId: string): Promise<Order> {
    const order = await this.teacherOrdersQuery({ teacher_id: teacherId })
      .andWhere('order.id = :orderId', { orderId })
      .getOne();
    if (!order) {
      throw new NotFoundException(biBody('Order not found', 'Ø§Ù„Ø·Ù„Ø¨ ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯'));
    }
    return order;
  }

  private teacherOrdersQuery(filter: Partial<OrderFilterDto>) {
    const query = this.orders
      .createQueryBuilder('order')
      .leftJoin('order.student', 'student')
      .select('order')
      .addSelect(['student.id', 'student.name']);
    if (filter.teacher_id)
      query.andWhere('order.teacher_id = :teacherId', { teacherId: filter.teacher_id });
    if (filter.status) query.andWhere('order.status = :status', { status: filter.status });
    if (filter.channel)
      query.andWhere('order.payment_channel = :channel', { channel: filter.channel });
    if (filter.item_type)
      query.andWhere('order.item_type = :itemType', { itemType: filter.item_type });
    if (filter.currency)
      query.andWhere('order.currency = :currency', { currency: filter.currency.toUpperCase() });
    if (filter.from) query.andWhere('order.created_at >= :from', { from: filter.from });
    if (filter.to) query.andWhere('order.created_at <= :to', { to: filter.to });
    if (filter.search?.trim()) {
      query.andWhere(
        '(order.order_number ILIKE :search OR order.product_title_snapshot ILIKE :search OR student.name ILIKE :search)',
        { search: `%${filter.search.trim()}%` },
      );
    }
    return query;
  }

  private async loadProduct(
    itemType: ItemType,
    itemId: string,
    manager?: EntityManager,
  ): Promise<ProductSnapshot> {
    const users = manager?.getRepository(User) ?? this.dataSource.getRepository(User);
    if (itemType === ItemType.LESSON) {
      const repository = manager?.getRepository(Lesson) ?? this.lessons;
      const lesson = await repository.findOne({ where: { id: itemId, deleted_at: IsNull() } });
      if (!lesson) throw new NotFoundException(biBody('Lesson not found', 'الدرس غير موجود'));
      if (!lesson.is_group) {
        throw new BadRequestException(
          biBody(
            'Choose an appointment before purchasing an Individual lesson',
            'اختر موعدًا قبل شراء الدرس الفردي',
          ),
        );
      }
      const seller = await users.findOne({ where: { id: lesson.teacher_id } });
      return {
        itemType,
        itemId,
        title: lesson.title,
        titleAr: null,
        teacherId: lesson.teacher_id,
        sellerName: seller?.name ?? null,
        priceMinor: toMinorUnits(lesson.price),
        accessDurationDays: lesson.available_for_days,
      };
    }
    if (itemType === ItemType.LESSON_SESSION) {
      const { session, lesson } = await this.lessonSessions.getCheckoutProduct(itemId, manager);
      const seller = await users.findOne({ where: { id: lesson.teacher_id } });
      return {
        itemType,
        itemId,
        title: `${lesson.title} - ${session.start_at.toISOString()}`,
        titleAr: null,
        teacherId: lesson.teacher_id,
        sellerName: seller?.name ?? null,
        priceMinor: toMinorUnits(lesson.price),
        accessDurationDays: lesson.available_for_days,
        discountItemId: lesson.id,
        appointmentStartAt: session.start_at,
        appointmentEndAt: session.end_at,
      };
    }
    if (itemType === ItemType.PACKAGE) {
      const repository = manager?.getRepository(LessonPackage) ?? this.packages;
      const pkg = await repository.findOne({
        where: { id: itemId, deleted_at: IsNull(), is_active: true },
      });
      if (!pkg) throw new NotFoundException(biBody('Package not found', 'الباقة غير موجودة'));
      const containsIndividual = (await (manager ?? this.dataSource.manager).query(
        `SELECT 1
           FROM lesson_package_items item
           JOIN lessons lesson ON lesson.id = item.lesson_id
          WHERE item.package_id = $1 AND lesson.is_group = false
          LIMIT 1`,
        [pkg.id],
      )) as unknown[];
      if (containsIndividual.length > 0) {
        throw new BadRequestException(
          biBody(
            'This package contains an Individual lesson and is unavailable for new purchases',
            'تحتوي هذه الباقة على درس فردي، لذلك لا يمكن شراؤها حاليًا',
          ),
        );
      }
      const seller = await users.findOne({ where: { id: pkg.teacher_id } });
      return {
        itemType,
        itemId,
        title: pkg.title,
        titleAr: pkg.title_ar,
        teacherId: pkg.teacher_id,
        sellerName: seller?.name ?? null,
        priceMinor: toMinorUnits(pkg.price),
        accessDurationDays: null,
      };
    }
    const repository = manager?.getRepository(Book) ?? this.books;
    const book = await repository.findOne({ where: { id: itemId, deleted_at: IsNull() } });
    if (!book) throw new NotFoundException(biBody('Book not found', 'الكتاب غير موجود'));
    const seller = await users.findOne({ where: { id: book.teacher_id } });
    return {
      itemType,
      itemId,
      title: book.title,
      titleAr: book.title_ar,
      teacherId: book.teacher_id,
      sellerName: seller?.name ?? null,
      priceMinor: toMinorUnits(book.price),
      accessDurationDays: null,
    };
  }

  private async resolveDiscount(
    product: ProductSnapshot,
    code: string | undefined,
    studentId: string,
  ): Promise<DiscountSnapshot> {
    if (!code?.trim()) return { id: null, amountMinor: 0, snapshot: null };
    const applicable = {
      [ItemType.LESSON]: ApplicableItem.LESSON,
      [ItemType.LESSON_SESSION]: ApplicableItem.LESSON,
      [ItemType.PACKAGE]: ApplicableItem.PACKAGE,
      [ItemType.BOOK]: ApplicableItem.BOOK,
    }[product.itemType];
    const result = await this.discounts.verifyCode(
      {
        code,
        item_type: applicable,
        item_id: product.discountItemId ?? product.itemId,
        amount: fromMinorUnits(product.priceMinor),
      },
      studentId,
    );
    if (!result.valid || !result.discount_code_id) {
      throw new BadRequestException(
        result.error ?? biBody('Discount code is invalid', 'رمز الخصم غير صالح'),
      );
    }
    const amountMinor = toMinorUnits(result.discount_amount ?? 0);
    return {
      id: result.discount_code_id,
      amountMinor: Math.min(amountMinor, product.priceMinor),
      snapshot: {
        code: code.trim().toUpperCase(),
        discount_code_id: result.discount_code_id,
        discount_amount_minor: Math.min(amountMinor, product.priceMinor),
      },
    };
  }

  private async assertNotOwned(
    studentId: string,
    itemType: ItemType,
    itemId: string,
    manager?: EntityManager,
  ): Promise<void> {
    const entitlements = manager?.getRepository(Entitlement) ?? this.entitlements;
    const lessonPurchases = manager?.getRepository(LessonPurchase) ?? this.lessonPurchases;
    const packagePurchases = manager?.getRepository(PackagePurchase) ?? this.packagePurchases;
    const bookPurchases = manager?.getRepository(BookPurchase) ?? this.bookPurchases;
    const entitlement = await entitlements.findOne({
      where: [
        {
          student_id: studentId,
          item_type: itemType,
          item_id: itemId,
          status: EntitlementStatus.ACTIVE,
          expires_at: IsNull(),
        },
        {
          student_id: studentId,
          item_type: itemType,
          item_id: itemId,
          status: EntitlementStatus.ACTIVE,
          expires_at: MoreThan(new Date()),
        },
      ],
    });
    let legacyOwned = false;
    if (itemType === ItemType.LESSON) {
      legacyOwned = Boolean(
        await lessonPurchases.findOne({
          where: {
            student_id: studentId,
            lesson_id: itemId,
            access_expires_at: MoreThan(new Date()),
            revoked_at: IsNull(),
          },
        }),
      );
    } else if (itemType === ItemType.PACKAGE) {
      legacyOwned = Boolean(
        await packagePurchases.findOne({
          where: { student_id: studentId, package_id: itemId, revoked_at: IsNull() },
        }),
      );
    } else if (itemType === ItemType.BOOK) {
      legacyOwned = Boolean(
        await bookPurchases.findOne({
          where: { student_id: studentId, book_id: itemId, revoked_at: IsNull() },
        }),
      );
    }
    if (entitlement || legacyOwned) {
      throw new ConflictException(
        biBody('You already have access to this item', 'لديك بالفعل صلاحية الوصول إلى هذا العنصر'),
      );
    }
  }

  private async assertNoActiveOrder(
    manager: EntityManager,
    studentId: string,
    itemType: ItemType,
    itemId: string,
  ): Promise<void> {
    const existing = await manager
      .getRepository(Order)
      .createQueryBuilder('order')
      .setLock('pessimistic_write')
      .where('order.student_id = :studentId', { studentId })
      .andWhere('order.item_type = :itemType', { itemType })
      .andWhere('order.item_id = :itemId', { itemId })
      .andWhere("order.status IN ('awaiting_payment','payment_submitted','under_review')")
      .getOne();
    if (!existing) return;
    if (existing.expires_at && existing.expires_at <= new Date()) {
      existing.status = OrderStatus.EXPIRED;
      await manager.save(Order, existing);
      if (existing.payment_id) {
        await manager.update(Payment, existing.payment_id, { status: PaymentStatus.EXPIRED });
        await this.discounts.releaseUsageForPayment(existing.payment_id, manager);
      }
      return;
    }
    throw new ConflictException(
      biBody('An active order for this item already exists', 'يوجد بالفعل طلب نشط لهذا العنصر'),
    );
  }

  private itemTypeFromCode(code: AttendanceCode): ItemType {
    if (code.type === 'lesson') return ItemType.LESSON;
    if (code.type === 'package') return ItemType.PACKAGE;
    return ItemType.BOOK;
  }

  private assertChargeable(amountMinor: number): void {
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      throw new BadRequestException(
        biBody('Order total must be greater than zero', 'يجب أن يكون إجمالي الطلب أكبر من صفر'),
      );
    }
  }

  private withinLimits(method: ManualPaymentMethod, amountMinor: number): boolean {
    return (
      (method.minimum_amount_minor === null || amountMinor >= method.minimum_amount_minor) &&
      (method.maximum_amount_minor === null || amountMinor <= method.maximum_amount_minor)
    );
  }

  private generateOrderNumber(): string {
    const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    return `LX-${day}-${randomBytes(5).toString('hex').toUpperCase()}`;
  }

  private assertOrderPayable(order: Order): void {
    if (!this.isPayableStatus(order.status)) {
      throw new ConflictException(biBody('Order is not payable', 'الطلب غير متاح للدفع'));
    }
    if (order.expires_at && order.expires_at <= new Date()) {
      throw new ConflictException(biBody('Order has expired', 'انتهت صلاحية الطلب'));
    }
  }

  private isPayableStatus(status: OrderStatus): boolean {
    return [
      OrderStatus.AWAITING_PAYMENT,
      OrderStatus.PAYMENT_SUBMITTED,
      OrderStatus.UNDER_REVIEW,
    ].includes(status);
  }
}
