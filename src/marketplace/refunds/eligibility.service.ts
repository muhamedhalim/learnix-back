import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { biBody } from '../../i18n/error-translator.util';
import { MarketplaceEnrollment, MarketplaceOrder } from '../commerce/entities';
import { MarketplaceOrderStatus } from '../common/enums';
import { MARKETPLACE_ERROR_CODES, MarketplaceErrorCode } from '../common/errors';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface RefundEligibilityVerdict {
  eligible: boolean;
  failedCondition: MarketplaceErrorCode | null;
  windowDays: number;
  capBps: number;
  elapsedDays: number;
  daysRemaining: number;
  progressBps: number;
}

/**
 * FR-179, FR-180, FR-185. Every figure here is read from the order's own
 * snapshot (`refund_window_days`, `consumption_cap_bps`, captured at
 * checkout) rather than the platform's current config, so a later config
 * change never retroactively changes what an already-paid order is entitled
 * to. Both boundaries are applied identically whether this runs at request
 * time or at processing time (FR-185) — the caller decides which
 * `progressBps`/`now` to pass in.
 */
@Injectable()
export class RefundEligibilityService {
  constructor(
    @InjectRepository(MarketplaceOrder) private readonly orders: Repository<MarketplaceOrder>,
    @InjectRepository(MarketplaceEnrollment)
    private readonly enrollments: Repository<MarketplaceEnrollment>,
  ) {}

  /**
   * Pure boundary evaluation — no I/O — so the day-14/instant-later and
   * 2999/3000-bps edges can be asserted exhaustively at the unit level.
   */
  public evaluate(
    order: MarketplaceOrder,
    progressBps: number,
    now: Date = new Date(),
  ): RefundEligibilityVerdict {
    const windowDays = order.refund_window_days;
    const capBps = order.consumption_cap_bps;

    if (order.is_zero_value || !order.paid_at) {
      return {
        eligible: false,
        failedCondition: MARKETPLACE_ERROR_CODES.NOTHING_TO_REFUND,
        windowDays,
        capBps,
        elapsedDays: 0,
        daysRemaining: 0,
        progressBps,
      };
    }

    const paidAtMs = order.paid_at.getTime();
    const nowMs = now.getTime();
    const windowEndMs = paidAtMs + windowDays * MS_PER_DAY;
    const elapsedDays = Math.max(0, Math.floor((nowMs - paidAtMs) / MS_PER_DAY));
    // Inclusive of the window's final instant (FR-179): request_time <= paid_at + window.
    const withinWindow = nowMs <= windowEndMs;
    const daysRemaining = withinWindow
      ? Math.max(0, Math.ceil((windowEndMs - nowMs) / MS_PER_DAY))
      : 0;
    // Exclusive cap (FR-178): the cap value itself already disqualifies.
    const underCap = progressBps < capBps;

    if (!withinWindow) {
      return {
        eligible: false,
        failedCondition: MARKETPLACE_ERROR_CODES.REFUND_WINDOW_EXPIRED,
        windowDays,
        capBps,
        elapsedDays,
        daysRemaining,
        progressBps,
      };
    }
    if (!underCap) {
      return {
        eligible: false,
        failedCondition: MARKETPLACE_ERROR_CODES.REFUND_CONSUMPTION_EXCEEDED,
        windowDays,
        capBps,
        elapsedDays,
        daysRemaining,
        progressBps,
      };
    }
    return {
      eligible: true,
      failedCondition: null,
      windowDays,
      capBps,
      elapsedDays,
      daysRemaining,
      progressBps,
    };
  }

  /** Ownership-scoped so a foreign order id is indistinguishable from a nonexistent one (IDOR). */
  public async checkEligibility(
    learnerId: string,
    orderId: string,
  ): Promise<RefundEligibilityVerdict> {
    const order = await this.orders.findOne({ where: { id: orderId, learner_id: learnerId } });
    if (!order) {
      throw new NotFoundException(biBody('Order not found', 'الطلب غير موجود'));
    }
    const enrollment = await this.enrollments.findOne({ where: { order_id: orderId } });
    const progressBps = enrollment?.progress_bps ?? 0;
    return this.evaluate(order, progressBps);
  }

  /** Used internally once an order/enrollment pair is already loaded (avoids a second query). */
  public evaluateForOrder(
    order: MarketplaceOrder,
    enrollment: MarketplaceEnrollment,
    now?: Date,
  ): RefundEligibilityVerdict {
    if (order.status !== MarketplaceOrderStatus.PAID) {
      return {
        eligible: false,
        failedCondition: MARKETPLACE_ERROR_CODES.NOTHING_TO_REFUND,
        windowDays: order.refund_window_days,
        capBps: order.consumption_cap_bps,
        elapsedDays: 0,
        daysRemaining: 0,
        progressBps: enrollment.progress_bps,
      };
    }
    return this.evaluate(order, enrollment.progress_bps, now);
  }
}
