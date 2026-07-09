import type { Cache } from 'cache-manager';
import type { Repository, SelectQueryBuilder } from 'typeorm';

import { AnalyticsService } from './analytics.service';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function queryBuilder<T>(result: Promise<T>): jest.Mocked<Partial<SelectQueryBuilder<unknown>>> {
  const builder: jest.Mocked<Partial<SelectQueryBuilder<unknown>>> = {
    select: jest.fn(),
    addSelect: jest.fn(),
    where: jest.fn(),
    setParameters: jest.fn(),
    withDeleted: jest.fn(),
    getRawOne: jest.fn().mockReturnValue(result),
  };

  builder.select!.mockReturnValue(builder as SelectQueryBuilder<unknown>);
  builder.addSelect!.mockReturnValue(builder as SelectQueryBuilder<unknown>);
  builder.where!.mockReturnValue(builder as SelectQueryBuilder<unknown>);
  builder.setParameters!.mockReturnValue(builder as SelectQueryBuilder<unknown>);
  builder.withDeleted!.mockReturnValue(builder as SelectQueryBuilder<unknown>);
  return builder;
}

describe('AnalyticsService.getAdminDashboard', () => {
  it('runs exactly three aggregate queries in parallel', async () => {
    const users = deferred<Record<string, string>>();
    const content = deferred<Record<string, string>>();
    const revenue = deferred<Record<string, string>>();
    const usersBuilder = queryBuilder(users.promise);
    const contentBuilder = queryBuilder(content.promise);
    const revenueBuilder = queryBuilder(revenue.promise);

    const usersRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(usersBuilder),
    };
    const lessonsRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(contentBuilder),
    };
    const paymentsRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(revenueBuilder),
    };
    const cache = {
      get: jest.fn().mockResolvedValue(undefined),
      set: jest.fn().mockResolvedValue(undefined),
    };
    const singleFlight = {
      getOrCompute: jest
        .fn()
        .mockImplementation(
          async (_key: string, _ttl: number, compute: () => Promise<unknown>) => await compute(),
        ),
    };

    const service = new AnalyticsService(
      usersRepository as unknown as Repository<never>,
      lessonsRepository as unknown as Repository<never>,
      {} as Repository<never>,
      {} as Repository<never>,
      {} as Repository<never>,
      {} as Repository<never>,
      paymentsRepository as unknown as Repository<never>,
      {} as Repository<never>,
      {} as Repository<never>,
      {} as Repository<never>,
      {} as Repository<never>,
      {} as Repository<never>,
      {} as Repository<never>,
      cache as unknown as Cache,
      singleFlight as never,
    );

    const resultPromise = service.getAdminDashboard();
    await Promise.resolve();

    expect(usersBuilder.getRawOne).toHaveBeenCalledTimes(1);
    expect(contentBuilder.getRawOne).toHaveBeenCalledTimes(1);
    expect(revenueBuilder.getRawOne).toHaveBeenCalledTimes(1);

    users.resolve({
      total_students: '10',
      pending_students: '2',
      approved_students: '8',
      total_teachers: '4',
      pending_teachers: '1',
      approved_teachers: '3',
    });
    content.resolve({
      total_lessons: '20',
      total_books: '5',
      total_exams: '7',
    });
    revenue.resolve({
      total_revenue: '1000.50',
      revenue_today: '25.25',
      revenue_this_month: '400.00',
      revenue_last_month: '300.00',
      revenue_this_quarter: '700.00',
      lesson_revenue: '600.00',
      package_revenue: '250.00',
      book_revenue: '150.50',
    });

    await expect(resultPromise).resolves.toEqual({
      totalStudents: 10,
      pendingStudents: 2,
      approvedStudents: 8,
      totalTeachers: 4,
      pendingTeachers: 1,
      approvedTeachers: 3,
      totalLessons: 20,
      totalBooks: 5,
      totalExams: 7,
      totalRevenue: 1000.5,
      revenueToday: 25.25,
      revenueThisMonth: 400,
      revenueLastMonth: 300,
      revenueThisQuarter: 700,
      revenueBySource: {
        lessons: 600,
        packages: 250,
        books: 150.5,
      },
    });
    expect(singleFlight.getOrCompute).toHaveBeenCalledTimes(1);
  });
});
