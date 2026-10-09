import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { InstructorEarningStatus, MarketplaceLedgerEntryType } from '../common/enums';
import { BalanceService } from './balance.service';
import { InstructorEarning } from './entities/instructor-earning.entity';
import { MarketplaceLedgerEntry } from './entities/marketplace-ledger-entry.entity';

export interface DivergenceRecord {
  type: string;
  severity: 'critical' | 'warning';
  detected_at: string;
  affected_count: number;
  samples: unknown[];
}

/**
 * FR-172, FR-234 (T165). Mirrors the shape of the academic
 * `PaymentOperationsService.reconciliationReport()` /
 * `reportReconciliationWarnings()` split — one method producing named
 * check results, a second wrapping the non-empty ones into severity-tagged
 * divergence records — but the specific checks are new: nothing in the
 * marketplace schema has an academic-style cached `account` balance field
 * to compare against (`marketplace_ledger_entries` has no `account`
 * column), so "cache" here means the earning's own `status` — a piece of
 * denormalized state that the ledger's actual entries should always be
 * consistent with. The ledger-derived figure (`LedgerService.deriveBalance()`,
 * via `BalanceService`) is always treated as correct; a divergence never
 * corrects itself automatically, only surfaces for an admin.
 */
@Injectable()
export class ReconciliationService {
  constructor(
    @InjectRepository(InstructorEarning) private readonly earnings: Repository<InstructorEarning>,
    @InjectRepository(MarketplaceLedgerEntry) private readonly ledgerEntries: Repository<MarketplaceLedgerEntry>,
    private readonly balance: BalanceService,
  ) {}

  public async getDivergenceReport(): Promise<Record<string, unknown[]>> {
    const [negativeBalances, missingSaleEntries, reversedMissingRefundEntries, unauthoredAdjustments] = await Promise.all([
      this.negativeBalances(),
      this.earningsMissingSaleEntry(),
      this.reversedEarningsMissingRefundEntry(),
      this.manualAdjustmentsMissingActorOrReason(),
    ]);
    return {
      negative_available_balances: negativeBalances,
      earnings_missing_sale_entry: missingSaleEntries,
      reversed_earnings_missing_refund_entry: reversedMissingRefundEntries,
      manual_adjustments_missing_actor_or_reason: unauthoredAdjustments,
    };
  }

  public async getDivergenceWarnings(): Promise<DivergenceRecord[]> {
    const report = await this.getDivergenceReport();
    const severityByKey: Record<string, 'critical' | 'warning'> = {
      negative_available_balances: 'critical',
      earnings_missing_sale_entry: 'critical',
      reversed_earnings_missing_refund_entry: 'warning',
      manual_adjustments_missing_actor_or_reason: 'critical',
    };
    return Object.entries(report)
      .filter(([, value]) => value.length > 0)
      .map(([type, value]) => ({
        type,
        severity: severityByKey[type] ?? 'warning',
        detected_at: new Date().toISOString(),
        affected_count: value.length,
        samples: value.slice(0, 5),
      }));
  }

  /** FR-173: a genuine negative balance must be visible, never silently clamped or hidden. */
  private async negativeBalances(): Promise<Array<{ instructor_id: string; currency: string; available_minor: number }>> {
    // T067: one grouped derivation for every (instructor, currency) pair instead of 9 statements each.
    const balances = await this.balance.getBalancesGrouped();
    return balances
      .filter((derived) => derived.availableMinor < 0)
      .map((derived) => ({
        instructor_id: derived.instructorId,
        currency: derived.currency,
        available_minor: derived.availableMinor,
      }));
  }

  /** FR-165: COURSE_SALE must be posted atomically with earning creation — this should never fire, and firing means that atomicity broke somewhere. */
  private async earningsMissingSaleEntry(): Promise<Array<{ earning_id: string; order_id: string }>> {
    const rows = await this.earnings
      .createQueryBuilder('e')
      .where('e.status != :pending', { pending: InstructorEarningStatus.PENDING_EARNINGS })
      .andWhere(
        (qb) =>
          `NOT EXISTS (${qb
            .subQuery()
            .select('1')
            .from(MarketplaceLedgerEntry, 'l')
            .where('l.order_id = e.order_id')
            .andWhere('l.entry_type = :saleType')
            .getQuery()})`,
      )
      .setParameter('saleType', MarketplaceLedgerEntryType.COURSE_SALE)
      .select(['e.id AS earning_id', 'e.order_id AS order_id'])
      .limit(100)
      .getRawMany<{ earning_id: string; order_id: string }>();
    return rows;
  }

  /** FR-166: REFUND must be posted atomically with the reversal — a REVERSED earning with no REFUND entry means the reversal transaction was somehow incomplete. */
  private async reversedEarningsMissingRefundEntry(): Promise<Array<{ earning_id: string; order_id: string }>> {
    const rows = await this.earnings
      .createQueryBuilder('e')
      .where('e.status = :reversed', { reversed: InstructorEarningStatus.REVERSED })
      .andWhere(
        (qb) =>
          `NOT EXISTS (${qb
            .subQuery()
            .select('1')
            .from(MarketplaceLedgerEntry, 'l')
            .where('l.order_id = e.order_id')
            .andWhere('l.entry_type = :refundType')
            .getQuery()})`,
      )
      .setParameter('refundType', MarketplaceLedgerEntryType.REFUND)
      .select(['e.id AS earning_id', 'e.order_id AS order_id'])
      .limit(100)
      .getRawMany<{ earning_id: string; order_id: string }>();
    return rows;
  }

  /** FR-168: defense in depth beyond `CHK_mp_ledger_adjustment_reason` — should never fire through the app-level `LedgerService.post()` path, only if that constraint were ever bypassed (a raw migration, a direct DB edit). */
  private async manualAdjustmentsMissingActorOrReason(): Promise<Array<{ id: string; created_by: string | null }>> {
    const rows = await this.ledgerEntries
      .createQueryBuilder('l')
      .where('l.entry_type = :type', { type: MarketplaceLedgerEntryType.MANUAL_ADJUSTMENT })
      .andWhere("(l.created_by IS NULL OR NOT (l.metadata ? 'reason'))")
      .select(['l.id AS id', 'l.created_by AS created_by'])
      .limit(100)
      .getRawMany<{ id: string; created_by: string | null }>();
    return rows;
  }
}
