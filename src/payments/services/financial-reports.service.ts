import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import {
  ENTITLED_ORDER_STATUSES,
  FINALISED_PAYMENT_STATUS_SQL,
  SETTLED_ORDER_STATUS_SQL,
  SETTLED_ORDER_STATUSES,
} from '../../common/metrics/settled-order.sql';
import { ApplicationCacheService } from '../../common/cache/application-cache.service';
import { FinancialReportFilterDto, type FinancialReportWidget } from '../dto';
import {
  Entitlement,
  FinancialLedgerEntry,
  GatewayWebhookEvent,
  ManualPaymentSubmission,
  ManualPaymentSubmissionStatus,
  Order,
  OrderStatus,
  Payment,
  PaymentStatus,
  Settlement,
  SettlementStatus,
} from '../entities';

export interface DashboardFinancialSnapshot {
  summaries: Array<{
    currency: string;
    orderCount: number;
    grossSalesMinor: string;
    platformRevenueMinor: string;
    teacherEarningsMinor: string;
    refundsMinor: string;
    netPlatformRevenueMinor: string;
    averageOrderValueMinor: string;
    outstandingTeacherPayablesMinor: string | null;
    revenueChangeMinor: string;
    revenueGrowthBps: string | null;
  }>;
  trends: Array<{
    date: string;
    currency: string;
    orderCount: number;
    grossSalesMinor: string;
    platformRevenueMinor: string;
    teacherEarningsMinor: string;
  }>;
}

/**
 * Read-only financial reporting (reconciliation sweep, dashboard snapshot, financial report + CSV,
 * cached reconciliation warnings). Extracted unchanged from `PaymentOperationsService`, whose
 * remaining responsibility is the write side: maintenance, reconciliation of gateway state, expiry
 * and the outbox. Nothing here writes to the database.
 */
@Injectable()
export class FinancialReportsService {
  constructor(
    @InjectRepository(Order)
    private readonly orders: Repository<Order>,
    @InjectRepository(Payment)
    private readonly payments: Repository<Payment>,
    private readonly dataSource: DataSource,
    private readonly applicationCache: ApplicationCacheService,
  ) {}

