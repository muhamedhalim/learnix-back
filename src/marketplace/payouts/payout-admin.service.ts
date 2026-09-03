import { BadRequestException, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';

import { ActivityLogsService } from '../../activity-logs/activity-logs.service';
import { retryTransaction } from '../../common/utils/transaction-retry.util';
import { biBody } from '../../i18n/error-translator.util';
import { MarketplaceLedgerDirection, MarketplaceLedgerEntryType, PayoutRequestStatus } from '../common/enums';
import { EarningsService } from '../earnings/earnings.service';
import { InstructorEarning } from '../earnings/entities/instructor-earning.entity';
import { LedgerService } from '../earnings/ledger.service';
import { MarketplacePayoutDecisionEvent } from '../events/audit.events';
import {
  MarketplacePayoutApprovedEvent,
  MarketplacePayoutFailedEvent,
  MarketplacePayoutPaidEvent,
  MarketplacePayoutProcessingEvent,
  MarketplacePayoutRejectedEvent,
} from '../events/domain.events';
import { MarketplacePayoutRequest } from './entities';
import { PayoutRequestService } from './payout-request.service';

/**
 * FR-216 – FR-221 (T169, T170). Every admin-driven transition of the
 * payout state machine — approve, reject, processing, paid, and the
 * failure/reversal case. Delegates the actual state change to
 * `PayoutRequestService.transition()` (the one closed transition table),
 * and owns only what's specific to *being* an admin action: the ledger
 * entries and earning-status side effects each transition requires.
 *
 * No maker-checker restriction (an admin approving their own later "pay"
 * action) is enforced here, unlike the academic `SettlementsService` — no
 * task AC or FR requires it for marketplace payouts; FR-226 only requires
 * view/approve/pay to be *individually privileged*, not mutually exclusive
 * to one actor. Scope decision, not an oversight.
 */
@Injectable()
export class PayoutAdminService {
  constructor(
    private readonly payoutRequests: PayoutRequestService,
    private readonly earningsService: EarningsService,
    private readonly ledger: LedgerService,
    private readonly dataSource: DataSource,
    private readonly eventEmitter: EventEmitter2,
    private readonly activityLogs: ActivityLogsService,
  ) {}

  public async approve(adminId: string, requestId: string): Promise<MarketplacePayoutRequest> {
    const approved = await retryTransaction(this.dataSource, async (manager) => {
      const request = await this.payoutRequests.getOwnedOrThrow(manager, requestId);
      return this.payoutRequests.transition(manager, request, PayoutRequestStatus.APPROVED, {
        decided_by: adminId,
        approved_at: new Date(),
      });
    });
    this.eventEmitter.emit(
      MarketplacePayoutApprovedEvent.EVENT_NAME,
      new MarketplacePayoutApprovedEvent(approved.id, approved.instructor_id),
    );
    await this.activityLogs.recordAuditEvent(
      new MarketplacePayoutDecisionEvent(adminId, approved.id, {
        instructorId: approved.instructor_id,
        decision: 'approved',
      }),
    );
    return approved;
  }

  /** FR-217: returns the locked amount to available balance. */
  public async reject(adminId: string, requestId: string, reason: string): Promise<MarketplacePayoutRequest> {
    if (!reason?.trim()) {
      throw new BadRequestException(biBody('A reason is required to reject a payout request', 'السبب مطلوب لرفض طلب السحب'));
    }
    const rejected = await retryTransaction(this.dataSource, async (manager) => {
      const request = await this.payoutRequests.getOwnedOrThrow(manager, requestId);
      const result = await this.payoutRequests.transition(manager, request, PayoutRequestStatus.REJECTED, {
        decided_by: adminId,
        reason,
      });
      await this.payoutRequests.releaseEarnings(manager, requestId);
      return result;
    });
    this.eventEmitter.emit(
      MarketplacePayoutRejectedEvent.EVENT_NAME,
      new MarketplacePayoutRejectedEvent(rejected.id, rejected.instructor_id, reason),
    );
    await this.activityLogs.recordAuditEvent(
      new MarketplacePayoutDecisionEvent(adminId, rejected.id, {
        instructorId: rejected.instructor_id,
        decision: 'rejected',
        reason,
      }),
    );
    return rejected;
  }

  /** FR-218: the amount remains locked throughout — only the covered earnings' own status moves. */
  public async markProcessing(adminId: string, requestId: string): Promise<MarketplacePayoutRequest> {
    const processing = await retryTransaction(this.dataSource, async (manager) => {
      const request = await this.payoutRequests.getOwnedOrThrow(manager, requestId);
      const result = await this.payoutRequests.transition(manager, request, PayoutRequestStatus.PROCESSING, {
        processing_at: new Date(),
      });
      const earnings = await manager.find(InstructorEarning, { where: { payout_request_id: requestId } });
      for (const earning of earnings) {
        await this.earningsService.markProcessing(manager, earning.id);
      }
      return result;
    });
    this.eventEmitter.emit(
      MarketplacePayoutProcessingEvent.EVENT_NAME,
      new MarketplacePayoutProcessingEvent(processing.id, processing.instructor_id),
    );
    await this.activityLogs.recordAuditEvent(
      new MarketplacePayoutDecisionEvent(adminId, processing.id, {
        instructorId: processing.instructor_id,
        decision: 'processing',
      }),
    );
    return processing;
  }

  /** FR-219, FR-220: reference is mandatory; writes the `PAYOUT` entry and moves every covered earning to `PAID_OUT`. */
  public async markPaid(adminId: string, requestId: string, payoutReference: string): Promise<MarketplacePayoutRequest> {
    if (!payoutReference?.trim()) {
      throw new BadRequestException(biBody('A payout reference is required to mark a payout as paid', 'مرجع السحب مطلوب لتحديد السحب كمدفوع'));
    }
    const paid = await retryTransaction(this.dataSource, async (manager) => {
      const request = await this.payoutRequests.getOwnedOrThrow(manager, requestId);
      const result = await this.payoutRequests.transition(manager, request, PayoutRequestStatus.PAID, {
        decided_by: adminId,
        payout_reference: payoutReference,
        paid_at: new Date(),
      });

      const earnings = await manager.find(InstructorEarning, { where: { payout_request_id: requestId } });
      for (const earning of earnings) {
        await this.earningsService.markPaidOut(manager, earning.id);
      }

      // CREDIT — LedgerService.deriveBalance()'s paidOutMinor sums PAYOUT
      // credits minus PAYOUT_REVERSAL debits; posting this any other
      // direction would silently zero that figure.
      await this.ledger.post(
        {
          instructorId: request.instructor_id,
          orderId: null,
          entryType: MarketplaceLedgerEntryType.PAYOUT,
          amountMinor: request.amount_minor,
          currency: request.currency,
          direction: MarketplaceLedgerDirection.CREDIT,
          reference: `payout:${request.id}:paid`,
          payoutRequestId: request.id,
          sourceEventId: request.id,
          sourceEventType: 'marketplace.payout.paid',
        },
        manager,
      );

      return result;
    });
    this.eventEmitter.emit(
      MarketplacePayoutPaidEvent.EVENT_NAME,
      new MarketplacePayoutPaidEvent(paid.id, paid.instructor_id, payoutReference),
    );
    await this.activityLogs.recordAuditEvent(
      new MarketplacePayoutDecisionEvent(adminId, paid.id, {
        instructorId: paid.instructor_id,
        decision: 'paid',
        payoutReference,
      }),
    );
    return paid;
  }

  /**
   * FR-221. Handles both shapes of "failed": a `PROCESSING` request whose
   * transfer never actually completed (nothing was ever paid — no ledger
   * entry needed, only the earnings return to available), and a `PAID`
   * request later discovered to have failed (a genuine reversal — writes
   * the compensating `PAYOUT_REVERSAL` entry). Distinguished by the
   * request's own status *before* this transition, never guessed.
   */
  public async markFailed(adminId: string, requestId: string, reason: string): Promise<MarketplacePayoutRequest> {
    if (!reason?.trim()) {
      throw new BadRequestException(biBody('A reason is required to record a payout failure', 'السبب مطلوب لتسجيل فشل السحب'));
    }
    const failedRequest = await retryTransaction(this.dataSource, async (manager) => {
      const request = await this.payoutRequests.getOwnedOrThrow(manager, requestId);
      const wasPaid = request.status === PayoutRequestStatus.PAID;
      const failed = await this.payoutRequests.transition(manager, request, PayoutRequestStatus.FAILED, {
        reason,
        failed_at: new Date(),
      });

      await this.payoutRequests.releaseEarnings(manager, requestId);

      if (wasPaid) {
        await this.ledger.post(
          {
            instructorId: request.instructor_id,
            orderId: null,
            entryType: MarketplaceLedgerEntryType.PAYOUT_REVERSAL,
            amountMinor: request.amount_minor,
            currency: request.currency,
            direction: MarketplaceLedgerDirection.DEBIT,
            reference: `payout:${request.id}:reversal`,
            payoutRequestId: request.id,
            sourceEventId: request.id,
            sourceEventType: 'marketplace.payout.failed',
          },
          manager,
        );
      }

      return failed;
    });
    this.eventEmitter.emit(
      MarketplacePayoutFailedEvent.EVENT_NAME,
      new MarketplacePayoutFailedEvent(failedRequest.id, failedRequest.instructor_id, reason),
    );
    await this.activityLogs.recordAuditEvent(
      new MarketplacePayoutDecisionEvent(adminId, failedRequest.id, {
        instructorId: failedRequest.instructor_id,
        decision: 'failed',
        reason,
      }),
    );
    return failedRequest;
  }
}
