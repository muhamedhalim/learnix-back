import { EventEmitter2 } from '@nestjs/event-emitter';

import { MarketplaceCommissionScope, MarketplaceOrderStatus } from '../common/enums';
import { MarketplaceOrderService } from './order.service';

function buildQb(result: unknown) {
  const qb: Record<string, unknown> = {};
  for (const method of ['where', 'andWhere']) {
    qb[method] = () => qb;
  }
  qb['getOne'] = jest.fn().mockResolvedValue(result);
  return qb;
}

function buildService(
  opts: {
    course?: Record<string, unknown> | null;
    existingOrder?: Record<string, unknown> | null;
    saveImpl?: (order: Record<string, unknown>) => Promise<Record<string, unknown>>;
    payment?: Record<string, unknown> | null;
    updateAffected?: number;
  } = {},
) {
  const course =
    'course' in opts
      ? opts.course
      : {
          id: 'course-1',
          price_minor: 5000,
          currency: 'EGP',
          current_version_id: 'v1',
          instructor_id: 'instructor-1',
          instructor: { user_id: 'instructor-user-1', display_name: 'Nour Ahmed' },
          title: 'React Basics',
        };

  const orders = {
    createQueryBuilder: jest.fn(() => buildQb(opts.existingOrder ?? null)),
    create: jest.fn((data: Record<string, unknown>) => data),
    save: jest.fn(
      opts.saveImpl ?? (async (data: Record<string, unknown>) => ({ id: 'order-1', ...data })),
    ),
    update: jest.fn().mockResolvedValue({ affected: opts.updateAffected ?? 1 }),
    manager: { findOne: jest.fn().mockResolvedValue('payment' in opts ? opts.payment : null) },
  };
  const catalogQuery = {
    baseVisibleQuery: jest.fn(() => buildQb(course)),
  };
  const commission = {
    resolveEffectiveRate: jest.fn().mockResolvedValue({
      rateBps: 3000,
      scope: MarketplaceCommissionScope.PLATFORM,
      scopeRefId: null,
    }),
    calculate: jest.fn((netMinor: number, rateBps: number) => ({
      platformCommissionBps: rateBps,
      platformCommissionMinor: Math.floor((netMinor * rateBps) / 10000),
      teacherEarningMinor: netMinor - Math.floor((netMinor * rateBps) / 10000),
    })),
  };
  const eventEmitter = new EventEmitter2();
  const emitSpy = jest.spyOn(eventEmitter, 'emit');

  const service = new MarketplaceOrderService(
    orders as never,
    catalogQuery as never,
    commission as never,
    eventEmitter,
  );
  return { service, orders, catalogQuery, commission, emitSpy };
}

