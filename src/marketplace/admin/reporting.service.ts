import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { MarketplaceOrderStatus } from '../common/enums';
import { MarketplaceOrder } from '../commerce/entities';

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
 */
@Injectable()
export class MarketplaceReportingService {
  constructor(
    @InjectRepository(MarketplaceOrder)
    private readonly orders: Repository<MarketplaceOrder>,
  ) {}

  /** FR-115, FR-228: gross/discount/net/commission/instructor-earning, always excluding zero-value orders. */
  public async getRevenueSummary(currency: string, range: ReportingDateRange = {}): Promise<RevenueSummary> {
    const qb = this.paidOrdersQuery(range)
      .andWhere('o.currency = :currency', { currency })
      .andWhere('o.is_zero_value = false');

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

  /** FR-116, FR-228: enrollment/acquisition counts, always including zero-value orders. */
  public async getAcquisitionSummary(range: ReportingDateRange = {}): Promise<AcquisitionSummary> {
    const total = await this.paidOrdersQuery(range).getCount();
    const free = await this.paidOrdersQuery(range).andWhere('o.is_zero_value = true').getCount();
    return { totalEnrollments: total, paidEnrollments: total - free, freeEnrollments: free };
  }

  private paidOrdersQuery(range: ReportingDateRange) {
    const qb = this.orders.createQueryBuilder('o').where('o.status = :status', { status: MarketplaceOrderStatus.PAID });
    if (range.from) qb.andWhere('o.paid_at >= :from', { from: range.from });
    if (range.to) qb.andWhere('o.paid_at <= :to', { to: range.to });
    return qb;
  }
}
