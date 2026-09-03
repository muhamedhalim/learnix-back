import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, FindOptionsWhere, Repository } from 'typeorm';

import { PaginatedResponse } from '../../common/interfaces/pagination.interface';
import { biBody } from '../../i18n/error-translator.util';
import { MarketplaceMoneyService } from '../common/money.service';
import {
  InstructorEarningStatus,
  MarketplaceLedgerDirection,
  MarketplaceLedgerEntryType,
} from '../common/enums';
import { MarketplaceLedgerEntry } from './entities/marketplace-ledger-entry.entity';
import { InstructorEarning } from './entities/instructor-earning.entity';

export interface PostLedgerEntryInput {
  instructorId: string;
  orderId: string | null;
  entryType: MarketplaceLedgerEntryType;
  amountMinor: number;
  currency: string;
  direction: MarketplaceLedgerDirection;
  reference: string;
  sourceEventId?: string | null;
  sourceEventType?: string | null;
  payoutRequestId?: string | null;
  createdBy?: string | null;
  metadata?: Record<string, unknown>;
}

export interface CreateEarningInput {
  instructorId: string;
  orderId: string;
  grossAmountMinor: number;
  commissionAmountMinor: number;
  netAmountMinor: number;
  currency: string;
  commissionBps: number;
  availableAt: Date;
}

export interface MarketplaceBalance {
  currency: string;
  pendingMinor: number;
  clearingMinor: number;
  availableMinor: number;
  requestedMinor: number;
  paidOutMinor: number;
  reversedMinor: number;
}

const POSTGRES_UNIQUE_VIOLATION = '23505';

/**
 * The ledger's append-only core (FR-157 – FR-171). `post()` is the only
 * write path — the immutability trigger (`TRG_mp_ledger_immutable`) is the
 * database-level backstop for everything else. Balance derivation follows
 * spec.md's Balance derivation table exactly.
 */
@Injectable()
export class LedgerService {
  constructor(
    @InjectRepository(MarketplaceLedgerEntry)
    private readonly entries: Repository<MarketplaceLedgerEntry>,
    @InjectRepository(InstructorEarning)
    private readonly earnings: Repository<InstructorEarning>,
    private readonly money: MarketplaceMoneyService,
  ) {}

  /**
   * Deterministic reference from `(event type, order id, sequence)` (FR-171).
   * The same source event always produces the same reference, so a replayed
   * webhook or re-run job collides on `UQ_mp_ledger_reference` instead of
   * duplicating.
   */
  public buildReference(eventType: string, orderId: string, sequence: number): string {
    return `${eventType}:${orderId}:${sequence}`;
  }

  /**
   * Appends one entry. A replay of the same `reference` is a no-op — the
   * unique-index conflict is caught and the existing row returned, never a
   * duplicate write and never a thrown error the caller must special-case.
   *
   * Accepts an optional transactional `manager` so a caller settling an
   * order (enrollment + earning + ledger, all-or-nothing — FR-099) can post
   * through the SAME transaction rather than this service's own
   * independently-connected repository, which would silently break
   * atomicity: without this, a ledger row could commit on its own
   * connection moments before the enclosing transaction rolled back.
   */
  public async post(input: PostLedgerEntryInput, manager?: EntityManager): Promise<MarketplaceLedgerEntry> {
    // Application-level mirror of `CHK_mp_ledger_amount_positive` (T112,
    // FR-169) — a ledger entry only ever records a real money movement, so
    // a zero-value (free) order's would-be commission/earning split, which
    // is always exactly 0, can never reach a write here at all.
    if (input.amountMinor <= 0) {
      throw new BadRequestException(
        biBody('A ledger entry must record a positive amount', 'يجب أن يسجل قيد دفتر الأستاذ مبلغًا موجبًا'),
      );
    }
    const repo = manager ? manager.getRepository(MarketplaceLedgerEntry) : this.entries;
    try {
      const entry = repo.create({
        instructor_id: input.instructorId,
        order_id: input.orderId,
        entry_type: input.entryType,
        amount_minor: input.amountMinor,
        currency: input.currency,
        direction: input.direction,
        reference: input.reference,
        source_event_id: input.sourceEventId ?? null,
        source_event_type: input.sourceEventType ?? null,
        payout_request_id: input.payoutRequestId ?? null,
        created_by: input.createdBy ?? null,
        metadata: input.metadata ?? {},
      });
      return await repo.save(entry);
    } catch (error) {
      const dbError = error as { code?: string };
      if (dbError.code === POSTGRES_UNIQUE_VIOLATION) {
        const existing = await repo.findOne({ where: { reference: input.reference } });
        if (existing) return existing;
      }
      throw error;
    }
  }