describe('MarketplaceOrderService (T096)', () => {
  it('creates an order with the full FR-093 snapshot, including commission and refund terms', async () => {
    const { service, orders } = buildService();
    const order = await service.createOrder('learner-1', 'course-1');

    expect(order).toMatchObject({
      order_number: expect.stringMatching(/^MP-/),
      learner_id: 'learner-1',
      course_id: 'course-1',
      instructor_id: 'instructor-1',
      gross_amount_minor: 5000,
      net_amount_minor: 5000,
      currency: 'EGP',
      commission_bps: 3000,
      commission_amount_minor: 1500,
      instructor_earning_minor: 3500,
      refund_window_days: 14,
      status: MarketplaceOrderStatus.AWAITING_PAYMENT,
      is_zero_value: false,
      course_title_snapshot: 'React Basics',
    });
    expect(orders.save).toHaveBeenCalled();
  });

  it('refuses to create an order for a course that is not currently purchasable (FR-103)', async () => {
    const { service } = buildService({ course: null });
    await expect(service.createOrder('learner-1', 'course-1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'COURSE_NOT_PURCHASABLE' }),
    });
  });

  it('refuses to let an instructor buy their own course (FR-098)', async () => {
    const { service } = buildService({
      course: {
        id: 'course-1',
        price_minor: 5000,
        currency: 'EGP',
        current_version_id: 'v1',
        instructor_id: 'instructor-1',
        instructor: { user_id: 'same-user', display_name: 'Nour Ahmed' },
        title: 'React Basics',
      },
    });
    await expect(service.createOrder('same-user', 'course-1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'SELF_PURCHASE_NOT_ALLOWED' }),
    });
  });

  it('refuses a duplicate open order for the same course (app-level check ahead of UQ_mp_orders_open_per_course)', async () => {
    const { service } = buildService({ existingOrder: { id: 'existing-order' } });
    await expect(service.createOrder('learner-1', 'course-1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'ORDER_ALREADY_OPEN' }),
    });
  });

  it('refuses a free course at checkout; only the free-enrollment flow may open an order for it (MP-17)', async () => {
    const free = {
      id: 'course-1',
      price_minor: 0,
      currency: 'EGP',
      current_version_id: 'v1',
      instructor_id: 'instructor-1',
      instructor: { user_id: 'instructor-user-1', display_name: 'Nour Ahmed' },
      title: 'Free',
    };
    const { service } = buildService({ course: free });
    await expect(service.createOrder('learner-1', 'course-1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'COURSE_IS_FREE' }),
    });
    await expect(
      service.createOrder('learner-1', 'course-1', MarketplaceOrderStatus.AWAITING_PAYMENT, {
        allowFree: true,
      }),
    ).resolves.toMatchObject({ is_zero_value: true });
  });

  describe('abandoned open orders (MP-17)', () => {
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const open = (overrides: Record<string, unknown> = {}) => ({
      id: 'old-order',
      status: MarketplaceOrderStatus.AWAITING_PAYMENT,
      created_at: stale,
      payment_id: null,
      ...overrides,
    });

    it('closes a day-old order whose payment never started and lets a new one through', async () => {
      const { service, orders } = buildService({ existingOrder: open() });
      await expect(service.createOrder('learner-1', 'course-1')).resolves.toMatchObject({
        learner_id: 'learner-1',
      });
      expect(orders.update).toHaveBeenCalledWith(
        { id: 'old-order', status: MarketplaceOrderStatus.AWAITING_PAYMENT },
        { status: MarketplaceOrderStatus.EXPIRED },
      );
    });

    it('closes it when its payment already failed or expired', async () => {
      const { service } = buildService({
        existingOrder: open({ payment_id: 'p1' }),
        payment: { id: 'p1', status: 'expired' },
      });
      await expect(service.createOrder('learner-1', 'course-1')).resolves.toBeDefined();
    });

    it('keeps blocking while the payment may still settle (pending, processing, completed)', async () => {
      for (const status of ['pending', 'processing', 'completed']) {
        const { service, orders } = buildService({
          existingOrder: open({ payment_id: 'p1' }),
          payment: { id: 'p1', status },
        });
        await expect(service.createOrder('learner-1', 'course-1')).rejects.toMatchObject({
          response: expect.objectContaining({ code: 'ORDER_ALREADY_OPEN' }),
        });
        expect(orders.update).not.toHaveBeenCalled();
      }
    });

    it('keeps blocking a recent order', async () => {
      const { service } = buildService({ existingOrder: open({ created_at: new Date() }) });
      await expect(service.createOrder('learner-1', 'course-1')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'ORDER_ALREADY_OPEN' }),
      });
    });

    it('does not create a second order when another request closed it first', async () => {
      const { service } = buildService({ existingOrder: open(), updateAffected: 0 });
      await expect(service.createOrder('learner-1', 'course-1')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'ORDER_ALREADY_OPEN' }),
      });
    });
  });

  it('translates a unique-constraint violation from a concurrent request into the same friendly error', async () => {
    const { service } = buildService({
      saveImpl: async () => {
        throw Object.assign(new Error('duplicate key'), { code: '23505' });
      },
    });
    await expect(service.createOrder('learner-1', 'course-1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'ORDER_ALREADY_OPEN' }),
    });
  });

  it('emits MarketplaceOrderCreatedEvent after saving', async () => {
    const { service, emitSpy } = buildService();
    await service.createOrder('learner-1', 'course-1');
    expect(emitSpy).toHaveBeenCalledWith(
      'marketplace.order.created',
      expect.objectContaining({ orderId: 'order-1', learnerId: 'learner-1', courseId: 'course-1' }),
    );
  });
});
