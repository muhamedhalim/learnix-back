import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { MarketplaceOrderStatus, PayoutRequestStatus, RefundRequestStatus } from '../common/enums';
import { MarketplaceOrder } from '../commerce/entities';
import { MarketplacePayoutRequest } from '../payouts/entities';
import { MarketplaceRefundRequest } from '../refunds/entities';

export interface ReportingDateRange {
  from?: Date;
  to?: Date;
}

export interface RevenueSummary {
  currency: string;
  grossAmountMinor: number;
  discountAmountMinor: number;
  netAmountMinor: number;
  commissionAmountMinor: number;
  instructorEarningMinor: number;
}

export interface AcquisitionSummary {
  totalEnrollments: number;
  paidEnrollments: number;
  freeEnrollments: number;
}

/** FR-229: identical shape to `RevenueSummary`, scoped to one instructor. */
export type InstructorEarningsReport = RevenueSummary & { instructorId: string };

export interface CourseRevenueReport {
  courseId: string;
  currency: string;
  grossAmountMinor: number;
  netAmountMinor: number;
  refundedAmountMinor: number;
  netRevenueMinor: number;
}

export interface PayoutReport {
  currency: string;
  requestedAmountMinor: number;
  paidAmountMinor: number;
  rejectedAmountMinor: number;
  reversedAmountMinor: number;
}

export interface RefundReportRow {
  refundId: string;
  orderId: string;
  currency: string;
  amountMinor: number;
  completedAt: string;
  originalSalePeriod: string;
}

/**
 * T113 (extended by T186). FR-115/FR-116/FR-228's split is structural, not
 * a query convention this service has to remember to apply consistently:
 * revenue figures always filter `is_zero_value = false` (backed by the
 * partial `IDX_mp_orders_revenue` index, built for exactly this query, per
 * plan.md §Commerce), while enrollment/acquisition/conversion figures never
 * filter on it at all — a zero-value order is a real acquisition, just one
 * with no revenue attached. Both read `marketplace_orders` directly
 * (1:1 with `marketplace_enrollments` via `UQ_mp_enrollments_order`) rather
 * than joining the enrollment table, since every field either figure needs
 * already lives on the order snapshot.
 *
 * FR-229's "reconciles exactly to that instructor's orders and ledger
 * entries" needs no separate ledger-side computation here — `COURSE_SALE`/
 * `PLATFORM_COMMISSION` ledger entries are posted atomically with earning
 * creation (`SettlementService.grantAccess()`, guarded independently by
 * `ReconciliationService.earningsMissingSaleEntry()`, T165), so an
 * order-derived per-instructor summary already reconciles to the ledger by
 * construction — computing it a second way here would only risk the two
 * *disagreeing* through a bug in one of the two paths, not add confidence.
 *
 * FR-235 ("never silently combine marketplace and academic figures") holds
 * structurally: nothing in this service (or `money-trail.service.ts`,
 * `overview.service.ts`) reads any academic table — confirmed by search, no
 * `Settlement`/`teacher_settlements` import exists anywhere under
 * `marketplace/admin/`.
 */
@Injectable()
export class MarketplaceReportingService {
  constructor(
    @InjectRepository(MarketplaceOrder)
    private readonly orders: Repository<MarketplaceOrder>,
    @InjectRepository(MarketplaceRefundRequest)
    private readonly refunds: Repository<MarketplaceRefundRequest>,
    @InjectRepository(MarketplacePayoutRequest)
    private readonly payoutRequests: Repository<MarketplacePayoutRequest>,
  ) {}

  /** FR-115, FR-228: gross/discount/net/commission/instructor-earning, always excluding zero-value orders. */
  public async getRevenueSummary(currency: string, range: ReportingDateRange = {}): Promise<RevenueSummary> {
    const qb = this.paidOrdersQuery(range)
      .andWhere('o.currency = :currency', { currency })
      .andWhere('o.is_zero_value = false');

    return this.sumOrderFigures(qb, currency);
  }

  /** FR-116, FR-228: enrollment/acquisition counts, always including zero-value orders. */
  public async getAcquisitionSummary(range: ReportingDateRange = {}): Promise<AcquisitionSummary> {
    const total = await this.paidOrdersQuery(range).getCount();
    const free = await this.paidOrdersQuery(range).andWhere('o.is_zero_value = true').getCount();
    return { totalEnrollments: total, paidEnrollments: total - free, freeEnrollments: free };
  }

