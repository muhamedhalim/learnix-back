import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import type { PaginationMeta } from '../../common/interfaces/pagination.interface';
import { getMarketplaceConfig } from '../../config/marketplace.config';
import { CatalogQueryService } from '../discovery/catalog-query.service';
import { MarketplaceOrderStatus } from '../common/enums';
import { Payment } from '../../payments/entities/payment.entity';
import { PaymentStatus } from '../../payments/entities/payment-status.enum';
import {
  courseIsFree,
  courseNotPurchasable,
  orderAlreadyOpen,
  selfPurchaseNotAllowed,
} from '../common/errors';
import { MarketplaceOrderCreatedEvent } from '../events/domain.events';
import { MarketplaceCommissionService } from '../earnings/commission.service';
import { MarketplaceOrder } from './entities';

const POSTGRES_UNIQUE_VIOLATION = '23505';

/** An `awaiting_payment` order older than this whose payment never went through no longer blocks a new attempt. */
const STALE_ORDER_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * FR-093 – FR-098. A `MarketplaceOrder` is the full commercial snapshot of
 * one purchase intent — commission scope/rate and refund terms are all
 * captured here at creation, so later administrative changes to either
 * never alter an order already placed (FR-134, FR-180). This service only
 * ever creates the order row; taking payment (T097) and turning a paid
 * order into access (T098) are separate concerns.
 */
@Injectable()
export class MarketplaceOrderService {
  constructor(
    @InjectRepository(MarketplaceOrder)
    private readonly orders: Repository<MarketplaceOrder>,
    private readonly catalogQuery: CatalogQueryService,
    private readonly commission: MarketplaceCommissionService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * FR-103: the course must be `published` (and its instructor `approved`,
   * FR-062) at the moment the order is *created* — reuses
   * `CatalogQueryService.baseVisibleQuery()`, the one place that predicate
   * lives, rather than re-deriving it. Once an order exists, its later
   * settlement is unaffected by the course being unpublished afterwards
   * (T100) — this method is only ever the creation gate.
   */
  public async createOrder(
    learnerId: string,
    courseId: string,
    initialStatus: MarketplaceOrderStatus = MarketplaceOrderStatus.AWAITING_PAYMENT,
    options: { allowFree?: boolean } = {},
  ): Promise<MarketplaceOrder> {
    const course = await this.catalogQuery
      .baseVisibleQuery()
      .andWhere('course.id = :id', { id: courseId })
      .getOne();
    if (!course) {
      throw courseNotPurchasable();
    }
    if (course.instructor.user_id === learnerId) {
      throw selfPurchaseNotAllowed();
    }
    // MP-17: a free course has nothing to charge; only the free-enrollment flow may open an order for one.
    if (course.price_minor === 0 && !options.allowFree) {
      throw courseIsFree();
    }

    const existing = await this.orders
      .createQueryBuilder('o')
      .where('o.learner_id = :learnerId', { learnerId })
      .andWhere('o.course_id = :courseId', { courseId })
      .andWhere("o.status IN ('awaiting_payment', 'paid')")
      .getOne();
    if (existing && !(await this.expireIfAbandoned(existing))) {
      throw orderAlreadyOpen();
    }

    const resolution = await this.commission.resolveEffectiveRate(course.currency);
    const breakdown = this.commission.calculate(course.price_minor, resolution.rateBps);
    const config = getMarketplaceConfig();

    const order = this.orders.create({
      order_number: this.generateOrderNumber(),
      learner_id: learnerId,
      course_id: course.id,
      course_version_id: course.current_version_id!,
      instructor_id: course.instructor_id,
      gross_amount_minor: course.price_minor,
      discount_amount_minor: 0,
      net_amount_minor: course.price_minor,
      currency: course.currency,
      commission_bps: resolution.rateBps,
      commission_scope: resolution.scope,
      commission_amount_minor: breakdown.platformCommissionMinor,
      instructor_earning_minor: breakdown.teacherEarningMinor,
      refund_window_days: config.refundWindowDays,
      consumption_cap_bps: config.refundConsumptionCapBps,
      status: initialStatus,
      is_zero_value: course.price_minor === 0,
      course_title_snapshot: course.title,
      instructor_name_snapshot: course.instructor.display_name,
      paid_at: initialStatus === MarketplaceOrderStatus.PAID ? new Date() : null,
    });

    let saved: MarketplaceOrder;
    try {
      saved = await this.orders.save(order);
    } catch (error) {
      const dbError = error as { code?: string };
      if (dbError.code === POSTGRES_UNIQUE_VIOLATION) {
        // A concurrent request won the race between the check above and this insert.
        throw orderAlreadyOpen();
      }
      throw error;
    }

    this.eventEmitter.emit(
      MarketplaceOrderCreatedEvent.EVENT_NAME,
      new MarketplaceOrderCreatedEvent(saved.id, learnerId, courseId),
    );
    return saved;
  }

  /**
   * MP-17: an unpaid order otherwise blocks the learner from ever buying again. Only an order that is
   * old AND whose payment either never started or ended unsuccessfully is closed; one with a payment
   * still in flight (or captured) is left alone so a late webhook can still settle it.
   */
  private async expireIfAbandoned(existing: MarketplaceOrder): Promise<boolean> {
    if (existing.status !== MarketplaceOrderStatus.AWAITING_PAYMENT) return false;
    if (
      !(existing.created_at instanceof Date) ||
      Date.now() - existing.created_at.getTime() < STALE_ORDER_AFTER_MS
    )
      return false;
    if (existing.payment_id) {
      const payment = await this.orders.manager.findOne(Payment, {
        where: { id: existing.payment_id },
      });
      if (
        payment &&
        payment.status !== PaymentStatus.FAILED &&
        payment.status !== PaymentStatus.EXPIRED
      )
        return false;
    }
    const result = await this.orders.update(
      { id: existing.id, status: MarketplaceOrderStatus.AWAITING_PAYMENT },
      { status: MarketplaceOrderStatus.EXPIRED },
    );
    return (result.affected ?? 0) > 0;
  }

  public async getOwnOrder(learnerId: string, orderId: string): Promise<MarketplaceOrder | null> {
    return this.orders.findOne({ where: { id: orderId, learner_id: learnerId } });
  }

  /** The learner's own orders, newest first, one bounded page (T095): `{ data, meta }` with the filtered total. */
  public async listOwnOrders(
    learnerId: string,
    status?: MarketplaceOrderStatus,
    page = 1,
    limit = 20,
  ): Promise<{ data: MarketplaceOrder[]; meta: PaginationMeta }> {
    const [data, total] = await this.orders.findAndCount({
      where: status ? { learner_id: learnerId, status } : { learner_id: learnerId },
      // `id` breaks created_at ties so consecutive pages never overlap or skip a row.
      order: { created_at: 'DESC', id: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    const totalPages = Math.ceil(total / limit);
    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  }

  private generateOrderNumber(): string {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = randomBytes(3).toString('hex').toUpperCase();
    return `MP-${timestamp}-${random}`;
  }
}
