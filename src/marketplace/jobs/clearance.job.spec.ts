import { InstructorEarningStatus, RefundRequestStatus } from '../common/enums';
import { ClearanceSweepService } from './clearance.job';

function buildEarning(overrides: Record<string, unknown> = {}) {
  return {
    id: 'earning-1',
    order_id: 'order-1',
    instructor_id: 'instructor-1',
    status: InstructorEarningStatus.REFUND_CLEARANCE,
    available_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('ClearanceSweepService (T163)', () => {
  let earningsRepo: { find: jest.Mock };
  let refundRequestsRepo: { exist: jest.Mock };
  let earningsService: { moveToAvailableBalance: jest.Mock };
  let manager: object;
  let dataSource: { transaction: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  let service: ClearanceSweepService;

  beforeEach(() => {
    manager = {};
    dataSource = { transaction: jest.fn((fn: (m: unknown) => unknown) => fn(manager)) };
    earningsRepo = { find: jest.fn().mockResolvedValue([]) };
    refundRequestsRepo = { exist: jest.fn().mockResolvedValue(false) };
    earningsService = { moveToAvailableBalance: jest.fn() };
    eventEmitter = { emit: jest.fn() };
    service = new ClearanceSweepService(
      earningsRepo as never,
      refundRequestsRepo as never,
      earningsService as never,
      dataSource as never,
      eventEmitter as never,
    );
  });

  it('only queries earnings currently in REFUND_CLEARANCE with an expired window', async () => {
    await service.runSweep();

    expect(earningsRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: InstructorEarningStatus.REFUND_CLEARANCE }),
      }),
    );
  });

  it('clears a due earning with no open refund request', async () => {
    earningsRepo.find.mockResolvedValue([buildEarning()]);

    const result = await service.runSweep();

    expect(result).toEqual({ cleared: 1, skipped: 0 });
    expect(earningsService.moveToAvailableBalance).toHaveBeenCalledWith(manager, 'earning-1');
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'marketplace.earning.cleared',
      expect.objectContaining({ earningId: 'earning-1', orderId: 'order-1', instructorId: 'instructor-1' }),
    );
  });

  it('skips an earning whose order has an open refund request, leaving it in REFUND_CLEARANCE', async () => {
    earningsRepo.find.mockResolvedValue([buildEarning()]);
    refundRequestsRepo.exist.mockResolvedValue(true);

    const result = await service.runSweep();

    expect(result).toEqual({ cleared: 0, skipped: 1 });
    expect(earningsService.moveToAvailableBalance).not.toHaveBeenCalled();
  });

  it('checks only REQUESTED/APPROVED/PROCESSING as open, matching UQ_mp_refunds_open_per_order', async () => {
    earningsRepo.find.mockResolvedValue([buildEarning()]);

    await service.runSweep();

    expect(refundRequestsRepo.exist).toHaveBeenCalledWith({
      where: {
        order_id: 'order-1',
        status: expect.objectContaining({
          _value: [RefundRequestStatus.REQUESTED, RefundRequestStatus.APPROVED, RefundRequestStatus.PROCESSING],
        }),
      },
    });
  });

  it('clears each due earning independently — one per earning, not a single shared transaction', async () => {
    earningsRepo.find.mockResolvedValue([buildEarning({ id: 'earning-1' }), buildEarning({ id: 'earning-2', order_id: 'order-2' })]);

    const result = await service.runSweep();

    expect(result).toEqual({ cleared: 2, skipped: 0 });
    expect(dataSource.transaction).toHaveBeenCalledTimes(2);
  });
});
