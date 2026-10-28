import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, MoreThan, Repository } from 'typeorm';

import { retryTransaction } from '../../common/utils/transaction-retry.util';
import { CatalogQueryService } from '../discovery/catalog-query.service';
import { MarketplaceOrderStatus } from '../common/enums';
import { courseNotFree, courseNotPurchasable, freeEnrollmentRateLimited } from '../common/errors';
import { MarketplaceOrderService } from './order.service';
import { MarketplaceSettlementService } from './settlement.service';
import { MarketplaceOrder } from './entities';

/** FR-121 — 10 successful free enrollments per rolling 24 hours per account. The per-minute (5/min) request cap is enforced separately, at the route, by `PerAccountThrottlerGuard`. */
const DAILY_FREE_ENROLLMENT_CAP = 10;

/**
 * FR-111 – FR-113. The order is created exactly the same way a paid one is
 * (`MarketplaceOrderService.createOrder()` — same published-course gate,
 * same self-purchase and duplicate-open-order refusals) and then settled
 * immediately with no gateway interaction at all (`MarketplaceSettlementService.settleFree()`),
 * which is what makes "zero-value order created and settled" true without
 * a second, parallel creation path to keep in sync with the paid one.
 */
@Injectable()
export class FreeEnrollmentService {
  constructor(
    private readonly orders: MarketplaceOrderService,
    private readonly settlement: MarketplaceSettlementService,
    private readonly catalogQuery: CatalogQueryService,
    private readonly dataSource: DataSource,
    @InjectRepository(MarketplaceOrder)
    private readonly ordersRepo: Repository<MarketplaceOrder>,
  ) {}

  public async enrollFree(learnerId: string, courseId: string): Promise<MarketplaceOrder> {
    await this.assertDailyCapNotExceeded(learnerId);
    await this.assertCourseIsFree(courseId);

    const order = await this.orders.createOrder(learnerId, courseId, MarketplaceOrderStatus.AWAITING_PAYMENT, { allowFree: true });

    try {
      await retryTransaction(this.dataSource, (manager) => this.settlement.settleFree(order.id, manager));
    } catch (error) {
      // MP-17: the order and its settlement are separate transactions; a failed settlement must not
      // leave an `awaiting_payment` zero-value order that answers 409 to every later attempt.
      await this.ordersRepo.update(
        { id: order.id, status: MarketplaceOrderStatus.AWAITING_PAYMENT },
        { status: MarketplaceOrderStatus.CANCELLED },
      );
      throw error;
    }

    return this.ordersRepo.findOneOrFail({ where: { id: order.id } });
  }

  /**
   * Checked before `createOrder()` runs at all — refusing here, rather than
   * leaving it to `settleFree()`'s own defense-in-depth guard, is what
   * keeps a mistaken call against a paid course from leaving behind a
   * stray `awaiting_payment` order that would then block the learner's own
   * later, legitimate purchase via `UQ_mp_orders_open_per_course`.
   */
  private async assertCourseIsFree(courseId: string): Promise<void> {
    const course = await this.catalogQuery.baseVisibleQuery().andWhere('course.id = :id', { id: courseId }).getOne();
    if (!course) {
      throw courseNotPurchasable();
    }
    if (course.price_minor !== 0) {
      throw courseNotFree();
    }
  }

  /** FR-121's daily half — derived from `marketplace_orders` itself (no separate counter to keep consistent with it). */
  private async assertDailyCapNotExceeded(learnerId: string): Promise<void> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const count = await this.ordersRepo.count({
      where: {
        learner_id: learnerId,
        is_zero_value: true,
        status: MarketplaceOrderStatus.PAID,
        created_at: MoreThan(since),
      },
    });
    if (count >= DAILY_FREE_ENROLLMENT_CAP) {
      throw freeEnrollmentRateLimited('per_day');
    }
  }
}
