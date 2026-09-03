import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';

import { ActivityLogsService } from '../../activity-logs/activity-logs.service';
import { PaginationMeta } from '../../common/interfaces/pagination.interface';
import { biBody } from '../../i18n/error-translator.util';
import { IdempotencyService } from '../../idempotency/idempotency.service';
import { MarketplaceEnrollment, MarketplaceOrder } from '../commerce/entities';
import { RefundRequestStatus } from '../common/enums';
import { refundAlreadyOpen } from '../common/errors';
import {
  MarketplaceRefundRefusedEvent,
  MarketplaceRefundRequestedEvent,
} from '../events/domain.events';
import { MarketplaceRefundDecisionEvent } from '../events/audit.events';
import { RefundEligibilityService } from './eligibility.service';
import { MarketplaceRefundRequest } from './entities';
import { RefundProcessingService } from './refund-processing.service';

const POSTGRES_UNIQUE_VIOLATION = '23505';

export interface RefundRequestQueue {
  data: MarketplaceRefundRequest[];
  meta: PaginationMeta;
}

/**
 * FR-176 – FR-199. Owns the six-state machine's REQUESTED/REJECTED/APPROVED
 * transitions — the money-moving PROCESSING/COMPLETED/FAILED half belongs
 * to `RefundProcessingService`, which this service calls into once a
 * request is (auto- or discretionarily) approved, never the other way
 * round.
 */
