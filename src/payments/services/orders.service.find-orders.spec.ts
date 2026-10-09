import { OrdersService } from './orders.service';

describe('OrdersService order lists (T081)', () => {
  function queryBuilder() {
    const query = {
      select: jest.fn(),
      addSelect: jest.fn(),
      leftJoin: jest.fn(),
      leftJoinAndSelect: jest.fn(),
      andWhere: jest.fn(),
      orderBy: jest.fn(),
      offset: jest.fn(),
      limit: jest.fn(),
      skip: jest.fn(),
      take: jest.fn(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    for (const method of [
      'select',
      'addSelect',
      'leftJoin',
      'leftJoinAndSelect',
      'andWhere',
      'orderBy',
      'offset',
      'limit',
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

  it('admin list selects only the consumed user columns and pages with offset/limit', async () => {
    const query = queryBuilder();
    await serviceWith(query).findOrders({ page: 3, limit: 10 });

    expect(query.leftJoin).toHaveBeenCalledWith('order.student', 'student');
    expect(query.leftJoin).toHaveBeenCalledWith('order.teacher', 'teacher');
    expect(query.addSelect).toHaveBeenCalledWith([
      'student.id',
      'student.name',
      'student.email',
      'teacher.id',
      'teacher.name',
    ]);
    expect(query.leftJoinAndSelect).not.toHaveBeenCalled();
    expect(query.offset).toHaveBeenCalledWith(20);
    expect(query.limit).toHaveBeenCalledWith(10);
    // `skip/take` is what forced the extra DISTINCT-ids statement.
    expect(query.skip).not.toHaveBeenCalled();
    expect(query.take).not.toHaveBeenCalled();
  });

  it('student list joins no user and selects no user column when not searching', async () => {
    const query = queryBuilder();
    await serviceWith(query).getStudentOrders('student-1', { page: 1, limit: 20 });

    expect(query.leftJoin).not.toHaveBeenCalled();
    expect(query.addSelect).not.toHaveBeenCalled();
    expect(query.andWhere).toHaveBeenCalledWith('order.student_id = :studentId', {
      studentId: 'student-1',
    });
  });

  it('student list joins the student (unselected) only to serve a search, scoped to the caller', async () => {
    const query = queryBuilder();
    await serviceWith(query).getStudentOrders('student-1', {
      search: ' algebra ',
      page: 1,
      limit: 20,
    });

    expect(query.leftJoin).toHaveBeenCalledWith('order.student', 'student');
    expect(query.addSelect).not.toHaveBeenCalled();
    expect(query.andWhere).toHaveBeenCalledWith('order.student_id = :studentId', {
      studentId: 'student-1',
    });
    expect(query.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('student.name ILIKE :search'),
      {
        search: '%algebra%',
      },
    );
  });

  it('the caller identity always overrides a student_id in the filter', async () => {
    const query = queryBuilder();
    await serviceWith(query).getStudentOrders('student-1', {
      student_id: 'someone-else',
      page: 1,
      limit: 20,
    } as never);

    expect(query.andWhere).toHaveBeenCalledWith('order.student_id = :studentId', {
      studentId: 'student-1',
    });
  });
});
