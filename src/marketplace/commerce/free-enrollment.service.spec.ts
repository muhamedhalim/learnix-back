import { FreeEnrollmentService } from './free-enrollment.service';
import { MarketplaceOrderStatus } from '../common/enums';

function buildOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    learner_id: 'learner-1',
    course_id: 'course-1',
    is_zero_value: true,
    status: MarketplaceOrderStatus.AWAITING_PAYMENT,
    ...overrides,
  };
}

function buildService(opts: { dailyCount?: number; settleOutcome?: string; coursePriceMinor?: number | null } = {}) {
  const order = buildOrder();
  const orders = {
    createOrder: jest.fn().mockResolvedValue(order),
  };
  const settlement = {
    settleFree: jest.fn().mockResolvedValue(opts.settleOutcome ?? 'settled'),
  };
  const priceMinor = 'coursePriceMinor' in opts ? opts.coursePriceMinor : 0;
  const queryBuilder = {
    andWhere: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(priceMinor === null ? null : { id: 'course-1', price_minor: priceMinor }),
  };
  const catalogQuery = { baseVisibleQuery: jest.fn().mockReturnValue(queryBuilder) };
  const dataSource = {
    transaction: jest.fn((fn: (manager: unknown) => unknown) => fn({})),
  };
  const ordersRepo = {
    count: jest.fn().mockResolvedValue(opts.dailyCount ?? 0),
    findOneOrFail: jest.fn().mockResolvedValue({ ...order, status: MarketplaceOrderStatus.PAID }),
  };
  const service = new FreeEnrollmentService(orders as never, settlement as never, catalogQuery as never, dataSource as never, ordersRepo as never);
  return { service, orders, settlement, ordersRepo, catalogQuery };
}

describe('FreeEnrollmentService (T111, T115)', () => {
  it('creates the order the normal way and settles it with no gateway interaction (FR-111)', async () => {
    const { service, orders, settlement } = buildService();

    const result = await service.enrollFree('learner-1', 'course-1');

    expect(orders.createOrder).toHaveBeenCalledWith('learner-1', 'course-1');
    expect(settlement.settleFree).toHaveBeenCalledWith('order-1', expect.anything());
    expect(result.status).toBe(MarketplaceOrderStatus.PAID);
  });

  it('refuses once the rolling-24h cap of 10 successful free enrollments is reached, naming the per_day limit (FR-121)', async () => {
    const { service, orders } = buildService({ dailyCount: 10 });

    await expect(service.enrollFree('learner-1', 'course-1')).rejects.toMatchObject({
      getResponse: expect.any(Function),
    });
    expect(orders.createOrder).not.toHaveBeenCalled();
  });

  it('allows the 10th enrollment through (cap is exclusive of the boundary below 10)', async () => {
    const { service, orders } = buildService({ dailyCount: 9 });
    await expect(service.enrollFree('learner-1', 'course-1')).resolves.toBeDefined();
    expect(orders.createOrder).toHaveBeenCalled();
  });

  it('refuses a paid course before creating any order — never leaves a stray order behind (FR-111)', async () => {
    const { service, orders } = buildService({ coursePriceMinor: 5000 });

    await expect(service.enrollFree('learner-1', 'course-1')).rejects.toMatchObject({
      getResponse: expect.any(Function),
    });
    expect(orders.createOrder).not.toHaveBeenCalled();
  });

  it('refuses a nonexistent/unpublished course before creating any order', async () => {
    const { service, orders } = buildService({ coursePriceMinor: null });

    await expect(service.enrollFree('learner-1', 'course-1')).rejects.toMatchObject({
      getResponse: expect.any(Function),
    });
    expect(orders.createOrder).not.toHaveBeenCalled();
  });

  it('the rate-limit refusal names FREE_ENROLLMENT_RATE_LIMITED / per_day', async () => {
    const { service } = buildService({ dailyCount: 10 });
    let caught: unknown;
    try {
      await service.enrollFree('learner-1', 'course-1');
    } catch (error) {
      caught = error;
    }
    const body = (caught as { getResponse(): { code: string; details: string[] } }).getResponse();
    expect(body.code).toBe('FREE_ENROLLMENT_RATE_LIMITED');
    expect(body.details).toEqual(['per_day']);
  });
});
