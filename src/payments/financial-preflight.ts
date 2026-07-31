/**
 * Read-only production preflight for payout hardening migrations.  It never
 * repairs data: operators must quarantine or correct each reported row before
 * the migration can create stricter constraints.
 */
export interface SqlQueryable {
  query<T = unknown>(query: string, parameters?: unknown[]): Promise<T>;
}

export type FinancialPreflightFinding = {
  code: string;
  rows: Array<Record<string, unknown>>;
  remediation: string;
};

export type FinancialPreflightReport = {
  checked_at: string;
  findings: FinancialPreflightFinding[];
  valid: boolean;
};

const checks: Array<{
  code: string;
  sql: string;
  remediation: string;
}> = [
  {
    code: 'duplicate_normalized_transfer_reference',
    sql: `SELECT lower(btrim(transfer_reference)) AS transfer_reference, array_agg(id) AS settlement_ids
          FROM teacher_settlements WHERE status = 'paid' AND transfer_reference IS NOT NULL
          GROUP BY lower(btrim(transfer_reference)) HAVING COUNT(*) > 1 LIMIT 100`,
    remediation:
      'Quarantine every conflicting payout for finance review. Retain all rows; correct the external reference only with an auditable adjustment before retrying.',
  },
  {
    code: 'duplicate_idempotency_key',
    sql: `SELECT idempotency_key, array_agg(id) AS settlement_ids FROM teacher_settlements
          GROUP BY idempotency_key HAVING COUNT(*) > 1 LIMIT 100`,
    remediation:
      'Quarantine duplicate requests and determine the single original business action. Do not delete settlements or ledger rows.',
  },
  {
    code: 'invalid_settlement_allocation',
    sql: `SELECT id, settlement_id, ledger_entry_id, amount_minor FROM teacher_settlement_entries
          WHERE amount_minor IS NULL OR amount_minor <= 0 LIMIT 100`,
    remediation:
      'Quarantine the affected settlement. Record a compensating adjustment or reconstruct the allocation from source evidence; never delete the allocation history.',
  },
  {
    code: 'over_allocated_ledger_entry',
    sql: `SELECT membership.ledger_entry_id, SUM(membership.amount_minor)::text AS allocated_minor,
                 MAX(entry.amount_minor)::text AS earning_minor
          FROM teacher_settlement_entries membership
          JOIN teacher_settlements settlement ON settlement.id = membership.settlement_id
          JOIN financial_ledger_entries entry ON entry.id = membership.ledger_entry_id
          WHERE settlement.status IN ('draft','approved','paid')
          GROUP BY membership.ledger_entry_id HAVING SUM(membership.amount_minor) > MAX(entry.amount_minor) LIMIT 100`,
    remediation:
      'Quarantine all open settlements using the earning and resolve through cancellation/rejection plus a new, correctly allocated settlement.',
  },
  {
    code: 'cross_currency_allocation',
    sql: `SELECT membership.id, membership.settlement_id, membership.ledger_entry_id,
                 settlement.currency AS settlement_currency, entry.currency AS ledger_currency
          FROM teacher_settlement_entries membership
          JOIN teacher_settlements settlement ON settlement.id = membership.settlement_id
          JOIN financial_ledger_entries entry ON entry.id = membership.ledger_entry_id
          WHERE settlement.currency <> entry.currency LIMIT 100`,
    remediation:
      'Quarantine the settlement and replace it with separate currency-specific settlements after finance approval.',
  },
  {
    code: 'duplicate_logical_payout',
    sql: `SELECT teacher_id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM') AS fiscal_period,
                 currency, payout_amount_minor, array_agg(id) AS settlement_ids
          FROM teacher_settlements WHERE status IN ('draft','approved','paid')
          GROUP BY teacher_id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM'), currency, payout_amount_minor
          HAVING COUNT(*) > 1 LIMIT 100`,
    remediation:
      'Quarantine duplicate active payouts. Cancel or reject only the duplicate business action with an audit reason; do not remove historical rows.',
  },
  {
    code: 'financial_orphan',
    sql: `SELECT 'ledger.order' AS relation, entry.id FROM financial_ledger_entries entry LEFT JOIN orders o ON o.id = entry.order_id WHERE o.id IS NULL
          UNION ALL SELECT 'refund.order', refund.id FROM refunds refund LEFT JOIN orders o ON o.id = refund.order_id WHERE o.id IS NULL
          UNION ALL SELECT 'settlement_entry.settlement', membership.id FROM teacher_settlement_entries membership LEFT JOIN teacher_settlements s ON s.id = membership.settlement_id WHERE s.id IS NULL
          UNION ALL SELECT 'settlement_entry.ledger', membership.id FROM teacher_settlement_entries membership LEFT JOIN financial_ledger_entries entry ON entry.id = membership.ledger_entry_id WHERE entry.id IS NULL
          LIMIT 100`,
    remediation:
      'Quarantine orphaned records and restore the missing parent or retain the record in a documented financial exception workflow before applying foreign keys.',
  },
];

export async function runFinancialPreflight(db: SqlQueryable): Promise<FinancialPreflightReport> {
  const findings: FinancialPreflightFinding[] = [];
  for (const check of checks) {
    const rows = (await db.query<Array<Record<string, unknown>>>(check.sql)) ?? [];
    if (rows.length) findings.push({ code: check.code, rows, remediation: check.remediation });
  }
  return { checked_at: new Date().toISOString(), findings, valid: findings.length === 0 };
}

export function formatFinancialPreflightReport(report: FinancialPreflightReport): string {
  if (report.valid) return 'Financial payout preflight passed: no blocking data violations found.';
  return [
    'Financial payout preflight failed. No schema modification was applied.',
    ...report.findings.flatMap((finding) => [
      `- ${finding.code}: ${finding.rows.length} sample violation(s).`,
      `  Remediation/quarantine: ${finding.remediation}`,
    ]),
  ].join('\n');
}
