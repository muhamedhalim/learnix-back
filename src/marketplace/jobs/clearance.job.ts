import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, LessThanOrEqual, Repository } from 'typeorm';

import { Queue } from 'bullmq';

import { retryTransaction } from '../../common/utils/transaction-retry.util';
import { JOB_TYPES, QUEUE_NAMES } from '../../queues/queues.constants';
import { InstructorEarningStatus, RefundRequestStatus } from '../common/enums';
import { EarningsService } from '../earnings/earnings.service';
import { InstructorEarning } from '../earnings/entities/instructor-earning.entity';
import { MarketplaceEarningClearedEvent } from '../events/domain.events';
import { MarketplaceRefundRequest } from '../refunds/entities';

/** `UQ_mp_refunds_open_per_order`'s own definition of "open" — kept identical so the sweep and the DB constraint never disagree. */
const OPEN_REFUND_STATUSES = [RefundRequestStatus.REQUESTED, RefundRequestStatus.APPROVED, RefundRequestStatus.PROCESSING];

const SWEEP_BATCH_SIZE = 500;

/**
 * FR-147, FR-148, FR-153 (T163). `available_at` on a `REFUND_CLEARANCE`
 * earning already equals `order.paid_at + refund_window_days`
 * (`SettlementService.grantAccess()`), so eligibility needs no re-derivation
 * from the order — just `status = REFUND_CLEARANCE AND available_at <= now`.
 *
 * Idempotent and recoverable by construction, not by a separate dedup
 * mechanism: `EarningsService.transition()` only accepts an earning
 * currently `REFUND_CLEARANCE`, and this query only selects rows in that
 * exact status, so an earning already cleared on an earlier run is simply
 * absent from a later run's result set — running twice clears nothing
 * twice. A missed run leaves eligible rows sitting in `REFUND_CLEARANCE`
 * with `available_at` in the past, so the very next run picks them up
 * exactly as it would have — no watermark/cursor to lose or reconcile.
 */
@Injectable()
export class ClearanceSweepService {
  private readonly logger = new Logger(ClearanceSweepService.name);

  constructor(
    @InjectRepository(InstructorEarning)
    private readonly earnings: Repository<InstructorEarning>,
    @InjectRepository(MarketplaceRefundRequest)
    private readonly refundRequests: Repository<MarketplaceRefundRequest>,
    private readonly earningsService: EarningsService,
    private readonly dataSource: DataSource,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  public async runSweep(): Promise<{ cleared: number; skipped: number }> {
    const now = new Date();
    const due = await this.earnings.find({
      where: { status: InstructorEarningStatus.REFUND_CLEARANCE, available_at: LessThanOrEqual(now) },
      order: { available_at: 'ASC' },
      take: SWEEP_BATCH_SIZE,
    });

    let cleared = 0;
    let skipped = 0;
    for (const earning of due) {
      const hasOpenRefund = await this.refundRequests.exist({
        where: { order_id: earning.order_id, status: In(OPEN_REFUND_STATUSES) },
      });
      if (hasOpenRefund) {
        skipped += 1;
        continue;
      }
      await retryTransaction(this.dataSource, async (manager) => {
        await this.earningsService.moveToAvailableBalance(manager, earning.id);
      });
      this.eventEmitter.emit(
        MarketplaceEarningClearedEvent.EVENT_NAME,
        new MarketplaceEarningClearedEvent(earning.id, earning.order_id, earning.instructor_id),
      );
      cleared += 1;
    }

    this.logger.log(`Clearance sweep: ${String(cleared)} cleared, ${String(skipped)} skipped (open refund), ${String(due.length)} scanned`);
    return { cleared, skipped };
  }
}

/** Daily cadence (ms). Runs via the shared `QUEUE_NAMES.MARKETPLACE` worker — `MarketplaceRemovalProcessor` dispatches `CLEARANCE_SWEEP` to `ClearanceSweepService.runSweep()`. */
const CLEARANCE_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Registers the repeatable sweep on boot. BullMQ derives a repeatable job's
 * key from its name + repeat options, so re-registering on every start is
 * idempotent — no duplicate schedules — and self-healing after a Redis
 * restart, the same pattern `GameJobsService` already establishes.
 */
@Injectable()
export class ClearanceSweepScheduler implements OnModuleInit {
  private readonly logger = new Logger(ClearanceSweepScheduler.name);

  constructor(@InjectQueue(QUEUE_NAMES.MARKETPLACE) private readonly queue: Queue) {}

  public async onModuleInit(): Promise<void> {
    await this.queue.add(
      JOB_TYPES.MARKETPLACE.CLEARANCE_SWEEP,
      {},
      { repeat: { every: CLEARANCE_SWEEP_INTERVAL_MS }, jobId: 'marketplace-clearance-sweep' },
    );
    this.logger.log(`Registered repeatable clearance sweep (every ${String(CLEARANCE_SWEEP_INTERVAL_MS)}ms)`);
  }
}
