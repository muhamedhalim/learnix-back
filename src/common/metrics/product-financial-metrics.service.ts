import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';

import { DataSource } from 'typeorm';

import { EGP_CURRENCY } from '../../payments/money.util';
import type { CurrencyFinancialTotals, ProductFinancialMetrics } from './metrics.types';

/** Row shape returned by {@link SETTLED_ORDER_TOTALS_SQL}. */
interface FinancialTotalsRow {
  currency: string;
  order_count: string;
  active_order_count: string;
  unique_student_count: string;
  list_price_value_minor: string;
  discount_amount_minor: string;
  gross_sales_minor: string;
  refund_amount_minor: string;
  platform_commission_minor: string;
  teacher_earnings_minor: string;
}

/**
 * The single definition of "this order settled" used by every product metric.
 *
 * See {@link CurrencyFinancialTotals} for the full rationale. In short: a paid
 * terminal state, a real recognition timestamp, and a finalised payment behind
 * it — refund-aware, so a refunded sale is subtracted rather than vanishing.
 */
const SETTLED_ORDER_PREDICATE = `
  o.paid_at IS NOT NULL
  AND o.status IN ('paid', 'partially_refunded', 'refunded')
  AND EXISTS (
    SELECT 1 FROM payments p
     WHERE p.id = o.payment_id
       AND p.status IN ('completed', 'refunded')
  )
`;

/**
 * Commission actually reversed for an order, as a cumulative allocation of the
 * refunded amount. Mirrors `RefundsService.reverseLedger` exactly (FLOOR on the
 * cumulative total, teacher takes the remainder), so these aggregates reconcile
 * with `financial_ledger_entries` even across several partial refunds.
 */
const COMMISSION_REVERSED_MINOR = `
  COALESCE(FLOOR(o.platform_commission_minor::numeric * o.refunded_amount_minor
                 / NULLIF(o.final_amount_minor, 0)), 0)
`;

const SETTLED_ORDER_TOTALS_SQL = `
  SELECT
    o.currency AS currency,
    COUNT(*)::text AS order_count,
    COUNT(*) FILTER (WHERE o.status <> 'refunded')::text AS active_order_count,
    COUNT(DISTINCT o.student_id)::text AS unique_student_count,
    COALESCE(SUM(o.original_amount_minor), 0)::text AS list_price_value_minor,
    COALESCE(SUM(o.discount_amount_minor), 0)::text AS discount_amount_minor,
    COALESCE(SUM(o.final_amount_minor), 0)::text AS gross_sales_minor,
    COALESCE(SUM(o.refunded_amount_minor), 0)::text AS refund_amount_minor,
    COALESCE(SUM(o.platform_commission_minor - ${COMMISSION_REVERSED_MINOR}), 0)::text
      AS platform_commission_minor,
    COALESCE(SUM(o.teacher_earning_minor
                 - (o.refunded_amount_minor - ${COMMISSION_REVERSED_MINOR})), 0)::text
      AS teacher_earnings_minor
  FROM orders o
  WHERE ${SETTLED_ORDER_PREDICATE}
`;

/**
 * The canonical financial read-model for a *product* (a lesson, a course, a
 * book) and for a teacher's whole catalogue.
 *
 * Every number it returns is derived from `orders`, which is the only table
 * that records what a student was actually charged: `final_amount_minor` is the
 * post-discount amount, `refunded_amount_minor` the cumulative refund, and the
 * commission/earning columns are snapshots taken at finalisation. Nothing here
 * multiplies a catalogue price by a purchase count — that estimate is precisely
 * the DEF-007 defect this service exists to retire.
 *
 * Not a report: it applies no date range and no authorisation. Callers scope
 * and authorise; date-ranged platform/teacher reporting stays in
 * `ReportsService` and `PaymentOperationsService`.
 */
@Injectable()
export class ProductFinancialMetricsService {
  public constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Financial totals for a single product.
   *
   * @param itemType `orders.item_type` — 'lesson', 'package', 'book', …
   * @param itemId   the product's own id, as stored in `orders.item_id`
   */
  public async getProductFinancialMetrics(
    itemType: string,
    itemId: string,
  ): Promise<ProductFinancialMetrics> {
    const rows = await this.dataSource.query<FinancialTotalsRow[]>(
      `${SETTLED_ORDER_TOTALS_SQL}
         AND o.item_type = $1
         AND o.item_id = $2
       GROUP BY o.currency
       ORDER BY SUM(o.final_amount_minor) DESC, o.currency ASC`,
      [itemType, itemId],
    );
    return this.toMetrics(rows);
  }

