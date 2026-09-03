import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { PaginatedResponse } from '../../common/interfaces/pagination.interface';
import { retryTransaction } from '../../common/utils/transaction-retry.util';
import { biBody } from '../../i18n/error-translator.util';
import { CurrencyRegistryService } from '../common/currency-registry.service';
import { PayoutRequestStatus } from '../common/enums';
import { payoutAccountCurrencyMismatch, payoutBelowMinimum, payoutInsufficientBalance } from '../common/errors';
import { EarningsService } from '../earnings/earnings.service';
import { InstructorEarning } from '../earnings/entities/instructor-earning.entity';
import { InstructorEarningStatus } from '../common/enums';
import { MarketplacePayoutRequestedEvent } from '../events/domain.events';
import { MarketplacePayoutAccount, MarketplacePayoutRequest } from './entities';

const TRANSITIONS: Record<PayoutRequestStatus, PayoutRequestStatus[]> = {
  [PayoutRequestStatus.REQUESTED]: [PayoutRequestStatus.APPROVED, PayoutRequestStatus.REJECTED, PayoutRequestStatus.CANCELLED],
  [PayoutRequestStatus.APPROVED]: [PayoutRequestStatus.PROCESSING, PayoutRequestStatus.REJECTED, PayoutRequestStatus.CANCELLED],
  [PayoutRequestStatus.PROCESSING]: [PayoutRequestStatus.PAID, PayoutRequestStatus.FAILED],
  [PayoutRequestStatus.PAID]: [PayoutRequestStatus.FAILED],
  [PayoutRequestStatus.REJECTED]: [],
  [PayoutRequestStatus.CANCELLED]: [],
  [PayoutRequestStatus.FAILED]: [],
};

export interface CreatePayoutRequestInput {
  payoutAccountId: string;
  amountMinor: number;
  currency: string;
}

/**
 * FR-206 – FR-214 (T167, T168). `createRequest()` and `cancel()` are the
 * two instructor-initiated transitions; `transition()` is the shared,
 * closed-table state machine both this service's `cancel()` and
 * `PayoutAdminService`'s admin-driven transitions (T169/T170) call through
 * — the same "one place ever mutates `status`" shape `EarningsService`
 * already establishes for earnings.
 *
 * **Design decision, not explicitly resolved by the FRs**: earnings are
 * atomic — they can't be split across two payout requests — so a client's
 * requested amount rarely lands on an exact earning boundary. Rather than
 * either rejecting most requests for not matching a combination exactly,
 * or locking more value than the request records (an unreconcilable
 * mismatch between the request's own `amount_minor` and what actually
 * left `AVAILABLE_BALANCE`), `amountMinor` is treated as a *minimum*: this
 * service covers `AVAILABLE_BALANCE` earnings oldest-first until their
 * cumulative sum is at least that minimum, and the request's own
 * `amount_minor` is set to that exact cumulative sum — always the real,
 * fully-reconcilable total of every earning the payout will eventually
 * carry to `PAID_OUT`, never a number that could diverge from it.
 */
