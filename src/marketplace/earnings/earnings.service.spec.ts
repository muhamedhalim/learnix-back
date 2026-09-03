import { ConflictException, NotFoundException } from '@nestjs/common';

import { InstructorEarningStatus } from '../common/enums';
import { EarningsService } from './earnings.service';

function buildManager(earning: Record<string, unknown> | null) {
  return {
    findOne: jest.fn().mockResolvedValue(earning),
    save: jest.fn(async (_entity: unknown, data: Record<string, unknown>) => data),
  };
}

describe('EarningsService (T162)', () => {
  let service: EarningsService;

  beforeEach(() => {
    service = new EarningsService();
  });

  it('404s a nonexistent earning', async () => {
    const manager = buildManager(null);
    await expect(service.transition(manager as never, 'earning-1', InstructorEarningStatus.REFUND_CLEARANCE)).rejects.toThrow(
      NotFoundException,
    );
  });

  describe.each([
    [InstructorEarningStatus.PENDING_EARNINGS, InstructorEarningStatus.REFUND_CLEARANCE, true],
    [InstructorEarningStatus.PENDING_EARNINGS, InstructorEarningStatus.REVERSED, true],
    [InstructorEarningStatus.PENDING_EARNINGS, InstructorEarningStatus.AVAILABLE_BALANCE, false],
    [InstructorEarningStatus.PENDING_EARNINGS, InstructorEarningStatus.PAID_OUT, false],
    [InstructorEarningStatus.REFUND_CLEARANCE, InstructorEarningStatus.AVAILABLE_BALANCE, true],
    [InstructorEarningStatus.REFUND_CLEARANCE, InstructorEarningStatus.REVERSED, true],
    [InstructorEarningStatus.REFUND_CLEARANCE, InstructorEarningStatus.PENDING_EARNINGS, false],
    [InstructorEarningStatus.AVAILABLE_BALANCE, InstructorEarningStatus.PAYOUT_REQUESTED, true],
    [InstructorEarningStatus.AVAILABLE_BALANCE, InstructorEarningStatus.REVERSED, true],
    [InstructorEarningStatus.AVAILABLE_BALANCE, InstructorEarningStatus.PROCESSING, false],
    [InstructorEarningStatus.PAYOUT_REQUESTED, InstructorEarningStatus.PROCESSING, true],
    [InstructorEarningStatus.PAYOUT_REQUESTED, InstructorEarningStatus.AVAILABLE_BALANCE, true],
    [InstructorEarningStatus.PAYOUT_REQUESTED, InstructorEarningStatus.REVERSED, true],
    [InstructorEarningStatus.PAYOUT_REQUESTED, InstructorEarningStatus.PAID_OUT, false],
    [InstructorEarningStatus.PROCESSING, InstructorEarningStatus.PAID_OUT, true],
    [InstructorEarningStatus.PROCESSING, InstructorEarningStatus.AVAILABLE_BALANCE, true],
    [InstructorEarningStatus.PROCESSING, InstructorEarningStatus.REVERSED, false],
    [InstructorEarningStatus.PROCESSING, InstructorEarningStatus.PAYOUT_REQUESTED, false],
    [InstructorEarningStatus.PAID_OUT, InstructorEarningStatus.AVAILABLE_BALANCE, true],
    [InstructorEarningStatus.PAID_OUT, InstructorEarningStatus.REVERSED, false],
    [InstructorEarningStatus.REVERSED, InstructorEarningStatus.AVAILABLE_BALANCE, false],
    [InstructorEarningStatus.REVERSED, InstructorEarningStatus.PENDING_EARNINGS, false],
  ])('%s -> %s', (from, to, allowed) => {
    it(allowed ? 'is permitted' : 'is refused', async () => {
      const manager = buildManager({ id: 'earning-1', status: from });
      if (allowed) {
        const result = await service.transition(manager as never, 'earning-1', to);
        expect(result.status).toBe(to);
      } else {
        await expect(service.transition(manager as never, 'earning-1', to)).rejects.toThrow(ConflictException);
      }
    });
  });

  it('never touches amount fields (FR-156)', async () => {
    const earning = { id: 'earning-1', status: InstructorEarningStatus.PENDING_EARNINGS, gross_amount_minor: 5000 };
    const manager = buildManager(earning);
    const result = await service.transition(manager as never, 'earning-1', InstructorEarningStatus.REFUND_CLEARANCE);
    expect(result.gross_amount_minor).toBe(5000);
  });

  it('lockForPayout records the payout_request_id', async () => {
    const manager = buildManager({ id: 'earning-1', status: InstructorEarningStatus.AVAILABLE_BALANCE });
    const result = await service.lockForPayout(manager as never, 'earning-1', 'payout-1');
    expect(result).toMatchObject({ status: InstructorEarningStatus.PAYOUT_REQUESTED, payout_request_id: 'payout-1' });
  });

  it('releaseToAvailable clears the payout_request_id', async () => {
    const manager = buildManager({ id: 'earning-1', status: InstructorEarningStatus.PROCESSING, payout_request_id: 'payout-1' });
    const result = await service.releaseToAvailable(manager as never, 'earning-1');
    expect(result).toMatchObject({ status: InstructorEarningStatus.AVAILABLE_BALANCE, payout_request_id: null });
  });
});
