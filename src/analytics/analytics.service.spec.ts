import type { Repository, SelectQueryBuilder } from 'typeorm';

import {
  ApplicationCacheService,
  type ApplicationCacheDescriptor,
} from '../common/cache/application-cache.service';
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
    innerJoin: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    setParameters: jest.fn(),
    withDeleted: jest.fn(),
    getRawOne: jest.fn().mockReturnValue(result),
  };

  builder.select!.mockReturnValue(builder as SelectQueryBuilder<unknown>);
  builder.addSelect!.mockReturnValue(builder as SelectQueryBuilder<unknown>);
  builder.innerJoin!.mockReturnValue(builder as SelectQueryBuilder<unknown>);
  builder.where!.mockReturnValue(builder as SelectQueryBuilder<unknown>);
  builder.andWhere!.mockReturnValue(builder as SelectQueryBuilder<unknown>);
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
    const applicationCache = {
      getOrCompute: jest
        .fn()
        .mockImplementation(
          async (_descriptor: unknown, compute: () => Promise<unknown>) => await compute(),
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
      applicationCache as never,
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
    expect(applicationCache.getOrCompute).toHaveBeenCalledTimes(1);
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
        teacher_id: 'teacher-1',
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
    const applicationCache = {
      getOrCompute: jest
        .fn()
        .mockImplementation(
          async (_descriptor: unknown, compute: () => Promise<unknown>) => await compute(),
        ),
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
      applicationCache as never,
    );

    const result = await service.getExamAnalytics(
      { userId: 'teacher-1', email: '', name: '', role: 'teacher' },
      'exam-1',
    );

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

  it('rejects a teacher who does not own the exam before cache access', async () => {
    const applicationCache = { getOrCompute: jest.fn() };
    const service = new AnalyticsService(
      {} as Repository<never>,
      {} as Repository<never>,
      {} as Repository<never>,
      { findOne: jest.fn().mockResolvedValue({ id: 'exam-1', teacher_id: 'owner' }) } as never,
      {} as Repository<never>,
      {} as Repository<never>,
      {} as Repository<never>,
      {} as Repository<never>,
      {} as Repository<never>,
      {} as Repository<never>,
      {} as Repository<never>,
      {} as Repository<never>,
      applicationCache as never,
    );

    await expect(
      service.getExamAnalytics(
        { userId: 'other-teacher', email: '', name: '', role: 'teacher' },
        'exam-1',
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(applicationCache.getOrCompute).not.toHaveBeenCalled();
  });
});

describe('AnalyticsService.recomputeExam', () => {
  function build(exam: { id: string; teacher_id: string } | null) {
    const examsRepository = { findOne: jest.fn().mockResolvedValue(exam) };
    const applicationCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
      invalidateScopes: jest.fn().mockResolvedValue(undefined),
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
      {} as Repository<never>,
      {} as Repository<never>,
      {} as Repository<never>,
      {} as Repository<never>,
      applicationCache as never,
    );
    return { service, examsRepository, applicationCache };
  }

  it("invalidates only the exam's teacher scope of exam_analytics and teacher_quiz_analytics", async () => {
    const { service, examsRepository, applicationCache } = build({
      id: 'exam-1',
      teacher_id: 'teacher-a',
    });

    await service.recomputeExam('exam-1');

    expect(examsRepository.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'exam-1' } }),
    );
    expect(applicationCache.invalidateScopes).toHaveBeenCalledWith([
      { family: 'exam_analytics', scope: 'owner:teacher-a' },
      { family: 'teacher_quiz_analytics', scope: 'owner:teacher-a' },
    ]);
    expect(applicationCache.invalidate).not.toHaveBeenCalled();
  });

  it('falls back to the whole family when the exam cannot be resolved', async () => {
    const { service, applicationCache } = build(null);

    await service.recomputeExam('missing-exam');

    expect(applicationCache.invalidate).toHaveBeenCalledWith([
      'exam_analytics',
      'teacher_quiz_analytics',
    ]);
    expect(applicationCache.invalidateScopes).not.toHaveBeenCalled();
  });
});

