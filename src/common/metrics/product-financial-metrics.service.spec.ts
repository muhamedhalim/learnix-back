import type { DataSource } from 'typeorm';

import { LearningMetricsService } from './learning-metrics.service';
import { ProductFinancialMetricsService } from './product-financial-metrics.service';

/**
 * Unit coverage for the parts of the metrics layer that are pure mapping —
 * string aggregates to numbers, net revenue arithmetic, currency selection and
 * the no-data contract. The SQL itself is proven against real PostgreSQL in
 * `test/e2e/product-metrics.postgres.e2e-spec.ts`; what is asserted here is the
 * boundary behaviour a database test would not pin down, plus the two clauses
 * of the settled-order predicate that must never be relaxed by accident.
 */
describe('ProductFinancialMetricsService', () => {
  const buildRow = (overrides: Partial<Record<string, string>> = {}) => ({
    currency: 'EGP',
    order_count: '0',
    active_order_count: '0',
    unique_student_count: '0',
    list_price_value_minor: '0',
    discount_amount_minor: '0',
    gross_sales_minor: '0',
    refund_amount_minor: '0',
    platform_commission_minor: '0',
    teacher_earnings_minor: '0',
    ...overrides,
  });

  const build = (rows: unknown[]) => {
    const query = jest.fn().mockResolvedValue(rows);
    const service = new ProductFinancialMetricsService({ query } as unknown as DataSource);
    return { service, query };
  };

  it('reports a zeroed EGP total for a product that has never sold', async () => {
    const { service } = build([]);

    const metrics = await service.getProductFinancialMetrics('lesson', 'lesson-1');

    expect(metrics.primary).toEqual({
      currency: 'EGP',
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
    });
    expect(metrics.by_currency).toEqual([]);
    expect(metrics.mixed_currency).toBe(false);
  });

  it('derives net revenue as gross minus refunds', async () => {
    const { service } = build([
      buildRow({
        order_count: '4',
        active_order_count: '3',
        unique_student_count: '4',
        list_price_value_minor: '400000',
        discount_amount_minor: '20000',
        gross_sales_minor: '380000',
        refund_amount_minor: '130000',
        platform_commission_minor: '75000',
        teacher_earnings_minor: '175000',
      }),
    ]);

    const metrics = await service.getProductFinancialMetrics('lesson', 'lesson-1');

    expect(metrics.primary.gross_sales_minor).toBe(380_000);
    expect(metrics.primary.refund_amount_minor).toBe(130_000);
    expect(metrics.primary.net_revenue_minor).toBe(250_000);
    // Commission and earnings are already net of reversal in SQL, so together
    // they must reconcile to net revenue rather than to gross.
    expect(
      metrics.primary.platform_commission_minor + metrics.primary.teacher_earnings_minor,
    ).toBe(metrics.primary.net_revenue_minor);
  });

  it('never adds two currencies together, and flags the mix', async () => {
    const { service } = build([
      buildRow({ currency: 'EGP', gross_sales_minor: '500000', order_count: '5' }),
      buildRow({ currency: 'USD', gross_sales_minor: '10000', order_count: '1' }),
    ]);

    const metrics = await service.getProductFinancialMetrics('package', 'pkg-1');

    // The highest-grossing currency leads; the other is preserved, not summed.
    expect(metrics.primary.currency).toBe('EGP');
    expect(metrics.primary.gross_sales_minor).toBe(500_000);
    expect(metrics.by_currency).toHaveLength(2);
    expect(metrics.mixed_currency).toBe(true);
  });

  it('restricts every aggregate to settled orders behind a finalised payment', async () => {
    const { service, query } = build([]);

    await service.getProductFinancialMetrics('lesson', 'lesson-1');
    const sql = String(query.mock.calls[0]?.[0]);

    // A refunded sale must stay in the population so it can be subtracted;
    // dropping it (as the pre-existing report queries do) would silently erase
    // the sale instead.
    expect(sql).toContain("o.status IN ('paid', 'partially_refunded', 'refunded')");
    expect(sql).toContain("p.status IN ('completed', 'refunded')");
    expect(sql).toContain('o.paid_at IS NOT NULL');
    // Abandoned and rejected checkouts are not part of any metric.
    expect(sql).not.toContain('awaiting_payment');
    expect(sql).not.toContain("'rejected'");
  });

  it('reverses commission on the cumulative refunded amount, matching the ledger', async () => {
    const { service, query } = build([]);

    await service.getProductFinancialMetrics('lesson', 'lesson-1');
    const sql = String(query.mock.calls[0]?.[0]);

    // FLOOR on the cumulative allocation is what RefundsService.reverseLedger
    // posts; ROUND or per-refund arithmetic would drift across partial refunds.
    expect(sql).toContain('FLOOR(o.platform_commission_minor::numeric * o.refunded_amount_minor');
    expect(sql).toContain('NULLIF(o.final_amount_minor, 0)');
  });

  it('short-circuits an empty item-type list instead of emitting `ANY(ARRAY[])`', async () => {
    const { service, query } = build([]);

    const metrics = await service.getProductFinancialMetricsForTypes([], 'lesson-1');

    expect(query).not.toHaveBeenCalled();
    expect(metrics.primary.gross_sales_minor).toBe(0);
  });
});

describe('LearningMetricsService', () => {
  const build = (rows: unknown[]) => {
    const query = jest.fn().mockResolvedValue(rows);
    const service = new LearningMetricsService({ query } as unknown as DataSource);
    return { service, query };
  };

  it('keeps a null average score as null rather than coercing it to zero', async () => {
    const { service } = build([
      {
        lessons_purchased: '3',
        lessons_completed: '1',
        courses_purchased: '1',
        exams_completed: '0',
        average_score_percent: null,
      },
    ]);

    const metrics = await service.getStudentLearningMetrics('user-1');

    expect(metrics.average_score_percent).toBeNull();
    expect(metrics.lessons_purchased).toBe(3);
  });

  it('parses a percentage average without floating-point noise', async () => {
    const { service } = build([
      {
        lessons_purchased: '0',
        lessons_completed: '0',
        courses_purchased: '0',
        exams_completed: '2',
        average_score_percent: '70.00',
      },
    ]);

    await expect(service.getStudentLearningMetrics('user-1')).resolves.toMatchObject({
      average_score_percent: 70,
    });
  });

  it('returns an empty map for an empty lesson page without querying', async () => {
    const { service, query } = build([]);

    await expect(service.getLessonStudentCounts([])).resolves.toEqual(new Map());
    expect(query).not.toHaveBeenCalled();
  });

  it('counts a page of lessons in one grouped query, defaulting absent lessons to zero', async () => {
    const { service, query } = build([{ lesson_id: 'lesson-1', count: '4' }]);

    const counts = await service.getLessonStudentCounts(['lesson-1', 'lesson-2']);

    expect(query).toHaveBeenCalledTimes(1);
    expect(counts.get('lesson-1')).toBe(4);
    expect(counts.get('lesson-2')).toBeUndefined();
  });

  it('excludes revoked access from every learning aggregate', async () => {
    const { service, query } = build([]);

    await service.getStudentLearningMetrics('user-1');
    const sql = String(query.mock.calls[0]?.[0]);

    expect(sql).toContain('lp.revoked_at IS NULL');
    expect(sql).toContain('pp.revoked_at IS NULL');
    // Only terminal, graded attempts count as a completed exam.
    expect(sql).toContain("ea.state = 'graded'");
    // Division by a zero max_score would produce NaN, not a score.
    expect(sql).toContain('ea.max_score > 0');
  });
});
