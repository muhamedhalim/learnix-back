import { ConflictException, NotFoundException } from '@nestjs/common';

import { InstructorEarningStatus, PayoutRequestStatus } from '../common/enums';
import { PayoutRequestService } from './payout-request.service';

function buildEarning(overrides: Record<string, unknown> = {}) {
  return {
    id: 'earning-1',
    instructor_id: 'instructor-1',
    currency: 'EGP',
    status: InstructorEarningStatus.AVAILABLE_BALANCE,
    net_amount_minor: 5000,
    available_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function buildRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'request-1',
    instructor_id: 'instructor-1',
    payout_account_id: 'account-1',
    amount_minor: 5000,
    currency: 'EGP',
    status: PayoutRequestStatus.REQUESTED,
    idempotency_key: 'idem-1',
    ...overrides,
  };
}

function buildDataSource(manager: { getRepository?: jest.Mock }, eligible: ReturnType<typeof buildEarning>[]) {
  const earningsQb = {
    setLock: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(eligible),
  };
  const earningsRepo = { createQueryBuilder: jest.fn().mockReturnValue(earningsQb) };
  manager.getRepository = jest.fn(() => earningsRepo);
  return {
    transaction: jest.fn((fn: (m: unknown) => unknown) => fn(manager)),
  };
}