describe('AnalyticsService.getTeacherDashboard (T055)', () => {
  it('starts exactly four statements together and maps the DTO (revenue from the settled-net statement)', async () => {
    const content = deferred<Array<Record<string, string>>>();
    const orders = deferred<Record<string, string>>();
    const revenue = deferred<Array<Record<string, string>>>();
    const engagement = deferred<Array<Record<string, string | null>>>();

    const orderBuilder = queryBuilder(orders.promise) as unknown as Record<string, jest.Mock>;
    orderBuilder['setParameter'] = jest.fn().mockReturnValue(orderBuilder);
    const orderRepository = { createQueryBuilder: jest.fn().mockReturnValue(orderBuilder) };
    const revenueQuery = jest.fn().mockReturnValue(revenue.promise);
    const paymentsRepository = {
      manager: { getRepository: jest.fn().mockReturnValue(orderRepository), query: revenueQuery },
    };
    const booksQuery = jest.fn().mockReturnValue(content.promise);
    const reviewsQuery = jest.fn().mockReturnValue(engagement.promise);
    const applicationCache = {
      getOrCompute: jest
        .fn()
        .mockImplementation(
          async (_descriptor: unknown, compute: () => Promise<unknown>) => await compute(),
        ),
    };

    const service = new AnalyticsService(
      {} as Repository<never>,
      {} as Repository<never>,
      { manager: { query: booksQuery } } as unknown as Repository<never>,
      {} as Repository<never>,
      {} as Repository<never>,
      {} as Repository<never>,
      paymentsRepository as unknown as Repository<never>,
      {} as Repository<never>,
      {} as Repository<never>,
      {} as Repository<never>,
      {} as Repository<never>,
      { manager: { query: reviewsQuery } } as unknown as Repository<never>,
      applicationCache as never,
    );

    const resultPromise = service.getTeacherDashboard('teacher-1');
    await Promise.resolve();

    // All four were issued before any of them resolved.
    expect(booksQuery).toHaveBeenCalledTimes(1);
    expect(orderBuilder['getRawOne']).toHaveBeenCalledTimes(1);
    expect(reviewsQuery).toHaveBeenCalledTimes(1);
    expect(revenueQuery).toHaveBeenCalledTimes(1);
    // The new revenue statement is the settled-net definition, scoped to the teacher in its WHERE.
    const revenueSql = (revenueQuery.mock.calls[0] as unknown[])[0] as string;
    expect(revenueSql).toContain("'paid','partially_refunded','refunded'");
    expect(revenueSql).toContain('(o.final_amount_minor - o.refunded_amount_minor)');
    expect(revenueSql).toContain('o.teacher_id = $1');
    expect(((revenueQuery.mock.calls[0] as unknown[])[1] as unknown[])[0]).toBe('teacher-1');
    // The student count stays on the shared paid-order helper (T014 (c): unchanged).
    expect(orderBuilder['andWhere']).toHaveBeenCalledWith('order.teacher_id = :teacherId', {
      teacherId: 'teacher-1',
    });
    // Every statement is scoped by the teacher id from the caller.
    expect((booksQuery.mock.calls[0] as unknown[])[1]).toEqual(['teacher-1']);
    expect(((reviewsQuery.mock.calls[0] as unknown[])[1] as unknown[])[0]).toBe('teacher-1');

    content.resolve([{ lessons: '3', books: '2', exams: '1' }]);
    orders.resolve({ students: '4' });
    revenue.resolve([
      { currency: 'EGP', total_minor: '15050', month_minor: '2000' },
      { currency: 'USD', total_minor: '500', month_minor: '0' },
    ]);
    engagement.resolve([{ average: '4.3333', reviews: '3', views: '9' }]);

    await expect(resultPromise).resolves.toEqual({
      totalLessons: 3,
      totalBooks: 2,
      totalExams: 1,
      totalStudents: 4,
      revenue: 150.5,
      revenueThisMonth: 20,
      revenueByCurrency: [
        { currency: 'EGP', amount: 150.5, amountThisMonth: 20 },
        { currency: 'USD', amount: 5, amountThisMonth: 0 },
      ],
      averageRating: 4.33,
      totalReviews: 3,
      engagementViews: 9,
    });
  });
});

