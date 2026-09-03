import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { ActivityLogsService } from '../../activity-logs/activity-logs.service';
import { biBody } from '../../i18n/error-translator.util';
import { retryTransaction } from '../../common/utils/transaction-retry.util';
import { MarketplaceLedgerDirection, MarketplaceLedgerEntryType } from '../common/enums';
import { adjustmentCurrencyNotHeld, adjustmentWouldGoNegative } from '../common/errors';
import { MarketplaceLedgerAdjustmentEvent } from '../events/audit.events';
import { BalanceService } from './balance.service';
import { InstructorEarning } from './entities/instructor-earning.entity';
import { MarketplaceLedgerEntry } from './entities/marketplace-ledger-entry.entity';
import { LedgerService } from './ledger.service';

export interface CreateAdjustmentInput {
  instructorId: string;
  currency: string;
  amountMinor: number;
  direction: MarketplaceLedgerDirection;
  reason: string;
  adminId: string;
  idempotencyKey: string;
}

/**
 * FR-168, FR-173, FR-288 (T171). A `MANUAL_ADJUSTMENT` entry is the only
 * sanctioned way to correct a balance — `LedgerService.post()` already
 * enforces the DB-level `created_by IS NOT NULL AND metadata ? 'reason'`
 * constraint for this entry type; this service is what supplies both,
 * plus the two guards FR-173 requires beyond what the ledger alone can
 * check: a currency the instructor holds no earnings in at all, and a
 * debit that would drive `availableMinor` negative. Authorization
 * (`marketplace.ledger.adjust`) is enforced at the controller, not here.
 */
@Injectable()
export class AdjustmentService {
  constructor(
    private readonly ledger: LedgerService,
    private readonly balance: BalanceService,
    @InjectRepository(InstructorEarning) private readonly earnings: Repository<InstructorEarning>,
    private readonly dataSource: DataSource,
    private readonly activityLogs: ActivityLogsService,
  ) {}

  public async createAdjustment(input: CreateAdjustmentInput): Promise<MarketplaceLedgerEntry> {
    if (!input.reason?.trim()) {
      throw new BadRequestException(biBody('A reason is required for a manual adjustment', 'السبب مطلوب للتعديل اليدوي'));
    }

    const holdsCurrency = await this.earnings.exist({ where: { instructor_id: input.instructorId, currency: input.currency } });
    if (!holdsCurrency) {
      throw adjustmentCurrencyNotHeld();
    }

    if (input.direction === MarketplaceLedgerDirection.DEBIT) {
      const current = await this.balance.getBalance(input.instructorId, input.currency);
      if (current.availableMinor - input.amountMinor < 0) {
        throw adjustmentWouldGoNegative();
      }
    }

    const entry = await retryTransaction(this.dataSource, (manager) =>
      this.ledger.post(
        {
          instructorId: input.instructorId,
          orderId: null,
          entryType: MarketplaceLedgerEntryType.MANUAL_ADJUSTMENT,
          amountMinor: input.amountMinor,
          currency: input.currency,
          direction: input.direction,
          reference: `manual_adjustment:${input.instructorId}:${input.currency}:${input.idempotencyKey}`,
          createdBy: input.adminId,
          metadata: { reason: input.reason },
        },
        manager,
      ),
    );

    await this.activityLogs.recordAuditEvent(
      new MarketplaceLedgerAdjustmentEvent(input.adminId, entry.id, {
        instructorId: input.instructorId,
        amountMinor: input.amountMinor,
        currency: input.currency,
        reason: input.reason,
      }),
    );

    return entry;
  }
}