@Injectable()
export class PayoutRequestService {
  constructor(
    @InjectRepository(MarketplacePayoutRequest)
    private readonly payoutRequests: Repository<MarketplacePayoutRequest>,
    @InjectRepository(MarketplacePayoutAccount)
    private readonly payoutAccounts: Repository<MarketplacePayoutAccount>,
    private readonly currencyRegistry: CurrencyRegistryService,
    private readonly earningsService: EarningsService,
    private readonly dataSource: DataSource,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  public async createRequest(instructorId: string, input: CreatePayoutRequestInput, idempotencyKey: string): Promise<MarketplacePayoutRequest> {
    const existing = await this.payoutRequests.findOne({ where: { idempotency_key: idempotencyKey } });
    if (existing) {
      return existing;
    }

    const account = await this.payoutAccounts.findOne({ where: { id: input.payoutAccountId, instructor_id: instructorId } });
    if (!account) {
      throw new NotFoundException(biBody('Payout account not found', 'حساب السحب غير موجود'));
    }
    if (account.currency !== input.currency) {
      throw payoutAccountCurrencyMismatch();
    }

    const currency = await this.currencyRegistry.resolve(input.currency);
    if (input.amountMinor < currency.min_payout_minor) {
      throw payoutBelowMinimum(currency.min_payout_minor, input.currency);
    }

    return retryTransaction(this.dataSource, async (manager) => {
      const eligible = await manager
        .getRepository(InstructorEarning)
        .createQueryBuilder('e')
        .setLock('pessimistic_write')
        .where('e.instructor_id = :instructorId', { instructorId })
        .andWhere('e.currency = :currency', { currency: input.currency })
        .andWhere('e.status = :status', { status: InstructorEarningStatus.AVAILABLE_BALANCE })
        .orderBy('e.available_at', 'ASC')
        .addOrderBy('e.id', 'ASC')
        .getMany();

      const covered: InstructorEarning[] = [];
      let coveredMinor = 0;
      for (const earning of eligible) {
        if (coveredMinor >= input.amountMinor) break;
        covered.push(earning);
        coveredMinor += earning.net_amount_minor;
      }
      if (coveredMinor < input.amountMinor) {
        throw payoutInsufficientBalance();
      }

      const requestNumber = `PR-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      let request = manager.create(MarketplacePayoutRequest, {
        request_number: requestNumber,
        instructor_id: instructorId,
        payout_account_id: input.payoutAccountId,
        amount_minor: coveredMinor,
        currency: input.currency,
        status: PayoutRequestStatus.REQUESTED,
        idempotency_key: idempotencyKey,
      });
      try {
        request = await manager.save(MarketplacePayoutRequest, request);
      } catch (error) {
        const dbError = error as { code?: string };
        if (dbError.code === '23505') {
          const raced = await manager.findOne(MarketplacePayoutRequest, { where: { idempotency_key: idempotencyKey } });
          if (raced) return raced;
        }
        throw error;
      }

      for (const earning of covered) {
        await this.earningsService.lockForPayout(manager, earning.id, request.id);
      }

      this.eventEmitter.emit(
        MarketplacePayoutRequestedEvent.EVENT_NAME,
        new MarketplacePayoutRequestedEvent(request.id, instructorId),
      );

      return request;
    });
  }

  /** FR-214: an instructor may cancel their own request only while it is still `REQUESTED`. */
  public async cancel(instructorId: string, requestId: string): Promise<MarketplacePayoutRequest> {
    return retryTransaction(this.dataSource, async (manager) => {
      const request = await manager.findOne(MarketplacePayoutRequest, {
        where: { id: requestId, instructor_id: instructorId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!request) {
        throw new NotFoundException(biBody('Payout request not found', 'طلب السحب غير موجود'));
      }
      const cancelled = await this.transition(manager, request, PayoutRequestStatus.CANCELLED);
      await this.releaseEarnings(manager, requestId);
      return cancelled;
    });
  }

  public async transition(
    manager: EntityManager,
    request: MarketplacePayoutRequest,
    to: PayoutRequestStatus,
    extra: Partial<Pick<MarketplacePayoutRequest, 'decided_by' | 'reason' | 'payout_reference' | 'approved_at' | 'processing_at' | 'paid_at' | 'failed_at'>> = {},
  ): Promise<MarketplacePayoutRequest> {
    if (!TRANSITIONS[request.status].includes(to)) {
      throw new ConflictException(
        biBody(`A payout request cannot move from ${request.status} to ${to}`, `لا يمكن أن ينتقل طلب السحب من ${request.status} إلى ${to}`),
      );
    }
    Object.assign(request, extra, { status: to });
    return manager.save(MarketplacePayoutRequest, request);
  }

  /** Admin queue (T174) — every instructor's requests, optionally narrowed by status. */
  public async listQueue(status?: PayoutRequestStatus, page = 1, limit = 20): Promise<PaginatedResponse<MarketplacePayoutRequest>> {
    const where = status ? { status } : {};
    const [data, total] = await this.payoutRequests.findAndCount({
      where,
      order: { requested_at: 'ASC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return this.paginate(data, total, page, limit);
  }

  /** Admin single lookup (T174) — unscoped by instructor. */
  public async getById(id: string): Promise<MarketplacePayoutRequest> {
    const request = await this.payoutRequests.findOne({ where: { id } });
    if (!request) {
      throw new NotFoundException(biBody('Payout request not found', 'طلب السحب غير موجود'));
    }
    return request;
  }

  /** T173: the caller's own payout-request history, most recent first. */
  public async listOwn(instructorId: string, page = 1, limit = 20): Promise<PaginatedResponse<MarketplacePayoutRequest>> {
    const [data, total] = await this.payoutRequests.findAndCount({
      where: { instructor_id: instructorId },
      order: { requested_at: 'DESC' },
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

  /** IDOR-safe single lookup for an instructor reading their own request — unlike `getOwnedOrThrow`, scoped by `instructor_id` and takes no row lock. */
  public async getOwn(instructorId: string, requestId: string): Promise<MarketplacePayoutRequest> {
    const request = await this.payoutRequests.findOne({ where: { id: requestId, instructor_id: instructorId } });
    if (!request) {
      throw new NotFoundException(biBody('Payout request not found', 'طلب السحب غير موجود'));
    }
    return request;
  }

  public async getOwnedOrThrow(manager: EntityManager, requestId: string): Promise<MarketplacePayoutRequest> {
    const request = await manager.findOne(MarketplacePayoutRequest, {
      where: { id: requestId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!request) {
      throw new NotFoundException(biBody('Payout request not found', 'طلب السحب غير موجود'));
    }
    return request;
  }

  /** Returns every earning locked under this request to `AVAILABLE_BALANCE` — used on rejection, cancellation and failure. */
  public async releaseEarnings(manager: EntityManager, requestId: string): Promise<void> {
    const earnings = await manager.find(InstructorEarning, { where: { payout_request_id: requestId } });
    for (const earning of earnings) {
      await this.earningsService.releaseToAvailable(manager, earning.id);
    }
  }
}
