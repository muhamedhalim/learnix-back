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

describe('AnalyticsService.getExamAnalytics', () => {
  it('aggregates attempt statistics, score buckets, and question results in two queries', async () => {
    const attemptBuilder = queryBuilder(
      Promise.resolve({
        total_submissions: '100000',
        in_progress_count: '12',
        pending_grading_count: '3',
        average_score: '72.50',
        highest_score: '100',
        lowest_score: '5',
        pass_rate: '81.25',
        bucket_0_20: '1000',
        bucket_21_40: '4000',
        bucket_41_60: '15000',
        bucket_61_80: '40000',
        bucket_81_100: '40000',
      }),
    );
    const questionRows = [
      {
        question_index: 0,
        question_type: 'single_choice',
        correct_answers: '75000',
        wrong_answers: '25000',
        average_score: '1.50',
        max_marks: 2,
      },
    ];

    const examsRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: 'exam-1',
        passing_marks: 50,
        total_marks: 100,
      }),
    };
    const attemptsRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(attemptBuilder),
      count: jest.fn(),
      find: jest.fn(),
    };
    const examQuestionsRepository = {
      query: jest.fn().mockResolvedValue(questionRows),
      find: jest.fn(),
    };
    const cache = {
      get: jest.fn().mockResolvedValue(undefined),
      set: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AnalyticsService(
      {} as Repository<never>,
      {} as Repository<never>,
      {} as Repository<never>,
      examsRepository as unknown as Repository<never>,
      {} as Repository<never>,
      {} as Repository<never>,
      {} as Repository<never>,
      {} as Repository<never>,
      attemptsRepository as unknown as Repository<never>,
      examQuestionsRepository as unknown as Repository<never>,
      {} as Repository<never>,
      {} as Repository<never>,
      cache as unknown as Cache,
      {} as never,
    );

    const result = await service.getExamAnalytics('exam-1');

    expect(attemptBuilder.getRawOne).toHaveBeenCalledTimes(1);
    expect(examQuestionsRepository.query).toHaveBeenCalledTimes(1);
    expect(attemptsRepository.count).not.toHaveBeenCalled();
    expect(attemptsRepository.find).not.toHaveBeenCalled();
    expect(examQuestionsRepository.find).not.toHaveBeenCalled();

    const attemptSelects = attemptBuilder.addSelect?.mock.calls.map(
      ([expression]) => expression as string,
    );
    expect(attemptSelects?.some((expression) => expression.includes('COUNT(*) FILTER'))).toBe(true);
    const attemptAliases = attemptBuilder.addSelect?.mock.calls.map(([, alias]) => alias as string);
    expect(attemptAliases).toEqual(
      expect.arrayContaining(['bucket_0_20', 'bucket_81_100', 'pass_rate']),
    );
    const questionSql = examQuestionsRepository.query.mock.calls[0]?.[0] as string;
    expect(questionSql).toContain('WITH answer_stats AS');
    expect(questionSql).toContain('GROUP BY answer.exam_question_id');
    expect(result).toMatchObject({
      total_submissions: 100000,
      in_progress_count: 12,
      pending_grading_count: 3,
      average_score: 72.5,
      highest_score: 100,
      lowest_score: 5,
      pass_rate: 81.25,
      question_analysis: [
        {
          question_index: 0,
          correct_answers: 75000,
          wrong_answers: 25000,
          average_score: 1.5,
        },
      ],
      score_distribution: {
        '0-20': 1000,
        '21-40': 4000,
        '41-60': 15000,
        '61-80': 40000,
        '81-100': 40000,
      },
    });
  });
});