  public async reconciliationReport(): Promise<Record<string, unknown>> {
    const [
      paidWithoutEntitlement,
      completedWithoutPaidOrder,
      activeEntitlementWithoutPaidOrder,
      ledgerImbalances,
      duplicateApprovedReferences,
      failedWebhooks,
      approvedManualWithoutPaidOrder,
      unknownCollectionOrders,
      overduePendingEarnings,
      releasedEarningsWithRefund,
      settlementOverallocations,
      settlementAllocationMismatches,
      uncoveredActiveSettlements,
      invalidPaidSettlements,
      duplicateSettlementReferences,
      duplicateSettlementKeys,
      refundConservationIssues,
      negativeAvailableBalances,
      financialOrphans,
    ] = await Promise.all([
      // AUD-030 (reconciliation false positives): a PARTIAL refund leaves the
      // order `partially_refunded` while the payment stays `completed` and the
      // entitlement is deliberately retained
      // (`entitlement_policy: retained_on_partial_refund`). Comparing against
      // `'paid'` alone therefore reported three healthy states as integrity
      // failures on every partial refund. `ENTITLED_ORDER_STATUSES` is the set
      // that must still hold access; `refunded` is excluded because a full
      // refund correctly revokes it.
      this.orders
        .createQueryBuilder('order')
        .where('order.status IN (:...entitledOrderStatuses)', {
          entitledOrderStatuses: [...ENTITLED_ORDER_STATUSES],
        })
        .andWhere('NOT EXISTS (SELECT 1 FROM entitlements e WHERE e.order_id = order.id)')
        .select(['order.id', 'order.order_number'])
        .take(101)
        .getMany(),
      this.payments
        .createQueryBuilder('payment')
        .leftJoin(Order, 'order', 'order.id = payment.order_id')
        .where('payment.status = :completed', { completed: PaymentStatus.COMPLETED })
        // Aggregate cart charges deliberately have no single Order. Their
        // paid child Orders are checked independently, so they are not an
        // orphaned-completed-payment reconciliation failure.
        .andWhere('(payment.cart_checkout_id IS NULL OR payment.order_id IS NOT NULL)')
        .andWhere('(payment.order_id IS NULL OR order.status NOT IN (:...settledOrderStatuses))', {
          settledOrderStatuses: [...SETTLED_ORDER_STATUSES],
        })
        .select(['payment.id', 'payment.order_id'])
        .take(101)
        .getMany(),
      this.dataSource
        .getRepository(Entitlement)
        .createQueryBuilder('entitlement')
        .leftJoin(Order, 'order', 'order.id = entitlement.order_id')
        .where("entitlement.status = 'active'")
        .andWhere('(order.id IS NULL OR order.status NOT IN (:...entitledOrderStatuses))', {
          entitledOrderStatuses: [...ENTITLED_ORDER_STATUSES],
        })
        .select(['entitlement.id', 'entitlement.order_id'])
        .take(101)
        .getMany(),
      this.dataSource
        .getRepository(FinancialLedgerEntry)
        .createQueryBuilder('entry')
        .select('entry.order_id', 'order_id')
        .addSelect(
          `SUM(CASE WHEN entry.direction = 'debit' THEN entry.amount_minor ELSE -entry.amount_minor END)`,
          'imbalance_minor',
        )
        .groupBy('entry.order_id')
        .having(
          `SUM(CASE WHEN entry.direction = 'debit' THEN entry.amount_minor ELSE -entry.amount_minor END) != 0`,
        )
        .limit(101)
        .getRawMany(),
      this.dataSource
        .getRepository(ManualPaymentSubmission)
        .createQueryBuilder('submission')
        .select('submission.manual_payment_method_id', 'method_id')
        .addSelect('submission.transaction_reference', 'transaction_reference')
        .addSelect('COUNT(*)', 'count')
        .where('submission.status = :approved', {
          approved: ManualPaymentSubmissionStatus.APPROVED,
        })
        .andWhere('submission.transaction_reference IS NOT NULL')
        .groupBy('submission.manual_payment_method_id')
        .addGroupBy('submission.transaction_reference')
        .having('COUNT(*) > 1')
        .limit(101)
        .getRawMany(),
      this.dataSource.getRepository(GatewayWebhookEvent).find({
        where: { status: 'failed' },
        order: { created_at: 'DESC' },
        take: 100,
      }),
      this.dataSource
        .getRepository(ManualPaymentSubmission)
        .createQueryBuilder('submission')
        .leftJoin(Order, 'order', 'order.id = submission.order_id')
        .where('submission.status = :approved', {
          approved: ManualPaymentSubmissionStatus.APPROVED,
        })
        // Same partial-refund false positive as above: an approved manual
        // payment whose order was later partially refunded did settle.
        .andWhere('(order.id IS NULL OR order.status NOT IN (:...settledOrderStatusesManual))', {
          settledOrderStatusesManual: [...SETTLED_ORDER_STATUSES],
        })
        .select(['submission.id', 'submission.order_id'])
        .take(101)
        .getMany(),
      this.orders
        .createQueryBuilder('order')
        .where('order.status = :paid', { paid: OrderStatus.PAID })
        .andWhere("order.collection_party = 'unknown'")
        .select(['order.id', 'order.order_number', 'order.payment_channel'])
        .take(101)
        .getMany(),
      this.dataSource.query(`
        SELECT pending.id, pending.teacher_id, pending.currency, pending.amount_minor, pending.available_at
        FROM financial_ledger_entries pending
        WHERE pending.entry_type = 'teacher_earning_pending'
          AND pending.direction = 'credit'
          AND pending.available_at <= NOW()
          AND NOT EXISTS (
            SELECT 1 FROM financial_ledger_entries released
            WHERE released.reference = 'release:' || pending.id::text || ':available'
          )
        ORDER BY pending.available_at ASC
        LIMIT 101
      `),
      this.dataSource.query(`
        SELECT pending.id, pending.order_id, pending.teacher_id
        FROM financial_ledger_entries pending
        WHERE pending.entry_type = 'teacher_earning_pending'
          AND pending.direction = 'credit'
          AND EXISTS (
            SELECT 1 FROM financial_ledger_entries released
            WHERE released.reference = 'release:' || pending.id::text || ':available'
          )
          AND EXISTS (
            SELECT 1 FROM financial_ledger_entries reversal
            WHERE reversal.order_id = pending.order_id
              AND reversal.entry_type = 'teacher_earning_reversal'
          )
        LIMIT 101
      `),
      this.dataSource.query(`
        SELECT membership.ledger_entry_id, SUM(membership.amount_minor)::text AS allocated_minor,
               MAX(earning.amount_minor)::text AS earning_minor
        FROM teacher_settlement_entries membership
        INNER JOIN teacher_settlements settlement ON settlement.id = membership.settlement_id
        INNER JOIN financial_ledger_entries earning ON earning.id = membership.ledger_entry_id
        WHERE settlement.status IN ('draft', 'approved', 'paid')
        GROUP BY membership.ledger_entry_id
        HAVING SUM(membership.amount_minor) > MAX(earning.amount_minor)
        LIMIT 101
      `),
      this.dataSource.query(`
        SELECT settlement.id, settlement.gross_amount_minor,
               COALESCE(SUM(membership.amount_minor), 0)::text AS allocated_minor
        FROM teacher_settlements settlement
        LEFT JOIN teacher_settlement_entries membership ON membership.settlement_id = settlement.id
        WHERE settlement.status IN ('draft', 'approved', 'paid')
        GROUP BY settlement.id
        HAVING COALESCE(SUM(membership.amount_minor), 0) <> settlement.gross_amount_minor
        LIMIT 101
      `),
      this.dataSource.query(`
        SELECT settlement.id, settlement.teacher_id, settlement.currency, settlement.gross_amount_minor
        FROM teacher_settlements settlement
        WHERE settlement.status IN ('draft', 'approved')
          AND settlement.gross_amount_minor > COALESCE((
            SELECT SUM(CASE WHEN entry.direction = 'credit' THEN entry.amount_minor ELSE -entry.amount_minor END)
            FROM financial_ledger_entries entry
            WHERE entry.teacher_id = settlement.teacher_id
              AND entry.currency = settlement.currency
              AND entry.account = 'teacher_payable_available'
          ), 0)
        LIMIT 101
      `),
      this.dataSource
        .getRepository(Settlement)
        .createQueryBuilder('settlement')
        .where('settlement.status = :paid', { paid: SettlementStatus.PAID })
        .andWhere(
          `(
            settlement.transfer_reference IS NULL
            OR BTRIM(settlement.transfer_reference) = ''
            OR settlement.paid_by IS NULL
            OR settlement.paid_at IS NULL
          )`,
        )
        .select([
          'settlement.id',
          'settlement.transfer_reference',
          'settlement.paid_by',
          'settlement.paid_at',
        ])
        .take(101)
        .getMany(),
      this.dataSource.query(`
        SELECT lower(btrim(transfer_reference)) AS transfer_reference, COUNT(*)::int AS count
        FROM teacher_settlements
        WHERE status = 'paid' AND transfer_reference IS NOT NULL
        GROUP BY lower(btrim(transfer_reference))
        HAVING COUNT(*) > 1
        LIMIT 101
      `),
      this.dataSource.query(`
        SELECT idempotency_key, COUNT(*)::int AS count
        FROM teacher_settlements
        GROUP BY idempotency_key
        HAVING COUNT(*) > 1
        LIMIT 101
      `),
      this.dataSource.query(`
        SELECT refund.order_id, SUM(refund.amount_minor)::text AS succeeded_refunds_minor,
               MAX("order".refunded_amount_minor)::text AS order_refunded_minor,
               MAX("order".final_amount_minor)::text AS order_final_minor
        FROM refunds refund
        INNER JOIN orders "order" ON "order".id = refund.order_id
        WHERE refund.status = 'succeeded'
        GROUP BY refund.order_id
        HAVING SUM(refund.amount_minor) > MAX("order".final_amount_minor)
            OR SUM(refund.amount_minor) <> MAX("order".refunded_amount_minor)
        LIMIT 101
      `),
      this.dataSource.query(`
        SELECT teacher_id, currency,
               SUM(CASE WHEN direction = 'credit' THEN amount_minor ELSE -amount_minor END)::text AS balance_minor
        FROM financial_ledger_entries
        WHERE account = 'teacher_payable_available'
        GROUP BY teacher_id, currency
        HAVING SUM(CASE WHEN direction = 'credit' THEN amount_minor ELSE -amount_minor END) < 0
        LIMIT 101
      `),
      this.dataSource.query(`
        SELECT 'financial_ledger_entries.order_id' AS relation, entry.id
        FROM financial_ledger_entries entry
        LEFT JOIN orders "order" ON "order".id = entry.order_id
        WHERE "order".id IS NULL
        UNION ALL
        SELECT 'refunds.order_id' AS relation, refund.id
        FROM refunds refund
        LEFT JOIN orders "order" ON "order".id = refund.order_id
        WHERE "order".id IS NULL
        UNION ALL
        SELECT 'teacher_settlement_entries.ledger_entry_id' AS relation, membership.id
        FROM teacher_settlement_entries membership
        LEFT JOIN financial_ledger_entries entry ON entry.id = membership.ledger_entry_id
        WHERE entry.id IS NULL
        LIMIT 101
      `),
    ]);
    const [
      releasePairIntegrityIssues,
      payoutClearingJournalIssues,
      teacherBalanceRollforwardIssues,
      staleTerminalReservations,
      archivedTeacherFinancialExposure,
      invalidCurrencyMixing,
      duplicatePayoutFingerprints,
      settlementLedgerPostingMismatches,
    ] = await Promise.all([
      this.dataSource.query(`
        SELECT pending.id, pending.order_id, pending.amount_minor, pending.currency
        FROM financial_ledger_entries pending
        WHERE pending.entry_type = 'teacher_earning_pending' AND pending.direction = 'credit'
          AND EXISTS (SELECT 1 FROM financial_ledger_entries available WHERE available.reference = 'release:' || pending.id::text || ':available')
          AND NOT EXISTS (SELECT 1 FROM financial_ledger_entries debit WHERE debit.reference = 'release:' || pending.id::text || ':pending'
                            AND debit.amount_minor = pending.amount_minor AND debit.currency = pending.currency AND debit.direction = 'debit')
        LIMIT 101
      `),
      this.dataSource.query(`
        SELECT settlement.id, settlement.currency, settlement.gross_amount_minor, settlement.payout_amount_minor
        FROM teacher_settlements settlement
        WHERE settlement.status = 'paid' AND (
          NOT EXISTS (SELECT 1 FROM financial_ledger_entries entry WHERE entry.reference = 'settlement:' || settlement.id::text || ':liability'
                      AND entry.direction = 'debit' AND entry.amount_minor = settlement.gross_amount_minor AND entry.currency = settlement.currency)
          OR NOT EXISTS (SELECT 1 FROM financial_ledger_entries entry WHERE entry.reference = 'settlement:' || settlement.id::text || ':payout'
                         AND entry.direction = 'credit' AND entry.amount_minor = settlement.payout_amount_minor AND entry.currency = settlement.currency)
        ) LIMIT 101
      `),
      this.dataSource.query(`
        SELECT teacher_id, currency, SUM(CASE WHEN direction = 'credit' THEN amount_minor ELSE -amount_minor END)::text AS closing_balance_minor
        FROM financial_ledger_entries
        WHERE account IN ('teacher_payable','teacher_payable_available')
        GROUP BY teacher_id, currency
        HAVING SUM(CASE WHEN direction = 'credit' THEN amount_minor ELSE -amount_minor END) < 0
        LIMIT 101
      `),
      this.dataSource.query(`
        SELECT settlement.id, settlement.status, membership.id AS settlement_entry_id
        FROM teacher_settlements settlement JOIN teacher_settlement_entries membership ON membership.settlement_id = settlement.id
        WHERE settlement.status IN ('cancelled','rejected')
          AND EXISTS (SELECT 1 FROM financial_ledger_entries entry WHERE entry.settlement_id = settlement.id
                      AND entry.entry_type IN ('settlement_liability_clearing','payout'))
        LIMIT 101
      `),
      this.dataSource.query(`
        SELECT user_record.id AS teacher_id, entry.currency,
          SUM(CASE WHEN entry.direction = 'credit' THEN entry.amount_minor ELSE -entry.amount_minor END)::text AS open_balance_minor
        FROM users user_record JOIN financial_ledger_entries entry ON entry.teacher_id = user_record.id
        WHERE (user_record.deleted_at IS NOT NULL OR user_record.is_active = false)
        GROUP BY user_record.id, entry.currency
        HAVING SUM(CASE WHEN entry.direction = 'credit' THEN entry.amount_minor ELSE -entry.amount_minor END) <> 0
        LIMIT 101
      `),
      this.dataSource.query(`
        SELECT 'settlement_allocation' AS relation, membership.id
        FROM teacher_settlement_entries membership JOIN teacher_settlements settlement ON settlement.id = membership.settlement_id
        JOIN financial_ledger_entries entry ON entry.id = membership.ledger_entry_id WHERE settlement.currency <> entry.currency
        UNION ALL
        SELECT 'refund_order', refund.id FROM refunds refund JOIN orders "order" ON "order".id = refund.order_id
        WHERE refund.currency <> "order".currency
        LIMIT 101
      `),
      this.dataSource.query(`
        SELECT teacher_id, fiscal_period, currency, payout_amount_minor, array_agg(id) AS settlement_ids
        FROM teacher_settlements WHERE status IN ('draft','approved','paid')
        GROUP BY teacher_id, fiscal_period, currency, payout_amount_minor HAVING COUNT(*) > 1 LIMIT 101
      `),
      this.dataSource.query(`
        SELECT settlement.id, settlement.gross_amount_minor, COALESCE(SUM(CASE WHEN entry.entry_type = 'settlement_liability_clearing' THEN entry.amount_minor ELSE 0 END), 0)::text AS clearing_minor
        FROM teacher_settlements settlement LEFT JOIN financial_ledger_entries entry ON entry.settlement_id = settlement.id
        WHERE settlement.status = 'paid' GROUP BY settlement.id
        HAVING COALESCE(SUM(CASE WHEN entry.entry_type = 'settlement_liability_clearing' THEN entry.amount_minor ELSE 0 END), 0) <> settlement.gross_amount_minor
        LIMIT 101
      `),
    ]);
    return {
      generated_at: new Date().toISOString(),
      paid_orders_without_entitlement: paidWithoutEntitlement,
      completed_payments_without_paid_order: completedWithoutPaidOrder,
      active_entitlements_without_paid_order: activeEntitlementWithoutPaidOrder,
      ledger_imbalances: ledgerImbalances,
      duplicate_approved_manual_references: duplicateApprovedReferences,
      failed_gateway_webhooks: failedWebhooks,
      approved_manual_submissions_without_paid_order: approvedManualWithoutPaidOrder,
      paid_orders_with_unknown_collection_party: unknownCollectionOrders,
      overdue_pending_earnings: overduePendingEarnings,
      released_earnings_with_refund: releasedEarningsWithRefund,
      settlement_overallocations: settlementOverallocations,
      settlement_allocation_mismatches: settlementAllocationMismatches,
      active_settlements_not_covered_by_available_balance: uncoveredActiveSettlements,
      paid_settlements_missing_execution_details: invalidPaidSettlements,
      duplicate_settlement_transfer_references: duplicateSettlementReferences,
      duplicate_settlement_idempotency_keys: duplicateSettlementKeys,
      refund_conservation_issues: refundConservationIssues,
      negative_teacher_available_balances: negativeAvailableBalances,
      financial_orphans: financialOrphans,
      release_debit_credit_pair_integrity_issues: releasePairIntegrityIssues,
      payout_clearing_journal_completeness_issues: payoutClearingJournalIssues,
      teacher_opening_closing_balance_rollforward_issues: teacherBalanceRollforwardIssues,
      stale_terminal_reservations: staleTerminalReservations,
      archived_teacher_financial_exposure: archivedTeacherFinancialExposure,
      invalid_currency_mixing: invalidCurrencyMixing,
      duplicate_payout_fingerprints: duplicatePayoutFingerprints,
      settlement_ledger_posting_mismatches: settlementLedgerPostingMismatches,
    };
  }

