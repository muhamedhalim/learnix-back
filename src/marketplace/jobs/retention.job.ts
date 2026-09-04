import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Repository } from 'typeorm';

import { Queue } from 'bullmq';

import { getMarketplaceConfig } from '../../config/marketplace.config';
import { JOB_TYPES, QUEUE_NAMES } from '../../queues/queues.constants';
import { MarketplaceStorageService } from '../common/marketplace-storage.service';
import { InstructorApplication } from '../instructors/entities/instructor-application.entity';

const SWEEP_BATCH_SIZE = 500;

/**
 * T222 (FR-315, FR-316). Retention here is deliberately narrow: it purges
 * **personal content** from decided instructor applications past their
 * 24-month window (FR-315) — it never deletes a financial, ledger,
 * certificate or payout row, ever, at any age. FR-316's "at least 10 years"
 * for those is a floor with no automatic deletion path at all, so there is
 * no code here (and none should ever be added here) that removes an
 * `InstructorEarning`, `MarketplaceLedgerEntry`, `MarketplaceOrder`,
 * `MarketplaceRefundRequest`, `MarketplacePayoutRequest` or `Certificate`
 * row — `TRG_mp_ledger_immutable` already makes that structurally
 * impossible for the ledger specifically (FR-162), and this job simply
 * never touches any of those tables at all.
 *
 * The decision record itself (`status`, `decision_reason`, `reviewed_by`,
 * `reviewed_at`) is preserved — only the applicant's personal content
 * (name, headline, bio, education/certification/work history,
 * specializations, skills, portfolio, professional links, photo, uploaded
 * documents) is cleared, matching FR-315's "decision record preserved
 * after personal content is removed". An approved application's personal
 * fields were already copied into the live `MarketplaceInstructor` profile
 * row at approval time (`InstructorService`), so purging the application's
 * own copies never affects that live, still-public profile.
 */
@Injectable()
export class RetentionSweepService {
  private readonly logger = new Logger(RetentionSweepService.name);

  constructor(
    @InjectRepository(InstructorApplication)
    private readonly applications: Repository<InstructorApplication>,
    private readonly storage: MarketplaceStorageService,
  ) {}

  public async runSweep(): Promise<{ purged: number; scanned: number }> {
    const config = getMarketplaceConfig();
    const cutoff = new Date();
    cutoff.setUTCMonth(cutoff.getUTCMonth() - config.applicationRetentionMonths);

    const due = await this.applications.find({
      where: { reviewed_at: LessThan(cutoff), personal_data_purged_at: IsNull() },
      order: { reviewed_at: 'ASC' },
      take: SWEEP_BATCH_SIZE,
    });
    // `reviewed_at: LessThan(cutoff)` alone would also match a never-reviewed
    // row (`reviewed_at IS NULL` sorts before any date in Postgres under some
    // comparators) — this repository call is additionally guarded by TypeORM
    // translating `LessThan` against a nullable column as `column < :cutoff`,
    // which SQL evaluates to `NULL` (never true) for a NULL column, so a
    // draft/submitted/under_review application is never selected. Asserted
    // directly in the unit spec rather than trusted implicitly.

    let purged = 0;
    for (const application of due) {
      const documentKeys = application.document_keys;
      const photoKey = application.photo_key;

      await this.applications.update(
        { id: application.id },
        {
          display_name: '[redacted]',
          headline: null,
          headline_ar: null,
          bio: null,
          bio_ar: null,
          education: [],
          certifications: [],
          work_experience: [],
          specializations: [],
          skills: [],
          portfolio_items: [],
          professional_links: [],
          photo_key: null,
          document_keys: [],
          internal_notes: null,
          personal_data_purged_at: new Date(),
        },
      );

      for (const key of documentKeys) {
        await this.deleteQuietly(key);
      }
      if (photoKey) {
        await this.deleteQuietly(photoKey);
      }
      purged += 1;
    }

    this.logger.log(`Retention sweep: ${String(purged)} application(s) purged of personal content, ${String(due.length)} scanned`);
    return { purged, scanned: due.length };
  }

  /** A storage object already gone (or a transient provider error) must never abandon the DB-side purge already committed for the other fields. */
  private async deleteQuietly(key: string): Promise<void> {
    try {
      await this.storage.delete(key);
    } catch (error) {
      this.logger.warn(`Retention sweep: failed to delete storage object ${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** Daily cadence (ms), matching `ClearanceSweepScheduler`'s own. */
const RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Registers the repeatable sweep on boot — same idempotent-by-BullMQ-key pattern `ClearanceSweepScheduler` already establishes. */
@Injectable()
export class RetentionSweepScheduler implements OnModuleInit {
  private readonly logger = new Logger(RetentionSweepScheduler.name);

  constructor(@InjectQueue(QUEUE_NAMES.MARKETPLACE) private readonly queue: Queue) {}

  public async onModuleInit(): Promise<void> {
    await this.queue.add(
      JOB_TYPES.MARKETPLACE.RETENTION_SWEEP,
      {},
      { repeat: { every: RETENTION_SWEEP_INTERVAL_MS }, jobId: 'marketplace-retention-sweep' },
    );
    this.logger.log(`Registered repeatable retention sweep (every ${String(RETENTION_SWEEP_INTERVAL_MS)}ms)`);
  }
}
