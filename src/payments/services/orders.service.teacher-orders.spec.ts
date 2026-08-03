import { OrdersService } from './orders.service';

describe('OrdersService teacher finance projections', () => {
  function queryBuilder(result: unknown = []) {
    const query = {
      leftJoin: jest.fn(),
      select: jest.fn(),
      addSelect: jest.fn(),
      andWhere: jest.fn(),
      orderBy: jest.fn(),
      skip: jest.fn(),
      take: jest.fn(),
      getManyAndCount: jest
        .fn()
        .mockResolvedValue([result, Array.isArray(result) ? result.length : 0]),
      getOne: jest.fn().mockResolvedValue(result),
    };
    for (const method of [
      'leftJoin',
      'select',
      'addSelect',
      'andWhere',
      'orderBy',
      'skip',
      'take',
    ] as const) {
      query[method].mockReturnValue(query);
    }
    return query;
  }

  function serviceWith(query: ReturnType<typeof queryBuilder>) {
    const service = Object.create(OrdersService.prototype) as OrdersService;
    (service as unknown as { orders: { createQueryBuilder: jest.Mock } }).orders = {
      createQueryBuilder: jest.fn().mockReturnValue(query),
    };
    return service;
  }

  it('selects only the buyer id and name for a teacher-owned order list', async () => {
    const query = queryBuilder([{ id: 'order-a', student: { id: 'student-a', name: 'Buyer' } }]);
    const service = serviceWith(query);

    await service.findTeacherOrders({
      teacher_id: 'teacher-a',
      search: 'Buyer',
      page: 1,
      limit: 20,
    });

    expect(query.leftJoin).toHaveBeenCalledWith('order.student', 'student');
    expect(query.addSelect).toHaveBeenCalledWith(['student.id', 'student.name']);
    expect(query.andWhere).toHaveBeenCalledWith('order.teacher_id = :teacherId', {
      teacherId: 'teacher-a',
    });
    expect(query.andWhere).toHaveBeenCalledWith(
      expect.not.stringContaining('student.email'),
      expect.objectContaining({ search: '%Buyer%' }),
    );
  });

  it('scopes an order detail lookup to the requested teacher before returning it', async () => {
    const query = queryBuilder({ id: 'order-a' });
    const service = serviceWith(query);

    await expect(service.findTeacherOrder('order-a', 'teacher-a')).resolves.toEqual({
      id: 'order-a',
    });
    expect(query.andWhere).toHaveBeenCalledWith('order.teacher_id = :teacherId', {
      teacherId: 'teacher-a',
    });
    expect(query.andWhere).toHaveBeenCalledWith('order.id = :orderId', { orderId: 'order-a' });
  });
});