  /**
   * Canonical admin financial dashboard. Revenue recognition is deliberately
   * limited to paid orders with completed payments and orders.paid_at.
   * Amounts remain PostgreSQL minor-unit numerics serialized as strings.
   */
  public async dashboardFinancialSnapshot(
    bounds: { start: Date; end: Date; previousStart: Date; previousEnd: Date },
    includeTeacherPayables: boolean,
  ): Promise<DashboardFinancialSnapshot> {
    const filter: FinancialReportFilterDto = { page: 1, limit: 20 };
    const [summaryRows, trendRows, payableRows] = (await Promise.all([
      this.runFinancialReportQuery(filter, bounds, async ({ current, previous, params }) =>
        this.dataSource.query(
          `
          WITH ${current}, ${previous},
          sales AS (
            SELECT currency, COUNT(*)::text AS order_count,
              COALESCE(SUM(final_amount_minor), 0)::text AS gross_sales_minor,
              COALESCE(SUM(platform_commission_minor), 0)::text AS platform_revenue_minor,
              COALESCE(SUM(teacher_earning_minor), 0)::text AS teacher_earnings_minor,
              COALESCE(ROUND(AVG(final_amount_minor)), 0)::text AS average_order_value_minor
            FROM current_orders GROUP BY currency
          ), prior AS (
            SELECT currency, COALESCE(SUM(final_amount_minor), 0)::text AS gross_sales_minor
            FROM previous_orders GROUP BY currency
          ), returns AS (
            SELECT currency,
              COALESCE(SUM(refunded_amount_minor), 0)::text AS refunds_minor,
              COALESCE(SUM(ROUND(platform_commission_minor::numeric * refunded_amount_minor / NULLIF(final_amount_minor, 0))), 0)::text AS platform_refunds_minor
            FROM current_orders WHERE refunded_amount_minor > 0 GROUP BY currency
          ), currencies AS (
            SELECT currency FROM sales UNION SELECT currency FROM prior
          )
          SELECT currencies.currency,
            COALESCE(sales.order_count, '0') AS order_count,
            COALESCE(sales.gross_sales_minor, '0') AS gross_sales_minor,
            COALESCE(sales.platform_revenue_minor, '0') AS platform_revenue_minor,
            COALESCE(sales.teacher_earnings_minor, '0') AS teacher_earnings_minor,
            COALESCE(returns.refunds_minor, '0') AS refunds_minor,
            (COALESCE(sales.platform_revenue_minor::bigint, 0) - COALESCE(returns.platform_refunds_minor::bigint, 0))::text AS net_platform_revenue_minor,
            COALESCE(sales.average_order_value_minor, '0') AS average_order_value_minor,
            (COALESCE(sales.gross_sales_minor::bigint, 0) - COALESCE(prior.gross_sales_minor::bigint, 0))::text AS revenue_change_minor,
            CASE WHEN COALESCE(prior.gross_sales_minor::bigint, 0) = 0 THEN NULL
              ELSE ROUND((COALESCE(sales.gross_sales_minor::numeric, 0) - prior.gross_sales_minor::numeric) * 10000 / prior.gross_sales_minor::numeric)::text END AS revenue_growth_bps
          FROM currencies LEFT JOIN sales USING (currency) LEFT JOIN prior USING (currency) LEFT JOIN returns USING (currency)
          ORDER BY currencies.currency ASC
        `,
          params,
        ),
      ),
      this.runCurrentFinancialReportQuery(filter, bounds, async ({ current, params }) =>
        this.dataSource.query(
          `
          WITH ${current}
          SELECT date_trunc('day', paid_at)::date::text AS date, currency,
            COUNT(*)::text AS order_count,
            COALESCE(SUM(final_amount_minor), 0)::text AS gross_sales_minor,
            COALESCE(SUM(platform_commission_minor), 0)::text AS platform_revenue_minor,
            COALESCE(SUM(teacher_earning_minor), 0)::text AS teacher_earnings_minor
          FROM current_orders
          GROUP BY date_trunc('day', paid_at), currency
          ORDER BY date_trunc('day', paid_at) ASC, currency ASC
        `,
          params,
        ),
      ),
      includeTeacherPayables
        ? this.dataSource.query(`
            WITH ledger AS (
              SELECT currency,
                COALESCE(SUM(CASE WHEN account = 'teacher_payable' THEN CASE WHEN direction = 'credit' THEN amount_minor ELSE -amount_minor END ELSE 0 END), 0)::bigint AS pending_minor,
                COALESCE(SUM(CASE WHEN account = 'teacher_payable_available' THEN CASE WHEN direction = 'credit' THEN amount_minor ELSE -amount_minor END ELSE 0 END), 0)::bigint AS available_minor
              FROM financial_ledger_entries WHERE teacher_id IS NOT NULL GROUP BY currency
            ), reserved AS (
              SELECT settlement.currency, COALESCE(SUM(entry.amount_minor), 0)::bigint AS reserved_minor
              FROM teacher_settlements settlement
              INNER JOIN teacher_settlement_entries entry ON entry.settlement_id = settlement.id
              WHERE settlement.status IN ('draft', 'approved') GROUP BY settlement.currency
            ), currencies AS (
              SELECT currency FROM ledger UNION SELECT currency FROM reserved
            )
            SELECT currencies.currency,
              GREATEST(COALESCE(ledger.pending_minor, 0) + COALESCE(ledger.available_minor, 0) - COALESCE(reserved.reserved_minor, 0), 0)::text AS outstanding_minor
            FROM currencies LEFT JOIN ledger USING (currency) LEFT JOIN reserved USING (currency)
          `)
        : Promise.resolve([]),
    ])) as [
      Array<Record<string, unknown>>,
      Array<Record<string, unknown>>,
      Array<Record<string, unknown>>,
    ];

    const outstandingByCurrency = new Map(
      payableRows.map((row) => [String(row['currency']), String(row['outstanding_minor'] ?? '0')]),
    );
    return {
      summaries: summaryRows.map((row) => ({
        currency: String(row['currency']),
        orderCount: Number(row['order_count'] ?? 0),
        grossSalesMinor: String(row['gross_sales_minor'] ?? '0'),
        platformRevenueMinor: String(row['platform_revenue_minor'] ?? '0'),
        teacherEarningsMinor: String(row['teacher_earnings_minor'] ?? '0'),
        refundsMinor: String(row['refunds_minor'] ?? '0'),
        netPlatformRevenueMinor: String(row['net_platform_revenue_minor'] ?? '0'),
        averageOrderValueMinor: String(row['average_order_value_minor'] ?? '0'),
        outstandingTeacherPayablesMinor: includeTeacherPayables
          ? (outstandingByCurrency.get(String(row['currency'])) ?? '0')
          : null,
        revenueChangeMinor: String(row['revenue_change_minor'] ?? '0'),
        revenueGrowthBps:
          row['revenue_growth_bps'] == null ? null : String(row['revenue_growth_bps']),
      })),
      trends: trendRows.map((row) => ({
        date: String(row['date']),
        currency: String(row['currency']),
        orderCount: Number(row['order_count'] ?? 0),
        grossSalesMinor: String(row['gross_sales_minor'] ?? '0'),
        platformRevenueMinor: String(row['platform_revenue_minor'] ?? '0'),
        teacherEarningsMinor: String(row['teacher_earnings_minor'] ?? '0'),
      })),
    };
  }