  /** FR-229: per-instructor earnings, same figures and same zero-value exclusion as the platform summary. */
  public async getInstructorEarningsReport(
    instructorId: string,
    currency: string,
    range: ReportingDateRange = {},
  ): Promise<InstructorEarningsReport> {
    const qb = this.paidOrdersQuery(range)
      .andWhere('o.instructor_id = :instructorId', { instructorId })
      .andWhere('o.currency = :currency', { currency })
      .andWhere('o.is_zero_value = false');

    const summary = await this.sumOrderFigures(qb, currency);
    return { instructorId, ...summary };
  }

  /** FR-230: sales, refunds and net revenue for one course. "Net revenue" is sales net of refunds — a distinct figure from commission-net. */
  public async getCourseRevenueReport(
    courseId: string,
    currency: string,
    range: ReportingDateRange = {},
  ): Promise<CourseRevenueReport> {
    const salesQb = this.paidOrdersQuery(range)
      .andWhere('o.course_id = :courseId', { courseId })
      .andWhere('o.currency = :currency', { currency })
      .andWhere('o.is_zero_value = false');
    const { gross, net } = (await salesQb
      .select('COALESCE(SUM(o.gross_amount_minor), 0)', 'gross')
      .addSelect('COALESCE(SUM(o.net_amount_minor), 0)', 'net')
      .getRawOne<{ gross: string; net: string }>()) ?? { gross: '0', net: '0' };

    // FR-236: refunds counted in the period they *completed*, joined against
    // the order to scope by course/currency and to reach the refunded amount
    // (a refund carries no amount of its own — this system has no partial
    // refunds, so the refunded amount is always the original order's net).
    const refundedQb = this.completedRefundsQuery(range)
      .innerJoin(MarketplaceOrder, 'ro', 'ro.id = r.order_id')
      .andWhere('ro.course_id = :courseId', { courseId })
      .andWhere('ro.currency = :currency', { currency });
    const { refunded } = (await refundedQb
      .select('COALESCE(SUM(ro.net_amount_minor), 0)', 'refunded')
      .getRawOne<{ refunded: string }>()) ?? { refunded: '0' };

    const grossAmountMinor = Number.parseInt(gross, 10);
    const netAmountMinor = Number.parseInt(net, 10);
    const refundedAmountMinor = Number.parseInt(refunded, 10);

    return {
      courseId,
      currency,
      grossAmountMinor,
      netAmountMinor,
      refundedAmountMinor,
      netRevenueMinor: netAmountMinor - refundedAmountMinor,
    };
  }

  /**
   * FR-231: requested / paid / rejected / reversed amounts, each counted in
   * the period the corresponding event actually happened — a request's
   * *creation* period for "requested", its own decision timestamp for the
   * other three — matching FR-236's "report in the period it completed"
   * philosophy applied to payouts.
   */
  public async getPayoutReport(currency: string, range: ReportingDateRange = {}): Promise<PayoutReport> {
    const base = () => {
      const qb = this.payoutRequests.createQueryBuilder('p').where('p.currency = :currency', { currency });
      return qb;
    };

    const requestedQb = base();
    if (range.from) requestedQb.andWhere('p.requested_at >= :from', { from: range.from });
    if (range.to) requestedQb.andWhere('p.requested_at <= :to', { to: range.to });
    const { requested } = (await requestedQb
      .select('COALESCE(SUM(p.amount_minor), 0)', 'requested')
      .getRawOne<{ requested: string }>()) ?? { requested: '0' };

    const paidQb = base().andWhere('p.status = :status', { status: PayoutRequestStatus.PAID });
    if (range.from) paidQb.andWhere('p.paid_at >= :from', { from: range.from });
    if (range.to) paidQb.andWhere('p.paid_at <= :to', { to: range.to });
    const { paid } = (await paidQb.select('COALESCE(SUM(p.amount_minor), 0)', 'paid').getRawOne<{ paid: string }>()) ?? {
      paid: '0',
    };

    // `MarketplacePayoutRequest` has no `rejected_at`/generic `updated_at`
    // column (only `requested_at`/`approved_at`/`processing_at`/`paid_at`/
    // `failed_at`) — scoped by `requested_at` as the nearest available
    // proxy, unlike the other three categories which use their own real
    // decision timestamp.
    const rejectedQb = base().andWhere('p.status = :status', { status: PayoutRequestStatus.REJECTED });
    if (range.from) rejectedQb.andWhere('p.requested_at >= :from', { from: range.from });
    if (range.to) rejectedQb.andWhere('p.requested_at <= :to', { to: range.to });
    const { rejected } = (await rejectedQb
      .select('COALESCE(SUM(p.amount_minor), 0)', 'rejected')
      .getRawOne<{ rejected: string }>()) ?? { rejected: '0' };

    // FAILED with a prior `paid_at` is a genuine reversal (T170) — a FAILED
    // request that was never paid is not a "reversal", so it is excluded here.
    const reversedQb = base()
      .andWhere('p.status = :status', { status: PayoutRequestStatus.FAILED })
      .andWhere('p.paid_at IS NOT NULL');
    if (range.from) reversedQb.andWhere('p.failed_at >= :from', { from: range.from });
    if (range.to) reversedQb.andWhere('p.failed_at <= :to', { to: range.to });
    const { reversed } = (await reversedQb
      .select('COALESCE(SUM(p.amount_minor), 0)', 'reversed')
      .getRawOne<{ reversed: string }>()) ?? { reversed: '0' };

    return {
      currency,
      requestedAmountMinor: Number.parseInt(requested, 10),
      paidAmountMinor: Number.parseInt(paid, 10),
      rejectedAmountMinor: Number.parseInt(rejected, 10),
      reversedAmountMinor: Number.parseInt(reversed, 10),
    };
  }