describe('AnalyticsService.getLessonAnalyticsBatch (T056)', () => {
  const L1 = '11111111-1111-4111-8111-111111111111';
  const L2 = '22222222-2222-4222-8222-222222222222';
  const L3 = '33333333-3333-4333-8333-333333333333';

  function build(lessonRows: Array<{ id: string; teacher_id: string }>) {
    // 1st manager.query = lesson lookup; the next four = direct, packages, sessions, reviews.
    const query = jest
      .fn()
      .mockResolvedValueOnce(lessonRows)
      .mockResolvedValue([]);
    const revenueBuilder = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    const paymentsRepository = {
      manager: {
        getRepository: jest.fn().mockReturnValue({
          createQueryBuilder: jest.fn().mockReturnValue(revenueBuilder),
        }),
      },
    };
    const applicationCache = {
      getOrCompute: jest
        .fn()
        .mockImplementation(
          async (_descriptor: unknown, compute: () => Promise<unknown>) => await compute(),
        ),
    };
    const service = new AnalyticsService(
      {} as Repository<never>,
      { manager: { query }, findOne: jest.fn() } as unknown as Repository<never>,
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
      applicationCache as never,
    );
    return { service, query, applicationCache, revenueBuilder };
  }

  const teacher = (userId: string) => ({ userId, email: '', name: '', role: 'teacher' });
  const admin = { userId: 'admin-1', email: '', name: '', role: 'admin' };

  it('403 for the whole request when one id belongs to another teacher (nothing cached or read)', async () => {
    const { service, query, applicationCache } = build([
      { id: L1, teacher_id: 'teacher-1' },
      { id: L2, teacher_id: 'teacher-2' },
    ]);
    await expect(service.getLessonAnalyticsBatch(teacher('teacher-1'), [L1, L2])).rejects.toThrow(
      'do not have access',
    );
    expect(applicationCache.getOrCompute).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1); // the lookup only
  });

  it('404 when any id is missing or soft-deleted (absent from the lookup)', async () => {
    const { service, applicationCache } = build([{ id: L1, teacher_id: 'teacher-1' }]);
    await expect(service.getLessonAnalyticsBatch(teacher('teacher-1'), [L1, L2])).rejects.toThrow(
      'not found',
    );
    expect(applicationCache.getOrCompute).not.toHaveBeenCalled();
  });

  it('an admin may read lessons across owners; the cache scope is role-wide then', async () => {
    const { service, applicationCache } = build([
      { id: L1, teacher_id: 'teacher-1' },
      { id: L2, teacher_id: 'teacher-2' },
    ]);
    const result = await service.getLessonAnalyticsBatch(admin, [L2, L1]);
    expect(result.map((r) => r.lesson_id)).toEqual([L2, L1]);
    const descriptor = (applicationCache.getOrCompute.mock.calls[0] as [Record<string, unknown>])[0];
    expect(descriptor['scope']).toBe('role:admin');
  });

  it('duplicate ids: one lookup parameter per unique id, one result per requested position', async () => {
    const { service, query, revenueBuilder } = build([
      { id: L1, teacher_id: 'teacher-1' },
      { id: L3, teacher_id: 'teacher-1' },
    ]);
    const result = await service.getLessonAnalyticsBatch(teacher('teacher-1'), [L3, L1, L3]);

    expect((query.mock.calls[0] as unknown[])[1]).toEqual([[L1, L3]]);
    expect(result.map((r) => r.lesson_id)).toEqual([L3, L1, L3]);
    // Every metric family is a single statement regardless of N (4 raw + 1 builder + 1 lookup = 6).
    expect(query).toHaveBeenCalledTimes(5);
    expect(revenueBuilder.getRawMany).toHaveBeenCalledTimes(1);
    // Zero-filled ids keep the single-lesson defaults.
    expect(result[0]).toMatchObject({
      total_purchases: 0,
      total_views: 0,
      completion_rate: 0,
      average_rating: null,
      total_reviews: 0,
      revenue: 0,
      revenue_breakdown: { direct_purchases: 0, package_purchases: 0 },
    });
  });

  it('the batch cache key never equals the single-lesson key for the same id', async () => {
    const { service, applicationCache } = build([{ id: L1, teacher_id: 'teacher-1' }]);
    await service.getLessonAnalyticsBatch(teacher('teacher-1'), [L1]);
    const batch = (applicationCache.getOrCompute.mock.calls[0] as [ApplicationCacheDescriptor])[0];

    const single: ApplicationCacheDescriptor = {
      family: 'lesson_analytics',
      endpoint: 'analytics.lesson',
      scope: 'owner:teacher-1',
      parts: [L1],
      ttlMs: 30_000,
    };
    const keys = new ApplicationCacheService({} as never, {} as never);
    expect(batch.family).toBe(single.family);
    expect(batch.scope).toBe(single.scope);
    expect(keys.buildKey(batch)).not.toEqual(keys.buildKey(single));
    // Even with the endpoint equalised, the 'batch' discriminator alone separates them.
    expect(keys.buildKey({ ...batch, endpoint: single.endpoint })).not.toEqual(keys.buildKey(single));
  });
});