  /**
   * The one write path for `marketplace_instructor_earnings` (T112, FR-114)
   * — mirrors `post()`'s positive-amount guard (and `CHK_mp_earnings_amount_positive`'s
   * database backstop) so a zero-value order's would-be earning, whose
   * gross/commission/net are all exactly 0 by construction, can never be
   * persisted through here either. Always takes the caller's transactional
   * `manager`, never its own connection — same atomicity reasoning as
   * `post()`.
   */
  public async createEarning(input: CreateEarningInput, manager: EntityManager): Promise<InstructorEarning> {
    if (input.grossAmountMinor <= 0) {
      throw new BadRequestException(
        biBody('An earning must record a positive gross amount', 'يجب أن يسجل الدخل مبلغًا إجماليًا موجبًا'),
      );
    }
    const repo = manager.getRepository(InstructorEarning);
    const earning = repo.create({
      instructor_id: input.instructorId,
      order_id: input.orderId,
      gross_amount_minor: input.grossAmountMinor,
      commission_amount_minor: input.commissionAmountMinor,
      net_amount_minor: input.netAmountMinor,
      currency: input.currency,
      commission_bps: input.commissionBps,
      status: InstructorEarningStatus.PENDING_EARNINGS,
      available_at: input.availableAt,
    });
    return repo.save(earning);
  }

  /**
   * Derives every balance figure for one (instructor, currency) pair from
   * the earnings table and the ledger — never from a cached field
   * (spec.md §Balance derivation).
   */
  public async deriveBalance(instructorId: string, currency: string): Promise<MarketplaceBalance> {
    const [pending, clearing, requested, available] = await Promise.all([
      this.sumEarnings(instructorId, currency, [InstructorEarningStatus.PENDING_EARNINGS]),
      this.sumEarnings(instructorId, currency, [InstructorEarningStatus.REFUND_CLEARANCE]),
      this.sumEarnings(instructorId, currency, [
        InstructorEarningStatus.PAYOUT_REQUESTED,
        InstructorEarningStatus.PROCESSING,
      ]),
      this.sumEarnings(instructorId, currency, [InstructorEarningStatus.AVAILABLE_BALANCE]),
    ]);
    const manualAdjustmentNet = await this.sumLedgerNet(instructorId, currency, [
      MarketplaceLedgerEntryType.MANUAL_ADJUSTMENT,
    ]);
    const paidOut = await this.sumLedgerSigned(instructorId, currency, {
      credit: [MarketplaceLedgerEntryType.PAYOUT],
      debit: [MarketplaceLedgerEntryType.PAYOUT_REVERSAL],
    });
    const reversed = await this.sumLedgerSigned(instructorId, currency, {
      credit: [MarketplaceLedgerEntryType.REFUND],
      debit: [],
    });

    return {
      currency,
      pendingMinor: pending,
      clearingMinor: clearing,
      availableMinor: this.money.add(
        { amountMinor: available, currency },
        { amountMinor: manualAdjustmentNet, currency },
      ),
      requestedMinor: requested,
      paidOutMinor: paidOut,
      reversedMinor: reversed,
    };
  }

