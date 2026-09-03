import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { MarketplaceLedgerDirection, MarketplaceLedgerEntryType } from '../common/enums';
import { InstructorEarning } from './entities/instructor-earning.entity';
import { MarketplaceLedgerEntry } from './entities/marketplace-ledger-entry.entity';
import { LedgerService, MarketplaceBalance } from './ledger.service';

export interface MarketplaceBalanceWithShortfall extends MarketplaceBalance {
  /** FR-195, FR-196 — outstanding refund-after-payout shortfall in this currency. Never negative, never clamped away. */
  shortfallMinor: number;
}

/**
 * T139 (initial version; extended by T164 with the actual payout-time
 * clawback). A refund can land after its earning already moved to
 * `paid_out` — real money already left the platform for that specific
 * earning, so there is nothing left on that row to reverse. `deriveBalance()`
 * has no notion of this case; this service layers it on top rather than
 * folding it into `availableMinor`, so the later payout-eligibility work in
 * T164 can decide exactly how the carry-forward deduction is applied
 * without this initial version pre-committing to that mechanism.
 */
@Injectable()
export class BalanceService {
  constructor(
    private readonly ledger: LedgerService,
    @InjectRepository(MarketplaceLedgerEntry)
    private readonly ledgerEntries: Repository<MarketplaceLedgerEntry>,
    @InjectRepository(InstructorEarning)
    private readonly earnings: Repository<InstructorEarning>,
  ) {}

  public async getBalance(
    instructorId: string,
    currency: string,
  ): Promise<MarketplaceBalanceWithShortfall> {
    const [balance, shortfallMinor] = await Promise.all([
      this.ledger.deriveBalance(instructorId, currency),
      this.getShortfall(instructorId, currency),
    ]);
    return { ...balance, shortfallMinor };
  }

  /**
   * FR-151 (T164): every currency this instructor has ever held an earning
   * in, each derived independently — the figures are never summed or
   * merged across currencies, only returned side by side so a frontend can
   * render them as separate cards.
   */
  public async getAllBalances(instructorId: string): Promise<MarketplaceBalanceWithShortfall[]> {
    const rows = await this.earnings
      .createQueryBuilder('e')
      .select('DISTINCT e.currency', 'currency')
      .where('e.instructor_id = :instructorId', { instructorId })
      .getRawMany<{ currency: string }>();

    return Promise.all(rows.map((row) => this.getBalance(instructorId, row.currency)));
  }

  /** The full outstanding shortfall — every `REFUND_SHORTFALL` entry is DEBIT and none is ever reduced, so this is a plain sum. */
  public async getShortfall(instructorId: string, currency: string): Promise<number> {
    const { total } = (await this.ledgerEntries
      .createQueryBuilder('l')
      .select('COALESCE(SUM(l.amount_minor), 0)', 'total')
      .where('l.instructor_id = :instructorId', { instructorId })
      .andWhere('l.currency = :currency', { currency })
      .andWhere('l.entry_type = :type', { type: MarketplaceLedgerEntryType.REFUND_SHORTFALL })
      .andWhere('l.direction = :direction', { direction: MarketplaceLedgerDirection.DEBIT })
      .getRawOne<{ total: string }>()) ?? { total: '0' };
    return Number.parseInt(total, 10);
  }

  /**
   * Records a shortfall in full for one already-paid-out earning being
   * reversed by a refund. Always takes the caller's transactional
   * `manager` — same atomicity reasoning as `LedgerService.post()`.
   */
  public async recordShortfall(
    manager: EntityManager,
    instructorId: string,
    amountMinor: number,
    currency: string,
    refundRequestId: string,
  ): Promise<void> {
    await this.ledger.post(
      {
        instructorId,
        orderId: null,
        entryType: MarketplaceLedgerEntryType.REFUND_SHORTFALL,
        amountMinor,
        currency,
        direction: MarketplaceLedgerDirection.DEBIT,
        reference: `refund:${refundRequestId}:shortfall`,
        sourceEventId: refundRequestId,
        sourceEventType: 'marketplace.refund.completed',
        metadata: { reason: 'refund_after_payout_shortfall' },
      },
      manager,
    );
  }
}