@Injectable()
export class RefundRequestService {
  constructor(
    @InjectRepository(MarketplaceRefundRequest)
    private readonly refundRequests: Repository<MarketplaceRefundRequest>,
    @InjectRepository(MarketplaceOrder)
    private readonly orders: Repository<MarketplaceOrder>,
    @InjectRepository(MarketplaceEnrollment)
    private readonly enrollments: Repository<MarketplaceEnrollment>,
    private readonly eligibility: RefundEligibilityService,
    private readonly processing: RefundProcessingService,
    private readonly eventEmitter: EventEmitter2,
    private readonly activityLogs: ActivityLogsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * Ownership-scoped so a foreign order id is indistinguishable from a
   * nonexistent one (IDOR). `idempotencyKey` covers the whole call,
   * including the immediate auto-processing of an eligible request — a
   * retried POST with the same key (contracts §4) replays the cached
   * terminal result instead of creating a second request row.
   */
  public async requestRefund(
    learnerId: string,
    orderId: string,
    reason: string,
    idempotencyKey: string,
  ): Promise<MarketplaceRefundRequest> {
    const cached = await this.idempotency.checkPaymentRequest(learnerId, idempotencyKey);
    if (cached.isProcessed && cached.cachedResult) {
      return cached.cachedResult as MarketplaceRefundRequest;
    }

    const result = await this.doRequestRefund(learnerId, orderId, reason);
    await this.idempotency.storePaymentResult(learnerId, idempotencyKey, result);
    return result;
  }

  private async doRequestRefund(
    learnerId: string,
    orderId: string,
    reason: string,
  ): Promise<MarketplaceRefundRequest> {
    const order = await this.orders.findOne({ where: { id: orderId, learner_id: learnerId } });
    if (!order) {
      throw new NotFoundException(biBody('Order not found', 'الطلب غير موجود'));
    }
    const enrollment = await this.enrollments.findOne({ where: { order_id: orderId } });
    if (!enrollment) {
      throw new NotFoundException(
        biBody('Enrollment not found for this order', 'لا يوجد تسجيل مرتبط بهذا الطلب'),
      );
    }

    const verdict = this.eligibility.evaluateForOrder(order, enrollment);

    let request = this.refundRequests.create({
      order_id: order.id,
      enrollment_id: enrollment.id,
      learner_id: learnerId,
      reason,
      elapsed_days_at_request: verdict.elapsedDays,
      progress_bps_at_request: verdict.progressBps,
      eligibility_verdict: verdict as unknown as Record<string, unknown>,
      status: RefundRequestStatus.REQUESTED,
    });
    try {
      request = await this.refundRequests.save(request);
    } catch (error) {
      const dbError = error as { code?: string };
      if (dbError.code === POSTGRES_UNIQUE_VIOLATION) {
        throw refundAlreadyOpen();
      }
      throw error;
    }

    this.eventEmitter.emit(
      MarketplaceRefundRequestedEvent.EVENT_NAME,
      new MarketplaceRefundRequestedEvent(request.id, order.id, learnerId),
    );

    if (!verdict.eligible) {
      request.status = RefundRequestStatus.REJECTED;
      request.decided_at = new Date();
      const rejected = await this.refundRequests.save(request);
      this.eventEmitter.emit(
        MarketplaceRefundRefusedEvent.EVENT_NAME,
        new MarketplaceRefundRefusedEvent(rejected.id, order.id, verdict.failedCondition as string),
      );
      return rejected;
    }

    request.status = RefundRequestStatus.APPROVED;
    request.decided_at = new Date();
    const approved = await this.refundRequests.save(request);
    return this.processing.process(approved.id);
  }

  /**
   * FR-186, FR-289 — an admin grants a refund outside the normal
   * window/cap. Only ever moves a REJECTED request forward (an
   * already-eligible one is auto-approved by `requestRefund` itself, and a
   * PROCESSING/COMPLETED one has nothing left to grant).
   */
  public async discretionaryApprove(
    adminId: string,
    refundRequestId: string,
    reason: string,
  ): Promise<MarketplaceRefundRequest> {
    if (!reason?.trim()) {
      throw new BadRequestException(
        biBody('A reason is required for a discretionary refund', 'السبب مطلوب لاسترداد استثنائي'),
      );
    }
    const request = await this.refundRequests.findOne({ where: { id: refundRequestId } });
    if (!request) {
      throw new NotFoundException(biBody('Refund request not found', 'طلب الاسترداد غير موجود'));
    }
    if (request.status !== RefundRequestStatus.REJECTED) {
      if (
        request.status === RefundRequestStatus.APPROVED ||
        request.status === RefundRequestStatus.PROCESSING ||
        request.status === RefundRequestStatus.COMPLETED
      ) {
        return request;
      }
      throw new ConflictException(
        biBody(
          'Only a rejected refund request can be discretionarily approved',
          'يمكن فقط الموافقة الاستثنائية على طلب مرفوض',
        ),
      );
    }

    request.is_discretionary = true;
    request.decided_by = adminId;
    request.decided_at = new Date();
    request.status = RefundRequestStatus.APPROVED;
    request.eligibility_verdict = { ...request.eligibility_verdict, discretionary_reason: reason };
    const approved = await this.refundRequests.save(request);

    await this.activityLogs.recordAuditEvent(
      new MarketplaceRefundDecisionEvent(adminId, approved.id, {
        orderId: approved.order_id,
        decision: 'approved',
        discretionary: true,
        reason,
      }),
    );

    return this.processing.process(approved.id);
  }

  /**
   * FR-054a — used only by course removal (T142): bypasses eligibility
   * entirely and is approved immediately, since a removal-driven refund is
   * unconditional by definition.
   */
  public async createRemovalDrivenRefund(
    orderId: string,
    enrollmentId: string,
    learnerId: string,
    reason: string,
  ): Promise<MarketplaceRefundRequest> {
    let request = this.refundRequests.create({
      order_id: orderId,
      enrollment_id: enrollmentId,
      learner_id: learnerId,
      reason,
      is_removal_driven: true,
      elapsed_days_at_request: 0,
      progress_bps_at_request: 0,
      eligibility_verdict: { removal_driven: true },
      status: RefundRequestStatus.APPROVED,
      decided_at: new Date(),
    });
    try {
      request = await this.refundRequests.save(request);
    } catch (error) {
      const dbError = error as { code?: string };
      if (dbError.code === POSTGRES_UNIQUE_VIOLATION) {
        throw refundAlreadyOpen();
      }
      throw error;
    }
    this.eventEmitter.emit(
      MarketplaceRefundRequestedEvent.EVENT_NAME,
      new MarketplaceRefundRequestedEvent(request.id, orderId, learnerId),
    );
    return this.processing.process(request.id);
  }

  public async getOwnRequest(learnerId: string, id: string): Promise<MarketplaceRefundRequest> {
    const request = await this.refundRequests.findOne({ where: { id, learner_id: learnerId } });
    if (!request) {
      throw new NotFoundException(biBody('Refund request not found', 'طلب الاسترداد غير موجود'));
    }
    return request;
  }

  public async listQueue(
    status?: RefundRequestStatus,
    page = 1,
    limit = 20,
  ): Promise<RefundRequestQueue> {
    const where: FindOptionsWhere<MarketplaceRefundRequest> = {};
    if (status) where.status = status;
    const [data, total] = await this.refundRequests.findAndCount({
      where,
      order: { created_at: 'ASC' },
      skip: (page - 1) * limit,
      take: limit,
    });
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

  public async getById(id: string): Promise<MarketplaceRefundRequest> {
    const request = await this.refundRequests.findOne({ where: { id } });
    if (!request) {
      throw new NotFoundException(biBody('Refund request not found', 'طلب الاسترداد غير موجود'));
    }
    return request;
  }
}
