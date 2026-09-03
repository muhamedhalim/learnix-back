import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { biBody } from '../../i18n/error-translator.util';
import { InstructorEarningStatus } from '../common/enums';
import { InstructorEarning } from './entities/instructor-earning.entity';

const TRANSITIONS: Record<InstructorEarningStatus, InstructorEarningStatus[]> = {
  [InstructorEarningStatus.PENDING_EARNINGS]: [InstructorEarningStatus.REFUND_CLEARANCE, InstructorEarningStatus.REVERSED],
  [InstructorEarningStatus.REFUND_CLEARANCE]: [InstructorEarningStatus.AVAILABLE_BALANCE, InstructorEarningStatus.REVERSED],
  [InstructorEarningStatus.AVAILABLE_BALANCE]: [InstructorEarningStatus.PAYOUT_REQUESTED, InstructorEarningStatus.REVERSED],
  [InstructorEarningStatus.PAYOUT_REQUESTED]: [
    InstructorEarningStatus.PROCESSING,
    InstructorEarningStatus.AVAILABLE_BALANCE,
    InstructorEarningStatus.REVERSED,
  ],
  [InstructorEarningStatus.PROCESSING]: [InstructorEarningStatus.PAID_OUT, InstructorEarningStatus.AVAILABLE_BALANCE],
  [InstructorEarningStatus.PAID_OUT]: [InstructorEarningStatus.AVAILABLE_BALANCE],
  [InstructorEarningStatus.REVERSED]: [],
};

/**
 * FR-142 – FR-144, FR-156 (T162). The single place `InstructorEarning.status`
 * is ever mutated for the clearance/payout lifecycle — every other service
 * that moves an earning through this lifecycle (the clearance sweep,
 * `PayoutRequestService`, `PayoutAdminService`) calls through here rather
 * than writing `status` directly, so the closed transition table in
 * `TRANSITIONS` is the one place that can ever refuse an illegal move.
 *
 * `RefundProcessingService.completeReversal()` (Phase 9) is the one
 * deliberate exception: FR-144 makes `REVERSED` reachable from every other
 * state as a universal escape hatch, and that code path already sets it
 * directly (predating this service). Not retrofitted here — the two never
 * conflict (both ultimately just flip `status`), and routing an
 * already-verified, financially-critical reversal transaction through a
 * new abstraction for marginal architectural purity was judged not worth
 * the regression risk. `transition()` still accepts `REVERSED` as a valid
 * target from any non-terminal state for any *future* caller that needs it.
 *
 * Amounts (`gross_amount_minor`/`commission_amount_minor`/`net_amount_minor`)
 * are never touched here at all (FR-156) — a correction is a ledger
 * adjustment (T171), never an edit to the earning row.
 */
@Injectable()
export class EarningsService {
  public async transition(
    manager: EntityManager,
    earningId: string,
    to: InstructorEarningStatus,
    extra: Partial<Pick<InstructorEarning, 'payout_request_id' | 'reversed_at' | 'reversal_reason'>> = {},
  ): Promise<InstructorEarning> {
    const earning = await manager.findOne(InstructorEarning, {
      where: { id: earningId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!earning) {
      throw new NotFoundException(biBody('Earning not found', 'الدخل غير موجود'));
    }
    if (!TRANSITIONS[earning.status].includes(to)) {
      throw new ConflictException(
        biBody(`An earning cannot move from ${earning.status} to ${to}`, `لا يمكن أن ينتقل الدخل من ${earning.status} إلى ${to}`),
      );
    }
    Object.assign(earning, extra, { status: to });
    return manager.save(InstructorEarning, earning);
  }

  /** FR-145: entered immediately once the order's payment is confirmed settled — in this codebase, the same moment settlement itself runs. */
  public async moveToRefundClearance(manager: EntityManager, earningId: string): Promise<InstructorEarning> {
    return this.transition(manager, earningId, InstructorEarningStatus.REFUND_CLEARANCE);
  }

  /** FR-147: the clearance sweep's own transition. */
  public async moveToAvailableBalance(manager: EntityManager, earningId: string): Promise<InstructorEarning> {
    return this.transition(manager, earningId, InstructorEarningStatus.AVAILABLE_BALANCE, {
      payout_request_id: null,
    });
  }

  /** FR-210: locks the earning into a payout request at the moment the request is created. */
  public async lockForPayout(manager: EntityManager, earningId: string, payoutRequestId: string): Promise<InstructorEarning> {
    return this.transition(manager, earningId, InstructorEarningStatus.PAYOUT_REQUESTED, {
      payout_request_id: payoutRequestId,
    });
  }

  /** FR-218: the payout containing this earning has started processing. */
  public async markProcessing(manager: EntityManager, earningId: string): Promise<InstructorEarning> {
    return this.transition(manager, earningId, InstructorEarningStatus.PROCESSING);
  }

  /** FR-214, FR-217, FR-221: a request cancelled/rejected/failed returns its earnings to available balance. Valid from `PAYOUT_REQUESTED`, `PROCESSING` or `PAID_OUT`. */
  public async releaseToAvailable(manager: EntityManager, earningId: string): Promise<InstructorEarning> {
    return this.transition(manager, earningId, InstructorEarningStatus.AVAILABLE_BALANCE, {
      payout_request_id: null,
    });
  }

  /** FR-220: the payout was marked paid. */
  public async markPaidOut(manager: EntityManager, earningId: string): Promise<InstructorEarning> {
    return this.transition(manager, earningId, InstructorEarningStatus.PAID_OUT);
  }
}