  public async financialReport(filter: FinancialReportFilterDto): Promise<Record<string, unknown>> {
    const bounds = this.financialReportBounds(filter);
    // Absent/empty selection = every widget (default body unchanged). An
    // unselected widget resolves to [] without running its query and is never
    // reported in `widget_errors`.
    const selected = filter.widgets;
    const want = (widget: FinancialReportWidget): boolean =>
      selected === undefined || selected.length === 0 || selected.includes(widget);
    const results = await Promise.allSettled([
      !want('summary')
        ? Promise.resolve([])
        : this.runFinancialReportQuery(filter, bounds, async ({ current, previous, params }) => {
            const ledgerWhere = this.reportLedgerWhere(filter, params, 'entry');
            const settlementWhere = this.reportSettlementWhere(filter, params, 'settlement');
            return this.dataSource.query(
              `
          WITH ${current}, ${previous},
          sales AS (
            SELECT currency, COUNT(*)::text AS order_count,
              COALESCE(SUM(final_amount_minor), 0)::text AS gross_revenue_minor,
              COALESCE(SUM(platform_commission_minor), 0)::text AS platform_revenue_minor,
              COALESCE(SUM(teacher_earning_minor), 0)::text AS teacher_earnings_minor,
              COALESCE(ROUND(AVG(final_amount_minor)), 0)::text AS average_order_value_minor
            FROM current_orders GROUP BY currency
          ),
          prior_sales AS (
            SELECT currency, COALESCE(SUM(final_amount_minor), 0)::text AS gross_revenue_minor
            FROM previous_orders GROUP BY currency
          ),
          returns AS (
            SELECT o.currency, COALESCE(SUM(o.refunded_amount_minor), 0)::text AS refunds_minor,
              COALESCE(SUM(ROUND(o.platform_commission_minor::numeric * o.refunded_amount_minor / NULLIF(o.final_amount_minor, 0))), 0)::text AS platform_refunds_minor,
              COALESCE(SUM(ROUND(o.teacher_earning_minor::numeric * o.refunded_amount_minor / NULLIF(o.final_amount_minor, 0))), 0)::text AS teacher_refunds_minor
            FROM current_orders o WHERE o.refunded_amount_minor > 0
            GROUP BY o.currency
          ),
          ledger AS (
            SELECT entry.currency,
              COALESCE(SUM(CASE WHEN entry.account = 'teacher_payable' THEN CASE WHEN entry.direction = 'credit' THEN entry.amount_minor ELSE -entry.amount_minor END ELSE 0 END), 0)::text AS pending_minor,
              COALESCE(SUM(CASE WHEN entry.account = 'teacher_payable_available' THEN CASE WHEN entry.direction = 'credit' THEN entry.amount_minor ELSE -entry.amount_minor END ELSE 0 END), 0)::text AS available_minor
            FROM financial_ledger_entries entry WHERE ${ledgerWhere}
            GROUP BY entry.currency
          ),
          reserved AS (
            SELECT settlement.currency, COALESCE(SUM(membership.amount_minor), 0)::text AS reserved_minor
            FROM teacher_settlements settlement
            INNER JOIN teacher_settlement_entries membership ON membership.settlement_id = settlement.id
            WHERE settlement.status IN ('draft', 'approved') AND ${settlementWhere}
            GROUP BY settlement.currency
          ),
          paid AS (
            SELECT settlement.currency, COALESCE(SUM(settlement.payout_amount_minor), 0)::text AS paid_to_teachers_minor
            FROM teacher_settlements settlement
            WHERE settlement.status = 'paid' AND settlement.paid_at >= $1 AND settlement.paid_at < $2 AND ${settlementWhere}
            GROUP BY settlement.currency
          ),
          currencies AS (
            SELECT currency FROM sales UNION SELECT currency FROM ledger UNION SELECT currency FROM reserved UNION SELECT currency FROM paid
          )
          SELECT currency,
            COALESCE(sales.order_count, '0') AS order_count,
            COALESCE(sales.gross_revenue_minor, '0') AS gross_revenue_minor,
            COALESCE(sales.platform_revenue_minor, '0') AS platform_revenue_minor,
            COALESCE(sales.teacher_earnings_minor, '0') AS teacher_earnings_minor,
            COALESCE(returns.refunds_minor, '0') AS refunds_minor,
            COALESCE(returns.platform_refunds_minor, '0') AS platform_refunds_minor,
            COALESCE(returns.teacher_refunds_minor, '0') AS teacher_refunds_minor,
            COALESCE(ledger.available_minor, '0') AS available_for_payout_minor,
            COALESCE(reserved.reserved_minor, '0') AS reserved_in_settlements_minor,
            COALESCE(ledger.pending_minor, '0') AS pending_held_minor,
            COALESCE(paid.paid_to_teachers_minor, '0') AS paid_to_teachers_minor,
            GREATEST(COALESCE(ledger.pending_minor::bigint, 0) + COALESCE(ledger.available_minor::bigint, 0) - COALESCE(reserved.reserved_minor::bigint, 0), 0)::text AS outstanding_teacher_payables_minor,
            (COALESCE(sales.platform_revenue_minor::bigint, 0) - COALESCE(returns.platform_refunds_minor::bigint, 0))::text AS net_revenue_minor,
            COALESCE(sales.average_order_value_minor, '0') AS average_order_value_minor,
            (COALESCE(sales.gross_revenue_minor::bigint, 0) - COALESCE(prior_sales.gross_revenue_minor::bigint, 0))::text AS revenue_change_minor,
            CASE WHEN COALESCE(prior_sales.gross_revenue_minor::bigint, 0) = 0 THEN NULL
              ELSE ROUND((COALESCE(sales.gross_revenue_minor::numeric, 0) - prior_sales.gross_revenue_minor::numeric) * 10000 / prior_sales.gross_revenue_minor::numeric)::text END AS revenue_growth_bps
          FROM currencies
          LEFT JOIN sales USING (currency) LEFT JOIN prior_sales USING (currency) LEFT JOIN returns USING (currency)
          LEFT JOIN ledger USING (currency) LEFT JOIN reserved USING (currency) LEFT JOIN paid USING (currency)
          ORDER BY currency ASC
        `,
              params,
            );
          }),
      !want('teacher_receivables')
        ? Promise.resolve([])
        : this.runFinancialReportQuery(filter, bounds, async ({ current, previous, params }) => {
            const ledgerWhere = this.reportLedgerWhere(filter, params, 'entry');
            const settlementWhere = this.reportSettlementWhere(filter, params, 'settlement');
            const limitIndex = params.push(Math.min(filter.limit ?? 20, 100));
            const offsetIndex = params.push(
              ((filter.page ?? 1) - 1) * Math.min(filter.limit ?? 20, 100),
            );
            return this.dataSource.query(
              `
          WITH ${current}, ${previous},
          sales AS (
            SELECT teacher_id, currency, COUNT(*)::text AS order_count, COALESCE(SUM(final_amount_minor),0)::text AS gross_sales_minor,
              COALESCE(SUM(platform_commission_minor),0)::text AS platform_commission_minor,
              COALESCE(SUM(teacher_earning_minor),0)::text AS teacher_entitlement_minor,
              COALESCE(ROUND(AVG(final_amount_minor)),0)::text AS average_order_value_minor
            FROM current_orders WHERE teacher_id IS NOT NULL GROUP BY teacher_id, currency
          ), prior AS (
            SELECT teacher_id, currency, COALESCE(SUM(final_amount_minor),0)::text AS gross_sales_minor
            FROM previous_orders WHERE teacher_id IS NOT NULL GROUP BY teacher_id, currency
          ), returns AS (
            SELECT o.teacher_id, o.currency, COALESCE(SUM(o.refunded_amount_minor),0)::text AS refunds_minor
            FROM current_orders o WHERE o.teacher_id IS NOT NULL AND o.refunded_amount_minor > 0 GROUP BY o.teacher_id, o.currency
          ), ledger AS (
            SELECT entry.teacher_id, entry.currency,
              COALESCE(SUM(CASE WHEN entry.account='teacher_payable' THEN CASE WHEN entry.direction='credit' THEN entry.amount_minor ELSE -entry.amount_minor END ELSE 0 END),0)::text AS pending_minor,
              COALESCE(SUM(CASE WHEN entry.account='teacher_payable_available' THEN CASE WHEN entry.direction='credit' THEN entry.amount_minor ELSE -entry.amount_minor END ELSE 0 END),0)::text AS available_minor
            FROM financial_ledger_entries entry WHERE ${ledgerWhere} GROUP BY entry.teacher_id, entry.currency
          ), reserved AS (
            SELECT settlement.teacher_id, settlement.currency, COALESCE(SUM(membership.amount_minor),0)::text AS reserved_minor
            FROM teacher_settlements settlement INNER JOIN teacher_settlement_entries membership ON membership.settlement_id=settlement.id
            WHERE settlement.status IN ('draft','approved') AND ${settlementWhere} GROUP BY settlement.teacher_id, settlement.currency
          ), paid AS (
            SELECT settlement.teacher_id, settlement.currency, COALESCE(SUM(settlement.payout_amount_minor),0)::text AS paid_minor,
              MAX(settlement.paid_at) AS last_settlement_date
            FROM teacher_settlements settlement WHERE settlement.status='paid' AND settlement.paid_at >= $1 AND settlement.paid_at < $2 AND ${settlementWhere}
            GROUP BY settlement.teacher_id, settlement.currency
          ), active AS (
            SELECT settlement.teacher_id, settlement.currency, MAX(settlement.status) AS active_settlement_status
            FROM teacher_settlements settlement WHERE settlement.status IN ('draft','approved') AND ${settlementWhere}
            GROUP BY settlement.teacher_id, settlement.currency
          ), teachers AS (
            SELECT teacher_id, currency FROM sales UNION SELECT teacher_id, currency FROM ledger UNION SELECT teacher_id, currency FROM reserved
          )
          SELECT teachers.teacher_id, teacher.name AS teacher_name, teacher.email AS teacher_email, teachers.currency,
            COALESCE(sales.order_count,'0') AS order_count, COALESCE(sales.gross_sales_minor,'0') AS gross_sales_minor,
            COALESCE(sales.platform_commission_minor,'0') AS platform_commission_minor,
            COALESCE(sales.teacher_entitlement_minor,'0') AS teacher_entitlement_minor,
            COALESCE(returns.refunds_minor,'0') AS refunds_minor, COALESCE(ledger.pending_minor,'0') AS pending_minor,
            COALESCE(ledger.available_minor,'0') AS available_minor, COALESCE(reserved.reserved_minor,'0') AS reserved_minor,
            COALESCE(paid.paid_minor,'0') AS paid_minor,
            GREATEST(COALESCE(ledger.pending_minor::bigint,0)+COALESCE(ledger.available_minor::bigint,0)-COALESCE(reserved.reserved_minor::bigint,0),0)::text AS remaining_payable_minor,
            paid.last_settlement_date, active.active_settlement_status, COALESCE(sales.average_order_value_minor,'0') AS average_order_value_minor,
            (COALESCE(sales.gross_sales_minor::bigint,0)-COALESCE(prior.gross_sales_minor::bigint,0))::text AS revenue_change_minor,
            CASE WHEN COALESCE(prior.gross_sales_minor::bigint,0)=0 THEN NULL ELSE ROUND((COALESCE(sales.gross_sales_minor::numeric,0)-prior.gross_sales_minor::numeric)*10000/prior.gross_sales_minor::numeric)::text END AS revenue_growth_bps,
            COUNT(*) OVER()::text AS total_count
          FROM teachers INNER JOIN users teacher ON teacher.id=teachers.teacher_id
          LEFT JOIN sales USING (teacher_id,currency) LEFT JOIN prior USING (teacher_id,currency) LEFT JOIN returns USING (teacher_id,currency)
          LEFT JOIN ledger USING (teacher_id,currency) LEFT JOIN reserved USING (teacher_id,currency) LEFT JOIN paid USING (teacher_id,currency) LEFT JOIN active USING (teacher_id,currency)
          ORDER BY COALESCE(sales.gross_sales_minor::bigint,0) DESC, teacher.name ASC
          LIMIT $${limitIndex} OFFSET $${offsetIndex}
        `,
              params,
            );
          }),
      !want('revenue_trends')
        ? Promise.resolve([])
        : this.runCurrentFinancialReportQuery(filter, bounds, async ({ current, params }) => {
            const bucket = filter.group_by ?? 'day';
            return this.dataSource.query(
              `
          WITH ${current}
          SELECT date_trunc('${bucket}', paid_at) AS period, currency, COUNT(*)::text AS order_count,
            COALESCE(SUM(final_amount_minor),0)::text AS gross_revenue_minor,
            COALESCE(SUM(platform_commission_minor),0)::text AS platform_revenue_minor,
            COALESCE(SUM(teacher_earning_minor),0)::text AS teacher_earnings_minor
          FROM current_orders GROUP BY date_trunc('${bucket}', paid_at), currency ORDER BY period ASC, currency ASC
        `,
              params,
            );
          }),
      !want('product_breakdown')
        ? Promise.resolve([])
        : this.runCurrentFinancialReportQuery(filter, bounds, async ({ current, params }) =>
            this.dataSource.query(
              `
        WITH ${current}
        SELECT item_type, currency, COUNT(*)::text AS order_count, COALESCE(SUM(final_amount_minor),0)::text AS gross_sales_minor,
          COALESCE(SUM(platform_commission_minor),0)::text AS platform_revenue_minor,
          COALESCE(SUM(teacher_earning_minor),0)::text AS teacher_entitlement_minor,
          COALESCE(SUM(refunded_amount_minor),0)::text AS refunds_minor,
          (COALESCE(SUM(final_amount_minor),0)-COALESCE(SUM(refunded_amount_minor),0))::text AS net_revenue_minor
        FROM current_orders GROUP BY item_type,currency ORDER BY SUM(final_amount_minor) DESC
      `,
              params,
            ),
          ),
      !want('top_products')
        ? Promise.resolve([])
        : this.runCurrentFinancialReportQuery(filter, bounds, async ({ current, params }) =>
            this.dataSource.query(
              `
        WITH ${current}
        SELECT item_type, item_id, product_title_snapshot, currency, COUNT(*)::text AS order_count,
          COALESCE(SUM(final_amount_minor),0)::text AS gross_sales_minor
        FROM current_orders GROUP BY item_type, item_id, product_title_snapshot, currency
        ORDER BY SUM(final_amount_minor) DESC LIMIT 50
      `,
              params,
            ),
          ),
      !want('settlement_analytics')
        ? Promise.resolve([])
        : (async () => {
            // No orders CTE here, so the parameter list starts empty: sharing the CTE's list made these
            // filters `$9`/`$10` with `$1..$8` unreferenced ("could not determine data type of parameter $1").
            const params: unknown[] = [];
            const settlementWhere = this.reportSettlementWhere(filter, params, 'settlement');
            return this.dataSource.query(
              `
          SELECT settlement.currency, settlement.status, COUNT(*)::text AS settlement_count,
            COALESCE(SUM(settlement.payout_amount_minor),0)::text AS payout_minor,
            COALESCE(ROUND(AVG(settlement.payout_amount_minor)),0)::text AS average_payout_minor,
            COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (settlement.paid_at-settlement.created_at)))),0)::text AS average_payment_seconds
          FROM teacher_settlements settlement WHERE ${settlementWhere}
          GROUP BY settlement.currency, settlement.status ORDER BY settlement.currency, settlement.status
        `,
              params,
            );
          })(),
      !want('ledger_movements')
        ? Promise.resolve([])
        : filter.teacher_id
          ? (async () => {
              const params: unknown[] = [];
              const ledgerWhere = this.reportLedgerWhere(filter, params, 'entry');
              return this.dataSource.query(
                `
            SELECT entry.id, entry.currency, entry.account, entry.direction, entry.amount_minor::text AS amount_minor,
              entry.entry_type, entry.reference, entry.created_at
            FROM financial_ledger_entries entry WHERE ${ledgerWhere}
            ORDER BY entry.created_at DESC, entry.id DESC LIMIT 50
          `,
                params,
              );
            })()
          : Promise.resolve([]),
      !want('settlement_history')
        ? Promise.resolve([])
        : filter.teacher_id
          ? (async () => {
              const params: unknown[] = [];
              const settlementWhere = this.reportSettlementWhere(filter, params, 'settlement');
              return this.dataSource.query(
                `
            SELECT settlement.id, settlement.settlement_number, settlement.currency, settlement.status,
              settlement.payout_amount_minor::text AS payout_amount_minor, settlement.paid_at, settlement.created_at
            FROM teacher_settlements settlement WHERE ${settlementWhere}
            ORDER BY settlement.created_at DESC, settlement.id DESC LIMIT 50
          `,
                params,
              );
            })()
          : Promise.resolve([]),
    ]);
    const value = <T>(index: number, fallback: T): T => {
      const result = results[index];
      if (!result || result.status !== 'fulfilled') return fallback;
      return result.value as T;
    };
    const widgetErrors = results.flatMap((result, index) =>
      result.status === 'rejected'
        ? [
            {
              widget: [
                'summary',
                'teacher_receivables',
                'revenue_trends',
                'product_breakdown',
                'top_products',
                'settlement_analytics',
                'ledger_movements',
                'settlement_history',
              ][index],
            },
          ]
        : [],
    );
    const summary = value<Array<Record<string, unknown>>>(0, []);
    const teacherRows = value<Array<Record<string, unknown>>>(1, []);
    const trends = value<Array<Record<string, unknown>>>(2, []);
    const products = value<Array<Record<string, unknown>>>(3, []);
    const topProducts = value<Array<Record<string, unknown>>>(4, []);
    const settlementRows = value<Array<Record<string, unknown>>>(5, []);
    const ledgerMovements = value<Array<Record<string, unknown>>>(6, []);
    const settlementHistory = value<Array<Record<string, unknown>>>(7, []);
    const page = filter.page ?? 1;
    const limit = Math.min(filter.limit ?? 20, 100);
    const total = Number.parseInt(
      String((teacherRows as Array<Record<string, unknown>>)[0]?.['total_count'] ?? '0'),
      10,
    );
    return {
      generated_at: new Date().toISOString(),
      period: {
        from: bounds.start.toISOString(),
        to: bounds.end.toISOString(),
        previous_from: bounds.previousStart.toISOString(),
        previous_to: bounds.previousEnd.toISOString(),
        group_by: filter.group_by ?? 'day',
      },
      filters: filter,
      summary,
      teachers: {
        data: teacherRows,
        meta: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
          hasNextPage: page * limit < total,
          hasPrevPage: page > 1,
        },
      },
      trends,
      product_breakdown: products,
      top_products: topProducts,
      settlement_analytics: settlementRows,
      ledger_movements: ledgerMovements,
      settlement_history: settlementHistory,
      widget_errors: widgetErrors,
    };
  }

  public async financialReportCsv(filter: FinancialReportFilterDto): Promise<string> {
    // The export is always the full report, whatever widget selection was sent.
    const { widgets: _ignoredWidgets, ...fullFilter } = filter;
    const report = await this.financialReport({ ...fullFilter, page: 1, limit: 100 });
    const summary = report['summary'] as Array<Record<string, unknown>>;
    const teachers = (report['teachers'] as { data: Array<Record<string, unknown>> }).data;
    const escape = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const lines = [
      ['Generated at', report['generated_at']],
      [
        'Period',
        (report['period'] as Record<string, unknown>)['from'],
        (report['period'] as Record<string, unknown>)['to'],
      ],
      [],
      [
        'Currency',
        'Gross revenue minor',
        'Platform revenue minor',
        'Teacher earnings minor',
        'Refunds minor',
        'Available payout minor',
        'Reserved minor',
        'Paid to teachers minor',
        'Outstanding minor',
        'Net revenue minor',
      ],
      ...summary.map((row) => [
        row['currency'],
        row['gross_revenue_minor'],
        row['platform_revenue_minor'],
        row['teacher_earnings_minor'],
        row['refunds_minor'],
        row['available_for_payout_minor'],
        row['reserved_in_settlements_minor'],
        row['paid_to_teachers_minor'],
        row['outstanding_teacher_payables_minor'],
        row['net_revenue_minor'],
      ]),
      [],
      [
        'Teacher',
        'Currency',
        'Gross sales minor',
        'Orders',
        'Platform commission minor',
        'Teacher entitlement minor',
        'Refunds minor',
        'Pending minor',
        'Available minor',
        'Reserved minor',
        'Paid minor',
        'Remaining payable minor',
      ],
      ...teachers.map((row) => [
        row['teacher_name'],
        row['currency'],
        row['gross_sales_minor'],
        row['order_count'],
        row['platform_commission_minor'],
        row['teacher_entitlement_minor'],
        row['refunds_minor'],
        row['pending_minor'],
        row['available_minor'],
        row['reserved_minor'],
        row['paid_minor'],
        row['remaining_payable_minor'],
      ]),
    ];
    return lines.map((line) => line.map(escape).join(',')).join('\n');
  }

  private financialReportBounds(filter: FinancialReportFilterDto): {
    start: Date;
    end: Date;
    previousStart: Date;
    previousEnd: Date;
  } {
    const start = filter.from
      ? new Date(`${filter.from}T00:00:00.000Z`)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = filter.to ? new Date(`${filter.to}T00:00:00.000Z`) : new Date();
    if (filter.to) end.setUTCDate(end.getUTCDate() + 1);
    const duration = end.getTime() - start.getTime();
    return {
      start,
      end,
      previousStart: new Date(start.getTime() - duration),
      previousEnd: new Date(start),
    };
  }

  private paidOrdersCte(
    filter: FinancialReportFilterDto,
    start: Date,
    end: Date,
    params: unknown[],
    name: string,
  ): string {
    const push = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    // AUD-030: the settled population, not `status = 'paid'` alone. The report
    // body below already nets refunds correctly (`net_revenue_minor`, the
    // per-currency and per-teacher refund allocations); the bug was upstream of
    // that arithmetic — a partially- or fully-refunded order never entered the
    // CTE, so its retained revenue AND its refund both silently disappeared.
    const conditions = [
      `o.status IN (${SETTLED_ORDER_STATUS_SQL})`,
      `payment.status IN (${FINALISED_PAYMENT_STATUS_SQL})`,
      'o.paid_at IS NOT NULL',
      `o.paid_at >= ${push(start)}`,
      `o.paid_at < ${push(end)}`,
    ];
    if (filter.currency) conditions.push(`o.currency = ${push(filter.currency.toUpperCase())}`);
    if (filter.teacher_id) conditions.push(`o.teacher_id = ${push(filter.teacher_id)}`);
    if (filter.item_type) conditions.push(`o.item_type = ${push(filter.item_type)}`);
    if (filter.payment_method) conditions.push(`o.payment_method = ${push(filter.payment_method)}`);
    if (filter.search?.trim()) {
      const search = push(`%${filter.search.trim()}%`);
      conditions.push(
        `(o.product_title_snapshot ILIKE ${search} OR EXISTS (SELECT 1 FROM users search_teacher WHERE search_teacher.id=o.teacher_id AND (search_teacher.name ILIKE ${search} OR search_teacher.email ILIKE ${search})))`,
      );
    }
    return `${name} AS (SELECT o.id,o.teacher_id,o.currency,o.item_type,o.item_id,o.final_amount_minor,o.refunded_amount_minor,o.platform_commission_minor,o.teacher_earning_minor,o.paid_at,o.product_title_snapshot FROM orders o INNER JOIN payments payment ON payment.id=o.payment_id WHERE ${conditions.join(' AND ')})`;
  }

  private async runFinancialReportQuery<T>(
    filter: FinancialReportFilterDto,
    bounds: { start: Date; end: Date; previousStart: Date; previousEnd: Date },
    run: (input: { current: string; previous: string; params: unknown[] }) => Promise<T>,
  ): Promise<T> {
    const params: unknown[] = [];
    const current = this.paidOrdersCte(filter, bounds.start, bounds.end, params, 'current_orders');
    const previous = this.paidOrdersCte(
      filter,
      bounds.previousStart,
      bounds.previousEnd,
      params,
      'previous_orders',
    );
    return run({ current, previous, params });
  }

  private async runCurrentFinancialReportQuery<T>(
    filter: FinancialReportFilterDto,
    bounds: { start: Date; end: Date },
    run: (input: { current: string; params: unknown[] }) => Promise<T>,
  ): Promise<T> {
    const params: unknown[] = [];
    const current = this.paidOrdersCte(filter, bounds.start, bounds.end, params, 'current_orders');
    return run({ current, params });
  }

  private reportLedgerWhere(
    filter: FinancialReportFilterDto,
    params: unknown[],
    alias: string,
  ): string {
    const clauses = [`${alias}.teacher_id IS NOT NULL`];
    if (filter.currency) {
      params.push(filter.currency.toUpperCase());
      clauses.push(`${alias}.currency = $${params.length}`);
    }
    if (filter.teacher_id) {
      params.push(filter.teacher_id);
      clauses.push(`${alias}.teacher_id = $${params.length}`);
    }
    return clauses.join(' AND ');
  }

  private reportSettlementWhere(
    filter: FinancialReportFilterDto,
    params: unknown[],
    alias: string,
  ): string {
    const clauses = ['1 = 1'];
    if (filter.currency) {
      params.push(filter.currency.toUpperCase());
      clauses.push(`${alias}.currency = $${params.length}`);
    }
    if (filter.teacher_id) {
      params.push(filter.teacher_id);
      clauses.push(`${alias}.teacher_id = $${params.length}`);
    }
    if (filter.settlement_status) {
      params.push(filter.settlement_status);
      clauses.push(`${alias}.status = $${params.length}`);
    }
    return clauses.join(' AND ');
  }

  /**
   * T041 (`gates/W1-C8.md`, approved): a snapshot, not a live query. Computed at most once per TTL
   * (10 min) plus once per generation bump reaching `finance_reconciliation` — whichever visitor or the
   * maintenance pre-warm below hits it first pays the ~27-statement `reconciliationReport()` sweep; every
   * other reader gets the cached snapshot. `detected_at` is stamped inside `computeReconciliationWarnings`,
   * so it is always the real compute time, never the request time. `GET admin/finance/reconciliation` (the
   * live endpoint) calls `reconciliationReport()` directly and is unaffected by this cache.
   */
  public async reportReconciliationWarnings(): Promise<Array<Record<string, unknown>>> {
    return await this.applicationCache.getOrCompute(
      {
        family: 'finance_reconciliation',
        endpoint: 'payments.reconciliation-warnings',
        scope: 'role:admin',
        ttlMs: 600_000,
      },
      async () => await this.computeReconciliationWarnings(),
    );
  }

  private async computeReconciliationWarnings(): Promise<Array<Record<string, unknown>>> {
    const report = await this.reconciliationReport();
    const severityByKey: Record<string, 'critical' | 'warning'> = {
      negative_teacher_available_balances: 'critical',
      over_allocated_settlement_entries: 'critical',
      settlement_ledger_posting_mismatches: 'critical',
      payout_clearing_journal_completeness_issues: 'critical',
    };
    return Object.entries(report)
      .filter(([, value]) => Array.isArray(value) && value.length > 0)
      .map(([type, value]) => ({
        type,
        severity: severityByKey[type] ?? 'warning',
        detected_at: new Date().toISOString(),
        // Every `reconciliationReport()` sub-query is capped at 101 rows (T009): a count of 101 means
        // "101 or more" and the consumer (`admin/reports/page.tsx`) renders it as "100+"; below that,
        // the count is exact. Never a silent under-count from an unrelated internal LIMIT.
        affected_count: (value as unknown[]).length,
        samples: (value as unknown[]).slice(0, 5),
      }));
  }
}