  /**
   * Financial totals for a product sold under more than one `item_type`.
   *
   * A lesson can be bought outright (`lesson`) or as a bookable session
   * (`lesson_session`); both are the same product to a teacher reading its
   * stats, and both are counted here — the same pairing `ReportsService` uses
   * for its "lessons" revenue bucket.
   */
  public async getProductFinancialMetricsForTypes(
    itemTypes: readonly string[],
    itemId: string,
  ): Promise<ProductFinancialMetrics> {
    if (itemTypes.length === 0) return this.toMetrics([]);
    const rows = await this.dataSource.query<FinancialTotalsRow[]>(
      `${SETTLED_ORDER_TOTALS_SQL}
         AND o.item_type = ANY($1::varchar[])
         AND o.item_id = $2
       GROUP BY o.currency
       ORDER BY SUM(o.final_amount_minor) DESC, o.currency ASC`,
      [itemTypes, itemId],
    );
    return this.toMetrics(rows);
  }

  /**
   * Financial totals across everything one teacher has sold.
   *
   * `orders.teacher_id` is the seller snapshot taken at checkout, so a lesson
   * later reassigned to another teacher stays attributed to whoever actually
   * made the sale — which is what a payout figure has to reflect.
   */
  public async getTeacherFinancialMetrics(teacherId: string): Promise<ProductFinancialMetrics> {
    const rows = await this.dataSource.query<FinancialTotalsRow[]>(
      `${SETTLED_ORDER_TOTALS_SQL}
         AND o.teacher_id = $1
       GROUP BY o.currency
       ORDER BY SUM(o.final_amount_minor) DESC, o.currency ASC`,
      [teacherId],
    );
    return this.toMetrics(rows);
  }

  /**
   * Unique students who have ever settled an order with this teacher.
   *
   * Deliberately a separate query from {@link getTeacherFinancialMetrics}: a
   * student buying in two currencies is one student, so this cannot be summed
   * out of the per-currency rows.
   */
  public async getTeacherUniqueStudentCount(teacherId: string): Promise<number> {
    const rows = await this.dataSource.query<Array<{ count: string }>>(
      `SELECT COUNT(DISTINCT o.student_id)::text AS count
         FROM orders o
        WHERE ${SETTLED_ORDER_PREDICATE}
          AND o.teacher_id = $1`,
      [teacherId],
    );
    return this.toInt(rows[0]?.count);
  }

  private toMetrics(rows: FinancialTotalsRow[]): ProductFinancialMetrics {
    const byCurrency = rows.map((row) => this.toTotals(row));
    return {
      primary: byCurrency[0] ?? this.emptyTotals(EGP_CURRENCY),
      by_currency: byCurrency,
      mixed_currency: byCurrency.length > 1,
    };
  }

  private toTotals(row: FinancialTotalsRow): CurrencyFinancialTotals {
    const gross = this.toInt(row.gross_sales_minor);
    const refunded = this.toInt(row.refund_amount_minor);
    return {
      currency: row.currency,
      order_count: this.toInt(row.order_count),
      active_order_count: this.toInt(row.active_order_count),
      unique_student_count: this.toInt(row.unique_student_count),
      list_price_value_minor: this.toInt(row.list_price_value_minor),
      discount_amount_minor: this.toInt(row.discount_amount_minor),
      gross_sales_minor: gross,
      refund_amount_minor: refunded,
      net_revenue_minor: gross - refunded,
      platform_commission_minor: this.toInt(row.platform_commission_minor),
      teacher_earnings_minor: this.toInt(row.teacher_earnings_minor),
    };
  }

  private emptyTotals(currency: string): CurrencyFinancialTotals {
    return {
      currency,
      order_count: 0,
      active_order_count: 0,
      unique_student_count: 0,
      list_price_value_minor: 0,
      discount_amount_minor: 0,
      gross_sales_minor: 0,
      refund_amount_minor: 0,
      net_revenue_minor: 0,
      platform_commission_minor: 0,
      teacher_earnings_minor: 0,
    };
  }

  /**
   * `bigint`/`numeric` aggregates arrive as strings from pg. Parsing here (not
   * with `Number()` on a possibly-null value) keeps a malformed aggregate from
   * silently becoming `NaN` in a money field.
   */
  private toInt(value: string | null | undefined): number {
    if (value === null || value === undefined) return 0;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
}