  /** Contracts §3 — the instructor's own earnings, newest first, optionally narrowed by status/currency (T172). */
  public async listEarnings(
    instructorId: string,
    options: { status?: InstructorEarningStatus; currency?: string; page?: number; limit?: number } = {},
  ): Promise<PaginatedResponse<InstructorEarning>> {
    const page = options.page ?? 1;
    const limit = options.limit ?? 20;
    const where: FindOptionsWhere<InstructorEarning> = { instructor_id: instructorId };
    if (options.status) where.status = options.status;
    if (options.currency) where.currency = options.currency;
    const [data, total] = await this.earnings.findAndCount({
      where,
      order: { created_at: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return this.paginate(data, total, page, limit);
  }

  /** Contracts §3 — the instructor's own append-only ledger, newest first (FR-291: viewable/filterable, never editable). */
  public async listEntries(
    instructorId: string,
    options: { entryType?: MarketplaceLedgerEntryType; currency?: string; page?: number; limit?: number } = {},
  ): Promise<PaginatedResponse<MarketplaceLedgerEntry>> {
    const page = options.page ?? 1;
    const limit = options.limit ?? 20;
    const where: FindOptionsWhere<MarketplaceLedgerEntry> = { instructor_id: instructorId };
    if (options.entryType) where.entry_type = options.entryType;
    if (options.currency) where.currency = options.currency;
    const [data, total] = await this.entries.findAndCount({
      where,
      order: { created_at: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return this.paginate(data, total, page, limit);
  }

  private paginate<T>(data: T[], total: number, page: number, limit: number): PaginatedResponse<T> {
    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        hasNextPage: page * limit < total,
        hasPrevPage: page > 1,
      },
    };
  }

  private async sumEarnings(
    instructorId: string,
    currency: string,
    statuses: InstructorEarningStatus[],
  ): Promise<number> {
    const { total } = (await this.earnings
      .createQueryBuilder('e')
      .select('COALESCE(SUM(e.net_amount_minor), 0)', 'total')
      .where('e.instructor_id = :instructorId', { instructorId })
      .andWhere('e.currency = :currency', { currency })
      .andWhere('e.status IN (:...statuses)', { statuses })
      .getRawOne<{ total: string }>()) ?? { total: '0' };
    return Number.parseInt(total, 10);
  }

  /** Net credits minus debits for the given entry types. */
  private async sumLedgerNet(
    instructorId: string,
    currency: string,
    types: MarketplaceLedgerEntryType[],
  ): Promise<number> {
    if (types.length === 0) return 0;
    const rows = await this.entries
      .createQueryBuilder('l')
      .select('l.direction', 'direction')
      .addSelect('COALESCE(SUM(l.amount_minor), 0)', 'total')
      .where('l.instructor_id = :instructorId', { instructorId })
      .andWhere('l.currency = :currency', { currency })
      .andWhere('l.entry_type IN (:...types)', { types })
      .groupBy('l.direction')
      .getRawMany<{ direction: MarketplaceLedgerDirection; total: string }>();
    const credit = Number.parseInt(rows.find((r) => r.direction === MarketplaceLedgerDirection.CREDIT)?.total ?? '0', 10);
    const debit = Number.parseInt(rows.find((r) => r.direction === MarketplaceLedgerDirection.DEBIT)?.total ?? '0', 10);
    return this.money.subtract({ amountMinor: credit, currency }, { amountMinor: debit, currency });
  }

  /** Sums one set of entry types as a positive contribution and another as a negative one. */
  private async sumLedgerSigned(
    instructorId: string,
    currency: string,
    types: { credit: MarketplaceLedgerEntryType[]; debit: MarketplaceLedgerEntryType[] },
  ): Promise<number> {
    const positive = await this.sumLedgerAbsolute(instructorId, currency, types.credit);
    const negative = await this.sumLedgerAbsolute(instructorId, currency, types.debit);
    return this.money.subtract({ amountMinor: positive, currency }, { amountMinor: negative, currency });
  }

  private async sumLedgerAbsolute(
    instructorId: string,
    currency: string,
    types: MarketplaceLedgerEntryType[],
  ): Promise<number> {
    if (types.length === 0) return 0;
    const { total } = (await this.entries
      .createQueryBuilder('l')
      .select('COALESCE(SUM(l.amount_minor), 0)', 'total')
      .where('l.instructor_id = :instructorId', { instructorId })
      .andWhere('l.currency = :currency', { currency })
      .andWhere('l.entry_type IN (:...types)', { types })
      .getRawOne<{ total: string }>()) ?? { total: '0' };
    return Number.parseInt(total, 10);
  }
}