describe('PayoutRequestService (T167, T168)', () => {
  let payoutRequestsRepo: { findOne: jest.Mock };
  let payoutAccountsRepo: { findOne: jest.Mock };
  let currencyRegistry: { resolve: jest.Mock };
  let earningsService: { lockForPayout: jest.Mock; releaseToAvailable: jest.Mock };
  let manager: { create: jest.Mock; save: jest.Mock; find: jest.Mock; findOne: jest.Mock; getRepository?: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  let service: PayoutRequestService;

  beforeEach(() => {
    payoutRequestsRepo = { findOne: jest.fn() };
    payoutAccountsRepo = { findOne: jest.fn() };
    currencyRegistry = { resolve: jest.fn().mockResolvedValue({ min_payout_minor: 1000 }) };
    earningsService = { lockForPayout: jest.fn(), releaseToAvailable: jest.fn() };
    manager = {
      create: jest.fn((_entity: unknown, data: Record<string, unknown>) => ({ ...data })),
      save: jest.fn(async (_entity: unknown, data: Record<string, unknown>) => ({ id: 'request-1', ...data })),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
    };
    eventEmitter = { emit: jest.fn() };
    service = new PayoutRequestService(
      payoutRequestsRepo as never,
      payoutAccountsRepo as never,
      currencyRegistry as never,
      earningsService as never,
      undefined as never,
      eventEmitter as never,
    );
  });

  describe('createRequest', () => {
    it('replays an existing request for a reused idempotency key without touching accounts or earnings', async () => {
      const existing = buildRequest();
      payoutRequestsRepo.findOne.mockResolvedValue(existing);

      const result = await service.createRequest('instructor-1', { payoutAccountId: 'account-1', amountMinor: 5000, currency: 'EGP' }, 'idem-1');

      expect(result).toBe(existing);
      expect(payoutAccountsRepo.findOne).not.toHaveBeenCalled();
    });

    it('404s when the payout account does not belong to the instructor', async () => {
      payoutRequestsRepo.findOne.mockResolvedValue(null);
      payoutAccountsRepo.findOne.mockResolvedValue(null);

      await expect(
        service.createRequest('instructor-1', { payoutAccountId: 'account-1', amountMinor: 5000, currency: 'EGP' }, 'idem-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('refuses a currency mismatch between the request and the destination account', async () => {
      payoutRequestsRepo.findOne.mockResolvedValue(null);
      payoutAccountsRepo.findOne.mockResolvedValue({ id: 'account-1', currency: 'USD' });

      await expect(
        service.createRequest('instructor-1', { payoutAccountId: 'account-1', amountMinor: 5000, currency: 'EGP' }, 'idem-1'),
      ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'PAYOUT_ACCOUNT_CURRENCY_MISMATCH' }) });
    });

    it('refuses an amount below the currency minimum payout', async () => {
      payoutRequestsRepo.findOne.mockResolvedValue(null);
      payoutAccountsRepo.findOne.mockResolvedValue({ id: 'account-1', currency: 'EGP' });
      currencyRegistry.resolve.mockResolvedValue({ min_payout_minor: 10000 });

      await expect(
        service.createRequest('instructor-1', { payoutAccountId: 'account-1', amountMinor: 5000, currency: 'EGP' }, 'idem-1'),
      ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'PAYOUT_BELOW_MINIMUM' }) });
    });

    it('refuses when available earnings cannot cover the requested minimum', async () => {
      payoutRequestsRepo.findOne.mockResolvedValue(null);
      payoutAccountsRepo.findOne.mockResolvedValue({ id: 'account-1', currency: 'EGP' });
      const dataSource = buildDataSource(manager, [buildEarning({ net_amount_minor: 1000 })]);
      service = new PayoutRequestService(payoutRequestsRepo as never, payoutAccountsRepo as never, currencyRegistry as never, earningsService as never, dataSource as never, eventEmitter as never);

      await expect(
        service.createRequest('instructor-1', { payoutAccountId: 'account-1', amountMinor: 5000, currency: 'EGP' }, 'idem-1'),
      ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'PAYOUT_INSUFFICIENT_BALANCE' }) });
      expect(earningsService.lockForPayout).not.toHaveBeenCalled();
    });

    it('covers earnings oldest-first and sets amount_minor to the real cumulative sum, not the requested minimum', async () => {
      payoutRequestsRepo.findOne.mockResolvedValue(null);
      payoutAccountsRepo.findOne.mockResolvedValue({ id: 'account-1', currency: 'EGP' });
      const older = buildEarning({ id: 'earning-older', net_amount_minor: 3000, available_at: new Date('2026-01-01T00:00:00.000Z') });
      const newer = buildEarning({ id: 'earning-newer', net_amount_minor: 3000, available_at: new Date('2026-01-02T00:00:00.000Z') });
      const dataSource = buildDataSource(manager, [older, newer]);
      service = new PayoutRequestService(payoutRequestsRepo as never, payoutAccountsRepo as never, currencyRegistry as never, earningsService as never, dataSource as never, eventEmitter as never);

      const result = await service.createRequest('instructor-1', { payoutAccountId: 'account-1', amountMinor: 5000, currency: 'EGP' }, 'idem-1');

      // 3000 alone doesn't cover 5000, so both earnings are pulled — real total is 6000, not 5000.
      expect(result.amount_minor).toBe(6000);
      expect(earningsService.lockForPayout).toHaveBeenCalledWith(manager, 'earning-older', 'request-1');
      expect(earningsService.lockForPayout).toHaveBeenCalledWith(manager, 'earning-newer', 'request-1');
      expect(earningsService.lockForPayout).toHaveBeenCalledTimes(2);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'marketplace.payout.requested',
        expect.objectContaining({ payoutRequestId: 'request-1', instructorId: 'instructor-1' }),
      );
    });

    it('returns the raced-in row when a concurrent request wins the idempotency-key insert', async () => {
      payoutRequestsRepo.findOne.mockResolvedValue(null);
      payoutAccountsRepo.findOne.mockResolvedValue({ id: 'account-1', currency: 'EGP' });
      const dataSource = buildDataSource(manager, [buildEarning({ net_amount_minor: 6000 })]);
      service = new PayoutRequestService(payoutRequestsRepo as never, payoutAccountsRepo as never, currencyRegistry as never, earningsService as never, dataSource as never, eventEmitter as never);
      const raced = buildRequest({ id: 'raced-request' });
      manager.save.mockRejectedValueOnce({ code: '23505' });
      manager.findOne.mockResolvedValueOnce(raced);

      const result = await service.createRequest('instructor-1', { payoutAccountId: 'account-1', amountMinor: 5000, currency: 'EGP' }, 'idem-1');

      expect(result).toBe(raced);
      expect(earningsService.lockForPayout).not.toHaveBeenCalled();
    });
  });

  describe('cancel', () => {
    it('404s a request that does not belong to the caller', async () => {
      const dataSource = buildDataSource(manager, []);
      service = new PayoutRequestService(payoutRequestsRepo as never, payoutAccountsRepo as never, currencyRegistry as never, earningsService as never, dataSource as never, eventEmitter as never);
      manager.findOne.mockResolvedValue(null);

      await expect(service.cancel('instructor-1', 'request-1')).rejects.toThrow(NotFoundException);
    });

    it('cancels a REQUESTED request and releases its locked earnings', async () => {
      const dataSource = buildDataSource(manager, []);
      service = new PayoutRequestService(payoutRequestsRepo as never, payoutAccountsRepo as never, currencyRegistry as never, earningsService as never, dataSource as never, eventEmitter as never);
      manager.findOne.mockResolvedValue(buildRequest());
      manager.find.mockResolvedValue([buildEarning({ id: 'earning-1' }), buildEarning({ id: 'earning-2' })]);

      const result = await service.cancel('instructor-1', 'request-1');

      expect(result.status).toBe(PayoutRequestStatus.CANCELLED);
      expect(earningsService.releaseToAvailable).toHaveBeenCalledWith(manager, 'earning-1');
      expect(earningsService.releaseToAvailable).toHaveBeenCalledWith(manager, 'earning-2');
    });

    it('refuses to cancel a request that already left REQUESTED', async () => {
      const dataSource = buildDataSource(manager, []);
      service = new PayoutRequestService(payoutRequestsRepo as never, payoutAccountsRepo as never, currencyRegistry as never, earningsService as never, dataSource as never, eventEmitter as never);
      manager.findOne.mockResolvedValue(buildRequest({ status: PayoutRequestStatus.PAID }));

      await expect(service.cancel('instructor-1', 'request-1')).rejects.toThrow(ConflictException);
      expect(earningsService.releaseToAvailable).not.toHaveBeenCalled();
    });
  });

  describe('transition', () => {
    it.each([
      [PayoutRequestStatus.REQUESTED, PayoutRequestStatus.APPROVED, true],
      [PayoutRequestStatus.REQUESTED, PayoutRequestStatus.REJECTED, true],
      [PayoutRequestStatus.REQUESTED, PayoutRequestStatus.CANCELLED, true],
      [PayoutRequestStatus.REQUESTED, PayoutRequestStatus.PROCESSING, false],
      [PayoutRequestStatus.APPROVED, PayoutRequestStatus.PROCESSING, true],
      [PayoutRequestStatus.APPROVED, PayoutRequestStatus.REJECTED, true],
      [PayoutRequestStatus.APPROVED, PayoutRequestStatus.CANCELLED, true],
      [PayoutRequestStatus.APPROVED, PayoutRequestStatus.PAID, false],
      [PayoutRequestStatus.PROCESSING, PayoutRequestStatus.PAID, true],
      [PayoutRequestStatus.PROCESSING, PayoutRequestStatus.FAILED, true],
      [PayoutRequestStatus.PROCESSING, PayoutRequestStatus.APPROVED, false],
      [PayoutRequestStatus.PAID, PayoutRequestStatus.FAILED, true],
      [PayoutRequestStatus.PAID, PayoutRequestStatus.PROCESSING, false],
      [PayoutRequestStatus.REJECTED, PayoutRequestStatus.APPROVED, false],
      [PayoutRequestStatus.CANCELLED, PayoutRequestStatus.APPROVED, false],
      [PayoutRequestStatus.FAILED, PayoutRequestStatus.PAID, false],
    ])('%s -> %s allowed=%s', async (from, to, allowed) => {
      const request = buildRequest({ status: from });
      if (allowed) {
        const result = await service.transition(manager as never, request as never, to);
        expect(result.status).toBe(to);
      } else {
        await expect(service.transition(manager as never, request as never, to)).rejects.toThrow(ConflictException);
      }
    });
  });

  describe('getOwnedOrThrow', () => {
    it('404s when the request row is absent', async () => {
      manager.findOne.mockResolvedValue(null);
      await expect(service.getOwnedOrThrow(manager as never, 'request-1')).rejects.toThrow(NotFoundException);
    });
  });
});