  /** FR-236: every completed refund in the period, each row carrying the original sale's own period for traceability. */
  public async getRefundReport(currency: string, range: ReportingDateRange = {}): Promise<RefundReportRow[]> {
    const rows = await this.completedRefundsQuery(range)
      .innerJoin(MarketplaceOrder, 'ro', 'ro.id = r.order_id')
      .andWhere('ro.currency = :currency', { currency })
      .select(['r.id AS refund_id', 'r.order_id AS order_id', 'r.decided_at AS completed_at', 'ro.net_amount_minor AS amount_minor', 'ro.paid_at AS original_sale_at'])
      .orderBy('r.decided_at', 'ASC')
      .getRawMany<{ refund_id: string; order_id: string; completed_at: Date; amount_minor: string; original_sale_at: Date }>();

    return rows.map((row) => ({
      refundId: row.refund_id,
      orderId: row.order_id,
      currency,
      amountMinor: Number.parseInt(row.amount_minor, 10),
      completedAt: row.completed_at.toISOString(),
      originalSalePeriod: row.original_sale_at.toISOString().slice(0, 7),
    }));
  }

  private async sumOrderFigures(
    qb: ReturnType<MarketplaceReportingService['paidOrdersQuery']>,
    currency: string,
  ): Promise<RevenueSummary> {
    const raw = (await qb
      .select('COALESCE(SUM(o.gross_amount_minor), 0)', 'gross')
      .addSelect('COALESCE(SUM(o.discount_amount_minor), 0)', 'discount')
      .addSelect('COALESCE(SUM(o.net_amount_minor), 0)', 'net')
      .addSelect('COALESCE(SUM(o.commission_amount_minor), 0)', 'commission')
      .addSelect('COALESCE(SUM(o.instructor_earning_minor), 0)', 'earning')
      .getRawOne<{ gross: string; discount: string; net: string; commission: string; earning: string }>()) ?? {
      gross: '0',
      discount: '0',
      net: '0',
      commission: '0',
      earning: '0',
    };

    return {
      currency,
      grossAmountMinor: Number.parseInt(raw.gross, 10),
      discountAmountMinor: Number.parseInt(raw.discount, 10),
      netAmountMinor: Number.parseInt(raw.net, 10),
      commissionAmountMinor: Number.parseInt(raw.commission, 10),
      instructorEarningMinor: Number.parseInt(raw.earning, 10),
    };
  }

  private paidOrdersQuery(range: ReportingDateRange) {
    const qb = this.orders.createQueryBuilder('o').where('o.status = :status', { status: MarketplaceOrderStatus.PAID });
    if (range.from) qb.andWhere('o.paid_at >= :from', { from: range.from });
    if (range.to) qb.andWhere('o.paid_at <= :to', { to: range.to });
    return qb;
  }

  /** FR-236: scoped by the refund's own `decided_at` (when it completed), not `created_at` (when it was requested). */
  private completedRefundsQuery(range: ReportingDateRange) {
    const qb = this.refunds
      .createQueryBuilder('r')
      .where('r.status = :status', { status: RefundRequestStatus.COMPLETED });
    if (range.from) qb.andWhere('r.decided_at >= :from', { from: range.from });
    if (range.to) qb.andWhere('r.decided_at <= :to', { to: range.to });
    return qb;
  }
}
