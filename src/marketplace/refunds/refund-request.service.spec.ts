import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { MarketplaceOrderStatus, RefundRequestStatus } from '../common/enums';
import { MarketplaceRefundDecisionEvent } from '../events/audit.events';
import {
  MarketplaceRefundRefusedEvent,
  MarketplaceRefundRequestedEvent,
} from '../events/domain.events';
import { RefundRequestService } from './refund-request.service';

function buildOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    learner_id: 'learner-1',
    status: MarketplaceOrderStatus.PAID,
    is_zero_value: false,
    paid_at: new Date('2026-01-01T00:00:00.000Z'),
    refund_window_days: 14,
    consumption_cap_bps: 3000,
    ...overrides,
  };
}

function buildEnrollment(overrides: Record<string, unknown> = {}) {
  return { id: 'enrollment-1', order_id: 'order-1', progress_bps: 500, ...overrides };
}

describe('RefundRequestService (T135)', () => {
  let ordersRepo: { findOne: jest.Mock };
  let enrollmentsRepo: { findOne: jest.Mock };
  let refundRequestsRepo: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    findAndCount: jest.Mock;
  };
  let eligibility: { evaluateForOrder: jest.Mock };
  let processing: { process: jest.Mock };
  let eventEmitter: EventEmitter2;
  let activityLogs: { recordAuditEvent: jest.Mock };
  let idempotency: { checkPaymentRequest: jest.Mock; storePaymentResult: jest.Mock };
  let service: RefundRequestService;

  beforeEach(() => {
    ordersRepo = { findOne: jest.fn() };
    enrollmentsRepo = { findOne: jest.fn() };
    refundRequestsRepo = {
      create: jest.fn((data: Record<string, unknown>) => ({ ...data })),
      save: jest.fn(async (data: Record<string, unknown>) => ({ id: 'refund-1', ...data })),
      findOne: jest.fn(),
      findAndCount: jest.fn(),
    };
    eligibility = { evaluateForOrder: jest.fn() };
    processing = {
      process: jest.fn(async (id: string) => ({ id, status: RefundRequestStatus.COMPLETED })),
    };
    eventEmitter = new EventEmitter2();
    activityLogs = { recordAuditEvent: jest.fn().mockResolvedValue(undefined) };
    idempotency = {
      checkPaymentRequest: jest.fn().mockResolvedValue({ isProcessed: false }),
      storePaymentResult: jest.fn().mockResolvedValue(undefined),
    };

    service = new RefundRequestService(
      refundRequestsRepo as never,
      ordersRepo as never,
      enrollmentsRepo as never,
      eligibility as never,
      processing as never,
      eventEmitter,
      activityLogs as never,
      idempotency as never,
    );
  });

  describe('requestRefund', () => {
    it('scopes the order lookup to the requesting learner (IDOR-safe 404)', async () => {
      ordersRepo.findOne.mockResolvedValue(null);
      await expect(
        service.requestRefund('learner-1', 'order-1', 'reason', 'idem-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('auto-approves and immediately processes an eligible request, emitting the requested event', async () => {
      ordersRepo.findOne.mockResolvedValue(buildOrder());
      enrollmentsRepo.findOne.mockResolvedValue(buildEnrollment());
      eligibility.evaluateForOrder.mockReturnValue({
        eligible: true,
        failedCondition: null,
        elapsedDays: 1,
        progressBps: 500,
        windowDays: 14,
        capBps: 3000,
        daysRemaining: 13,
      });
      const requested: unknown[] = [];
      eventEmitter.on(MarketplaceRefundRequestedEvent.EVENT_NAME, (e) => requested.push(e));

      const result = await service.requestRefund(
        'learner-1',
        'order-1',
        'Changed my mind',
        'idem-1',
      );

      expect(refundRequestsRepo.save).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ status: RefundRequestStatus.REQUESTED }),
      );
      expect(refundRequestsRepo.save).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ status: RefundRequestStatus.APPROVED }),
      );
      expect(processing.process).toHaveBeenCalledWith('refund-1');
      expect(requested).toHaveLength(1);
      expect(result.status).toBe(RefundRequestStatus.COMPLETED);
    });

    it('auto-rejects an ineligible request and names the failed condition, without ever processing it', async () => {
      ordersRepo.findOne.mockResolvedValue(buildOrder());
      enrollmentsRepo.findOne.mockResolvedValue(buildEnrollment());
      eligibility.evaluateForOrder.mockReturnValue({
        eligible: false,
        failedCondition: 'REFUND_WINDOW_EXPIRED',
        elapsedDays: 20,
        progressBps: 500,
        windowDays: 14,
        capBps: 3000,
        daysRemaining: 0,
      });
      const refused: MarketplaceRefundRefusedEvent[] = [];
      eventEmitter.on(
        MarketplaceRefundRefusedEvent.EVENT_NAME,
        (e: MarketplaceRefundRefusedEvent) => refused.push(e),
      );

      const result = await service.requestRefund('learner-1', 'order-1', 'Too late', 'idem-1');

      expect(result.status).toBe(RefundRequestStatus.REJECTED);
      expect(processing.process).not.toHaveBeenCalled();
      expect(refused).toHaveLength(1);
      expect(refused[0]!.failedCondition).toBe('REFUND_WINDOW_EXPIRED');
    });

    it('replays the cached terminal result for a retried idempotency key without touching the database', async () => {
      idempotency.checkPaymentRequest.mockResolvedValue({
        isProcessed: true,
        cachedResult: { id: 'refund-1', status: RefundRequestStatus.COMPLETED },
      });

      const result = await service.requestRefund(
        'learner-1',
        'order-1',
        'Changed my mind',
        'idem-1',
      );

      expect(result.status).toBe(RefundRequestStatus.COMPLETED);
      expect(ordersRepo.findOne).not.toHaveBeenCalled();
      expect(processing.process).not.toHaveBeenCalled();
    });

    it('translates a unique-constraint violation into REFUND_ALREADY_OPEN', async () => {
      ordersRepo.findOne.mockResolvedValue(buildOrder());
      enrollmentsRepo.findOne.mockResolvedValue(buildEnrollment());
      eligibility.evaluateForOrder.mockReturnValue({ eligible: true, failedCondition: null });
      refundRequestsRepo.save.mockRejectedValueOnce({ code: '23505' });

      await expect(
        service.requestRefund('learner-1', 'order-1', 'reason', 'idem-1'),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('discretionaryApprove', () => {
    it('requires a non-empty reason', async () => {
      await expect(service.discretionaryApprove('admin-1', 'refund-1', '  ')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('refuses to discretionarily approve a request that was never rejected', async () => {
      refundRequestsRepo.findOne.mockResolvedValue({
        id: 'refund-1',
        status: RefundRequestStatus.REQUESTED,
      });
      await expect(service.discretionaryApprove('admin-1', 'refund-1', 'goodwill')).rejects.toThrow(
        ConflictException,
      );
    });

    it('is a no-op returning the existing row for an already-approved/processing/completed request', async () => {
      refundRequestsRepo.findOne.mockResolvedValue({
        id: 'refund-1',
        status: RefundRequestStatus.COMPLETED,
      });
      const result = await service.discretionaryApprove('admin-1', 'refund-1', 'goodwill');
      expect(result.status).toBe(RefundRequestStatus.COMPLETED);
      expect(processing.process).not.toHaveBeenCalled();
    });

    it('approves a rejected request, records an audit event and processes it (FR-186, FR-289)', async () => {
      refundRequestsRepo.findOne.mockResolvedValue({
        id: 'refund-1',
        order_id: 'order-1',
        status: RefundRequestStatus.REJECTED,
        eligibility_verdict: { failedCondition: 'REFUND_WINDOW_EXPIRED' },
      });

      const result = await service.discretionaryApprove('admin-1', 'refund-1', 'Goodwill gesture');

      expect(refundRequestsRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: RefundRequestStatus.APPROVED,
          is_discretionary: true,
          decided_by: 'admin-1',
        }),
      );
      expect(activityLogs.recordAuditEvent).toHaveBeenCalledWith(
        expect.any(MarketplaceRefundDecisionEvent),
      );
      expect(processing.process).toHaveBeenCalledWith('refund-1');
      expect(result.status).toBe(RefundRequestStatus.COMPLETED);
    });
  });

  describe('createRemovalDrivenRefund', () => {
    it('creates an already-approved, removal-driven request and processes it immediately, bypassing eligibility', async () => {
      const result = await service.createRemovalDrivenRefund(
        'order-1',
        'enrollment-1',
        'learner-1',
        'Course permanently removed',
      );

      expect(eligibility.evaluateForOrder).not.toHaveBeenCalled();
      expect(refundRequestsRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: RefundRequestStatus.APPROVED, is_removal_driven: true }),
      );
      expect(processing.process).toHaveBeenCalledWith('refund-1');
      expect(result.status).toBe(RefundRequestStatus.COMPLETED);
    });
  });

  describe('getOwnRequest', () => {
    it('scopes the lookup to the requesting learner (IDOR-safe 404)', async () => {
      refundRequestsRepo.findOne.mockResolvedValue(null);
      await expect(service.getOwnRequest('learner-1', 'refund-1')).rejects.toThrow(
        NotFoundException,
      );
      expect(refundRequestsRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'refund-1', learner_id: 'learner-1' },
      });
    });
  });

  describe('listQueue', () => {
    it('paginates and optionally filters by status', async () => {
      refundRequestsRepo.findAndCount.mockResolvedValue([[{ id: 'refund-1' }], 1]);
      const result = await service.listQueue(RefundRequestStatus.REQUESTED, 1, 20);
      expect(result.meta.total).toBe(1);
      expect(refundRequestsRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: RefundRequestStatus.REQUESTED } }),
      );
    });
  });
});
