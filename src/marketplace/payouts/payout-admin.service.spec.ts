import { BadRequestException } from '@nestjs/common';

import { MarketplaceLedgerDirection, MarketplaceLedgerEntryType, PayoutRequestStatus } from '../common/enums';
import { PayoutAdminService } from './payout-admin.service';

function buildRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'request-1',
    instructor_id: 'instructor-1',
    amount_minor: 5000,
    currency: 'EGP',
    status: PayoutRequestStatus.REQUESTED,
    ...overrides,
  };
}

describe('PayoutAdminService (T169, T170)', () => {
  let payoutRequests: { getOwnedOrThrow: jest.Mock; transition: jest.Mock; releaseEarnings: jest.Mock };
  let earningsService: { markProcessing: jest.Mock; markPaidOut: jest.Mock };
  let ledger: { post: jest.Mock };
  let manager: { find: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  let activityLogs: { recordAuditEvent: jest.Mock };
  let service: PayoutAdminService;

  beforeEach(() => {
    manager = { find: jest.fn().mockResolvedValue([]) };
    dataSource = { transaction: jest.fn((fn: (m: unknown) => unknown) => fn(manager)) };
    payoutRequests = {
      getOwnedOrThrow: jest.fn(),
      transition: jest.fn(async (_m, request: Record<string, unknown>, to: PayoutRequestStatus, extra: Record<string, unknown> = {}) => ({
        ...request,
        ...extra,
        status: to,
      })),
      releaseEarnings: jest.fn(),
    };
    earningsService = { markProcessing: jest.fn(), markPaidOut: jest.fn() };
    ledger = { post: jest.fn() };
    eventEmitter = { emit: jest.fn() };
    activityLogs = { recordAuditEvent: jest.fn() };
    service = new PayoutAdminService(
      payoutRequests as never,
      earningsService as never,
      ledger as never,
      dataSource as never,
      eventEmitter as never,
      activityLogs as never,
    );
  });

  describe('approve', () => {
    it('transitions to APPROVED and records the deciding admin', async () => {
      payoutRequests.getOwnedOrThrow.mockResolvedValue(buildRequest());

      const result = await service.approve('admin-1', 'request-1');

      expect(result.status).toBe(PayoutRequestStatus.APPROVED);
      expect(payoutRequests.transition).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ id: 'request-1' }),
        PayoutRequestStatus.APPROVED,
        expect.objectContaining({ decided_by: 'admin-1' }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'marketplace.payout.approved',
        expect.objectContaining({ payoutRequestId: 'request-1', instructorId: 'instructor-1' }),
      );
      expect(activityLogs.recordAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'marketplace_payout_decision',
          adminId: 'admin-1',
          details: expect.objectContaining({ decision: 'approved', instructorId: 'instructor-1' }),
        }),
      );
    });
  });

  describe('reject', () => {
    it('refuses without a reason', async () => {
      await expect(service.reject('admin-1', 'request-1', '')).rejects.toThrow(BadRequestException);
      expect(payoutRequests.getOwnedOrThrow).not.toHaveBeenCalled();
    });

    it('transitions to REJECTED and releases the locked earnings', async () => {
      payoutRequests.getOwnedOrThrow.mockResolvedValue(buildRequest());

      const result = await service.reject('admin-1', 'request-1', 'Fraudulent bank details');

      expect(result.status).toBe(PayoutRequestStatus.REJECTED);
      expect(payoutRequests.releaseEarnings).toHaveBeenCalledWith(manager, 'request-1');
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'marketplace.payout.rejected',
        expect.objectContaining({ payoutRequestId: 'request-1', reason: 'Fraudulent bank details' }),
      );
    });
  });

  describe('markProcessing', () => {
    it('transitions the request and every covered earning to PROCESSING', async () => {
      payoutRequests.getOwnedOrThrow.mockResolvedValue(buildRequest({ status: PayoutRequestStatus.APPROVED }));
      manager.find.mockResolvedValue([{ id: 'earning-1' }, { id: 'earning-2' }]);

      const result = await service.markProcessing('admin-1', 'request-1');

      expect(result.status).toBe(PayoutRequestStatus.PROCESSING);
      expect(earningsService.markProcessing).toHaveBeenCalledWith(manager, 'earning-1');
      expect(earningsService.markProcessing).toHaveBeenCalledWith(manager, 'earning-2');
      expect(eventEmitter.emit).toHaveBeenCalledWith('marketplace.payout.processing', expect.objectContaining({ payoutRequestId: 'request-1' }));
    });
  });

  describe('markPaid', () => {
    it('refuses without a payout reference', async () => {
      await expect(service.markPaid('admin-1', 'request-1', '')).rejects.toThrow(BadRequestException);
    });

    it('transitions to PAID, moves every earning to PAID_OUT, and posts a CREDIT PAYOUT ledger entry', async () => {
      payoutRequests.getOwnedOrThrow.mockResolvedValue(buildRequest({ status: PayoutRequestStatus.PROCESSING }));
      manager.find.mockResolvedValue([{ id: 'earning-1' }]);

      const result = await service.markPaid('admin-1', 'request-1', 'TXN-999');

      expect(result.status).toBe(PayoutRequestStatus.PAID);
      expect(result.payout_reference).toBe('TXN-999');
      expect(earningsService.markPaidOut).toHaveBeenCalledWith(manager, 'earning-1');
      expect(ledger.post).toHaveBeenCalledWith(
        expect.objectContaining({
          entryType: MarketplaceLedgerEntryType.PAYOUT,
          direction: MarketplaceLedgerDirection.CREDIT,
          amountMinor: 5000,
          currency: 'EGP',
          instructorId: 'instructor-1',
        }),
        manager,
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'marketplace.payout.paid',
        expect.objectContaining({ payoutRequestId: 'request-1', payoutReference: 'TXN-999' }),
      );
    });
  });

  describe('markFailed', () => {
    it('refuses without a reason', async () => {
      await expect(service.markFailed('admin-1', 'request-1', '')).rejects.toThrow(BadRequestException);
    });

    it('releases earnings without posting a reversal when failing from PROCESSING (nothing was ever paid)', async () => {
      payoutRequests.getOwnedOrThrow.mockResolvedValue(buildRequest({ status: PayoutRequestStatus.PROCESSING }));

      const result = await service.markFailed('admin-1', 'request-1', 'Bank rejected the transfer');

      expect(result.status).toBe(PayoutRequestStatus.FAILED);
      expect(payoutRequests.releaseEarnings).toHaveBeenCalledWith(manager, 'request-1');
      expect(ledger.post).not.toHaveBeenCalled();
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'marketplace.payout.failed',
        expect.objectContaining({ payoutRequestId: 'request-1', reason: 'Bank rejected the transfer' }),
      );
    });

    it('posts a DEBIT PAYOUT_REVERSAL entry when reversing a request that was already PAID', async () => {
      payoutRequests.getOwnedOrThrow.mockResolvedValue(buildRequest({ status: PayoutRequestStatus.PAID }));

      const result = await service.markFailed('admin-1', 'request-1', 'Funds bounced back days later');

      expect(result.status).toBe(PayoutRequestStatus.FAILED);
      expect(payoutRequests.releaseEarnings).toHaveBeenCalledWith(manager, 'request-1');
      expect(ledger.post).toHaveBeenCalledWith(
        expect.objectContaining({
          entryType: MarketplaceLedgerEntryType.PAYOUT_REVERSAL,
          direction: MarketplaceLedgerDirection.DEBIT,
          amountMinor: 5000,
          currency: 'EGP',
        }),
        manager,
      );
    });
  });
});
