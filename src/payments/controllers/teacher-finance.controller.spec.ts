import { TeacherFinanceController } from './teacher-finance.controller';

describe('TeacherFinanceController', () => {
  const teacher = { userId: 'teacher-a' } as never;
  let orders: { findTeacherOrders: jest.Mock; findTeacherOrder: jest.Mock };
  let refunds: { list: jest.Mock };
  let settlements: {
    getTeacherWallet: jest.Mock;
    list: jest.Mock;
    details: jest.Mock;
    create: jest.Mock;
  };
  let controller: TeacherFinanceController;

  beforeEach(() => {
    orders = {
      findTeacherOrders: jest.fn().mockResolvedValue({ data: [], meta: {} }),
      findTeacherOrder: jest.fn().mockResolvedValue({ id: 'order-a' }),
    };
    refunds = { list: jest.fn().mockResolvedValue({ data: [], meta: {} }) };
    settlements = {
      getTeacherWallet: jest.fn().mockResolvedValue({
        currency: 'EGP',
        available_balance_minor: 5_000,
        pending_balance_minor: 0,
        lifetime_earnings_minor: 5_000,
        paid_out_minor: 0,
        refunded_reversed_minor: 0,
        teacher_collected_sales_minor: 0,
        outstanding_platform_receivable_minor: 0,
        next_settlement_date: null,
      }),
      list: jest.fn().mockResolvedValue({ data: [], meta: {} }),
      details: jest.fn().mockResolvedValue({ settlement: { id: 'settlement-a' } }),
      create: jest.fn().mockResolvedValue({ id: 'settlement-a' }),
    };
    controller = new TeacherFinanceController(
      orders as never,
      refunds as never,
      settlements as never,
    );
  });

  it('returns a teacher-safe wallet projection without platform-collected sales', async () => {
    await expect(controller.wallet(teacher)).resolves.toEqual({
      data: expect.not.objectContaining({ platform_collected_sales_minor: expect.anything() }),
    });
    expect(settlements.getTeacherWallet).toHaveBeenCalledWith('teacher-a');
  });

  it('overrides a supplied teacher_id with the authenticated teacher for orders and refunds', async () => {
    await controller.ordersList({ teacher_id: 'teacher-b', page: 2 } as never, teacher);
    await controller.refundList({ teacher_id: 'teacher-b', page: 2 } as never, teacher);

    expect(orders.findTeacherOrders).toHaveBeenCalledWith(
      expect.objectContaining({ teacher_id: 'teacher-a', page: 2 }),
    );
    expect(refunds.list).toHaveBeenCalledWith(
      expect.objectContaining({ teacher_id: 'teacher-a', page: 2 }),
    );
  });

  it('forces the authenticated teacher for settlements regardless of query parameters', async () => {
    await controller.settlementList({ teacher_id: 'teacher-b', page: 2 } as never, teacher);
    expect(settlements.list).toHaveBeenCalledWith(
      expect.not.objectContaining({ teacher_id: expect.anything() }),
      'teacher-a',
    );
  });

  it('returns teacher-only order and settlement details', async () => {
    await controller.orderDetails('00000000-0000-4000-8000-000000000001', teacher);
    await controller.settlementDetails('00000000-0000-4000-8000-000000000002', teacher);

    expect(orders.findTeacherOrder).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000001',
      'teacher-a',
    );
    expect(settlements.details).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000002',
      'teacher-a',
    );
  });

  it('creates a payout request only for the authenticated teacher without staff deductions', async () => {
    await controller.requestSettlement({ currency: 'EGP', notes: 'Monthly payout' }, teacher);

    expect(settlements.create).toHaveBeenCalledWith(
      {
        teacher_id: 'teacher-a',
        currency: 'EGP',
        notes: 'Monthly payout',
        payment_method: 'teacher_requested',
      },
      'teacher-a',
    );
  });
});
