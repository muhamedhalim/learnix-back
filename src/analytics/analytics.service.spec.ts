/* eslint-disable @typescript-eslint/unbound-method */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Repository } from 'typeorm';
import { Cache } from 'cache-manager';
import { AnalyticsService } from './analytics.service';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/entities/user-role.enum';
import { UserStatus } from '../users/entities/user-status.enum';
import { Payment } from '../payments/entities/payment.entity';
import { PaymentStatus } from '../payments/entities/payment-status.enum';
import { ItemType } from '../payments/entities/item-type.enum';
import { LessonPurchase } from '../payments/entities/lesson-purchase.entity';
import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonPackage } from '../packages/entities/lesson-package.entity';
import { Exam } from '../exams/entities/exam.entity';
import { ExamAttempt } from '../exams/entities/exam-attempt.entity';
import { ExamStatus } from '../exams/entities/exam-status.enum';
import { Subject } from '../subjects/entities/subject.entity';
import { DateRange } from './interfaces';

describe('AnalyticsService', () => {
  let service: AnalyticsService;
  let userRepository: jest.Mocked<Repository<User>>;
  let paymentRepository: jest.Mocked<Repository<Payment>>;
  let lessonPurchaseRepository: jest.Mocked<Repository<LessonPurchase>>;
  let lessonRepository: jest.Mocked<Repository<Lesson>>;
  let packageRepository: jest.Mocked<Repository<LessonPackage>>;
  let examRepository: jest.Mocked<Repository<Exam>>;
  let examAttemptRepository: jest.Mocked<Repository<ExamAttempt>>;
  let subjectRepository: jest.Mocked<Repository<Subject>>;
  let cacheManager: jest.Mocked<Cache>;

  const mockDateRange: DateRange = {
    startDate: new Date('2025-01-01'),
    endDate: new Date('2025-12-31'),
  };

  // Mock query builder helper
  const createMockQueryBuilder = (result: unknown) => ({
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    setParameter: jest.fn().mockReturnThis(),
    setParameters: jest.fn().mockReturnThis(),
    getRawOne: jest.fn().mockResolvedValue(result),
    getRawMany: jest.fn().mockResolvedValue(result),
    getCount: jest.fn().mockResolvedValue(result),
  });

  beforeEach(async () => {
    const mockUserRepository = {
      find: jest.fn(),
      findOne: jest.fn(),
      count: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    const mockPaymentRepository = {
      find: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    const mockLessonPurchaseRepository = {
      createQueryBuilder: jest.fn(),
    };

    const mockLessonRepository = {
      createQueryBuilder: jest.fn(),
    };

    const mockPackageRepository = {
      count: jest.fn(),
    };

    const mockExamRepository = {
      createQueryBuilder: jest.fn(),
    };

    const mockExamAttemptRepository = {
      find: jest.fn(),
      createQueryBuilder: jest.fn(),
      getCount: jest.fn(),
    };

    const mockSubjectRepository = {
      count: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    const mockCacheManager = {
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        {
          provide: getRepositoryToken(User),
          useValue: mockUserRepository,
        },
        {
          provide: getRepositoryToken(Payment),
          useValue: mockPaymentRepository,
        },
        {
          provide: getRepositoryToken(LessonPurchase),
          useValue: mockLessonPurchaseRepository,
        },
        {
          provide: getRepositoryToken(Lesson),
          useValue: mockLessonRepository,
        },
        {
          provide: getRepositoryToken(LessonPackage),
          useValue: mockPackageRepository,
        },
        {
          provide: getRepositoryToken(Exam),
          useValue: mockExamRepository,
        },
        {
          provide: getRepositoryToken(ExamAttempt),
          useValue: mockExamAttemptRepository,
        },
        {
          provide: getRepositoryToken(Subject),
          useValue: mockSubjectRepository,
        },
        {
          provide: CACHE_MANAGER,
          useValue: mockCacheManager,
        },
      ],
    }).compile();

    service = module.get<AnalyticsService>(AnalyticsService);
    userRepository = module.get(getRepositoryToken(User));
    paymentRepository = module.get(getRepositoryToken(Payment));
    lessonPurchaseRepository = module.get(getRepositoryToken(LessonPurchase));
    lessonRepository = module.get(getRepositoryToken(Lesson));
    packageRepository = module.get(getRepositoryToken(LessonPackage));
    examRepository = module.get(getRepositoryToken(Exam));
    examAttemptRepository = module.get(getRepositoryToken(ExamAttempt));
    subjectRepository = module.get(getRepositoryToken(Subject));
    cacheManager = module.get(CACHE_MANAGER);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getUserStats', () => {
    it('should return user statistics with correct aggregations', async () => {
      const mockResult = {
        total: '100',
        students: '70',
        teachers: '20',
        admins: '5',
        call_center: '5',
        pending: '10',
        approved: '85',
        rejected: '5',
        new_this_month: '15',
        new_this_week: '5',
      };

      userRepository.createQueryBuilder = jest
        .fn()
        .mockReturnValue(createMockQueryBuilder(mockResult));

      const result = await service.getUserStats(mockDateRange);

      expect(result.total).toBe(100);
      expect(result.students).toBe(70);
      expect(result.teachers).toBe(20);
      expect(result.admins).toBe(5);
      expect(result.callCenter).toBe(5);
      expect(result.pending).toBe(10);
      expect(result.approved).toBe(85);
      expect(result.rejected).toBe(5);
      expect(result.newThisMonth).toBe(15);
      expect(result.newThisWeek).toBe(5);
    });
  });

  describe('getRevenueStats', () => {
    it('should return revenue statistics with growth percentage', async () => {
      const mockResult = {
        total: '50000',
        this_month: '10000',
        last_month: '8000',
        this_week: '3000',
        average_transaction: '250',
        total_transactions: '200',
        successful_transactions: '180',
        pending_transactions: '15',
        failed_transactions: '5',
      };

      paymentRepository.createQueryBuilder = jest
        .fn()
        .mockReturnValue(createMockQueryBuilder(mockResult));

      const result = await service.getRevenueStats(mockDateRange);

      expect(result.total).toBe(50000);
      expect(result.thisMonth).toBe(10000);
      expect(result.lastMonth).toBe(8000);
      expect(result.thisWeek).toBe(3000);
      expect(result.growthPercentage).toBe(25); // (10000 - 8000) / 8000 * 100
      expect(result.averageTransaction).toBe(250);
      expect(result.totalTransactions).toBe(200);
      expect(result.successfulTransactions).toBe(180);
      expect(result.pendingTransactions).toBe(15);
      expect(result.failedTransactions).toBe(5);
    });

    it('should handle zero growth when last month revenue is zero', async () => {
      const mockResult = {
        total: '10000',
        this_month: '10000',
        last_month: '0',
        this_week: '3000',
        average_transaction: '250',
        total_transactions: '40',
        successful_transactions: '40',
        pending_transactions: '0',
        failed_transactions: '0',
      };

      paymentRepository.createQueryBuilder = jest
        .fn()
        .mockReturnValue(createMockQueryBuilder(mockResult));

      const result = await service.getRevenueStats(mockDateRange);

      expect(result.growthPercentage).toBe(0);
    });
  });

  describe('getEngagementStats', () => {
    it('should return engagement statistics', async () => {
      const examMockResult = {
        total_attempts: '500',
        completed_exams: '450',
        average_score: '75.5',
      };

      const passRateMockResult = {
        total_graded: '450',
        passed: '360',
      };

      const purchaseMockResult = {
        total_purchases: '200',
        active_access: '150',
        expired_access: '50',
      };

      examAttemptRepository.createQueryBuilder = jest
        .fn()
        .mockReturnValueOnce(createMockQueryBuilder(examMockResult))
        .mockReturnValueOnce(createMockQueryBuilder(passRateMockResult));

      lessonPurchaseRepository.createQueryBuilder = jest
        .fn()
        .mockReturnValue(createMockQueryBuilder(purchaseMockResult));

      const result = await service.getEngagementStats(mockDateRange);

      expect(result.totalExamAttempts).toBe(500);
      expect(result.completedExams).toBe(450);
      expect(result.averageExamScore).toBe(75.5);
      expect(result.passRate).toBe(80); // 360/450 * 100
      expect(result.totalLessonPurchases).toBe(200);
      expect(result.activeLessonAccess).toBe(150);
      expect(result.expiredLessonAccess).toBe(50);
    });
  });

  describe('getContentStats', () => {
    it('should return content statistics', async () => {
      const lessonMockResult = {
        total: '100',
        this_month: '10',
      };

      const examMockResult = {
        total: '50',
        this_month: '5',
      };

      lessonRepository.createQueryBuilder = jest
        .fn()
        .mockReturnValue(createMockQueryBuilder(lessonMockResult));

      packageRepository.count = jest.fn().mockResolvedValue(20);

      examRepository.createQueryBuilder = jest
        .fn()
        .mockReturnValue(createMockQueryBuilder(examMockResult));

      subjectRepository.count = jest.fn().mockResolvedValue(15);

      const result = await service.getContentStats(mockDateRange);

      expect(result.totalLessons).toBe(100);
      expect(result.totalPackages).toBe(20);
      expect(result.totalExams).toBe(50);
      expect(result.totalSubjects).toBe(15);
      expect(result.lessonsThisMonth).toBe(10);
      expect(result.examsThisMonth).toBe(5);
    });
  });

  describe('getDashboardOverview', () => {
    it('should return cached data if available', async () => {
      const cachedData = {
        users: { total: 100 },
        revenue: { total: 50000 },
        engagement: { totalExamAttempts: 500 },
        content: { totalLessons: 100 },
        period: mockDateRange,
        generatedAt: new Date(),
      };

      cacheManager.get.mockResolvedValue(cachedData);

      const result = await service.getDashboardOverview(mockDateRange);

      expect(result).toEqual(cachedData);
      expect(cacheManager.get).toHaveBeenCalled();
      expect(userRepository.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('should fetch fresh data and cache it when cache is empty', async () => {
      cacheManager.get.mockResolvedValue(null);

      // Mock all repository calls
      const userMockResult = {
        total: '100',
        students: '70',
        teachers: '20',
        admins: '5',
        call_center: '5',
        pending: '10',
        approved: '85',
        rejected: '5',
        new_this_month: '15',
        new_this_week: '5',
      };

      const revenueMockResult = {
        total: '50000',
        this_month: '10000',
        last_month: '8000',
        this_week: '3000',
        average_transaction: '250',
        total_transactions: '200',
        successful_transactions: '180',
        pending_transactions: '15',
        failed_transactions: '5',
      };

      const examMockResult = {
        total_attempts: '500',
        completed_exams: '450',
        average_score: '75.5',
      };

      const passRateMockResult = {
        total_graded: '450',
        passed: '360',
      };

      const purchaseMockResult = {
        total_purchases: '200',
        active_access: '150',
        expired_access: '50',
      };

      const lessonMockResult = {
        total: '100',
        this_month: '10',
      };

      const examContentMockResult = {
        total: '50',
        this_month: '5',
      };

      userRepository.createQueryBuilder = jest
        .fn()
        .mockReturnValue(createMockQueryBuilder(userMockResult));

      paymentRepository.createQueryBuilder = jest
        .fn()
        .mockReturnValue(createMockQueryBuilder(revenueMockResult));

      examAttemptRepository.createQueryBuilder = jest
        .fn()
        .mockReturnValueOnce(createMockQueryBuilder(examMockResult))
        .mockReturnValueOnce(createMockQueryBuilder(passRateMockResult));

      lessonPurchaseRepository.createQueryBuilder = jest
        .fn()
        .mockReturnValue(createMockQueryBuilder(purchaseMockResult));

      lessonRepository.createQueryBuilder = jest
        .fn()
        .mockReturnValue(createMockQueryBuilder(lessonMockResult));

      packageRepository.count = jest.fn().mockResolvedValue(20);

      examRepository.createQueryBuilder = jest
        .fn()
        .mockReturnValue(createMockQueryBuilder(examContentMockResult));

      subjectRepository.count = jest.fn().mockResolvedValue(15);

      const result = await service.getDashboardOverview(mockDateRange);

      expect(result.users.total).toBe(100);
      expect(result.revenue.total).toBe(50000);
      expect(result.engagement.totalExamAttempts).toBe(500);
      expect(result.content.totalLessons).toBe(100);
      expect(result.period).toEqual(mockDateRange);
      expect(result.generatedAt).toBeInstanceOf(Date);
      expect(cacheManager.set).toHaveBeenCalled();
    });
  });

  describe('getUserAnalytics', () => {
    it('should return cached data if available', async () => {
      const cachedData = {
        stats: { total: 100 },
        growthTrends: [],
        approvalRate: 90,
        registrationsByRole: [],
        period: mockDateRange,
      };

      cacheManager.get.mockResolvedValue(cachedData);

      const result = await service.getUserAnalytics(mockDateRange);

      expect(result).toEqual(cachedData);
      expect(cacheManager.get).toHaveBeenCalled();
    });

    it('should calculate approval rate correctly', async () => {
      cacheManager.get.mockResolvedValue(null);

      const userMockResult = {
        total: '100',
        students: '70',
        teachers: '20',
        admins: '5',
        call_center: '5',
        pending: '10',
        approved: '80',
        rejected: '10',
        new_this_month: '15',
        new_this_week: '5',
      };

      const growthTrendsMock: unknown[] = [];

      userRepository.createQueryBuilder = jest
        .fn()
        .mockReturnValueOnce(createMockQueryBuilder(userMockResult))
        .mockReturnValueOnce({
          ...createMockQueryBuilder(growthTrendsMock),
          getRawMany: jest.fn().mockResolvedValue(growthTrendsMock),
        });

      const result = await service.getUserAnalytics(mockDateRange);

      // Approval rate = approved / (approved + rejected) * 100 = 80/90 * 100 = 88.89
      expect(result.approvalRate).toBeCloseTo(88.89, 1);
    });
  });

  describe('getRevenueAnalytics', () => {
    it('should return revenue analytics with trends and breakdowns', async () => {
      cacheManager.get.mockResolvedValue(null);

      const revenueMockResult = {
        total: '50000',
        this_month: '10000',
        last_month: '8000',
        this_week: '3000',
        average_transaction: '250',
        total_transactions: '200',
        successful_transactions: '180',
        pending_transactions: '15',
        failed_transactions: '5',
      };

      const trendsMock = [
        { date: '2025-01-01', amount: '1000', transaction_count: '4' },
        { date: '2025-01-02', amount: '1500', transaction_count: '6' },
      ];

      const bySubjectMock: unknown[] = [];
      const topTeachersMock: unknown[] = [];

      paymentRepository.createQueryBuilder = jest
        .fn()
        .mockReturnValueOnce(createMockQueryBuilder(revenueMockResult))
        .mockReturnValueOnce({
          ...createMockQueryBuilder(trendsMock),
          getRawMany: jest.fn().mockResolvedValue(trendsMock),
        })
        .mockReturnValueOnce({
          ...createMockQueryBuilder(bySubjectMock),
          getRawMany: jest.fn().mockResolvedValue(bySubjectMock),
        })
        .mockReturnValueOnce({
          ...createMockQueryBuilder(topTeachersMock),
          getRawMany: jest.fn().mockResolvedValue(topTeachersMock),
        });

      const result = await service.getRevenueAnalytics(mockDateRange);

      expect(result.stats.total).toBe(50000);
      expect(result.trends).toHaveLength(2);
      expect(result.trends[0]?.amount).toBe(1000);
      expect(result.period).toEqual(mockDateRange);
      expect(cacheManager.set).toHaveBeenCalled();
    });
  });

  describe('getRecentActivity', () => {
    it('should return cached activity if available', async () => {
      const cachedData = {
        activities: [{ id: 1, type: 'user_registered' }],
        totalCount: 1,
      };

      cacheManager.get.mockResolvedValue(cachedData);

      const result = await service.getRecentActivity(50);

      expect(result).toEqual(cachedData);
      expect(cacheManager.get).toHaveBeenCalled();
    });

    it('should fetch and combine activities from multiple sources', async () => {
      cacheManager.get.mockResolvedValue(null);

      const mockUser: Partial<User> = {
        id: 1,
        first_name: 'Test',
        last_name: 'User',
        role: UserRole.STUDENT,
        status: UserStatus.APPROVED,
        created_at: new Date(),
      };

      const mockPayment: Partial<Payment> = {
        id: 1,
        user_id: 1,
        final_amount: 100,
        status: PaymentStatus.COMPLETED,
        item_type: ItemType.LESSON,
        created_at: new Date(),
        user: mockUser as User,
      };

      const mockExamAttempt: Partial<ExamAttempt> = {
        id: 1,
        student_id: 1,
        exam_id: 1,
        status: ExamStatus.GRADED,
        total_score: 85,
        graded_at: new Date(),
        student: mockUser as User,
        exam: { id: 1, title: 'Math Exam' } as Exam,
      };

      userRepository.find = jest.fn().mockResolvedValue([mockUser]);
      paymentRepository.find = jest.fn().mockResolvedValue([mockPayment]);
      examAttemptRepository.find = jest
        .fn()
        .mockResolvedValue([mockExamAttempt]);

      const result = await service.getRecentActivity(50);

      expect(result.activities.length).toBeGreaterThan(0);
      expect(result.totalCount).toBeGreaterThan(0);
      expect(cacheManager.set).toHaveBeenCalled();
    });

    it('should sort activities by timestamp descending', async () => {
      cacheManager.get.mockResolvedValue(null);

      const now = new Date();
      const earlier = new Date(now.getTime() - 60000);
      const earliest = new Date(now.getTime() - 120000);

      const mockUsers: Partial<User>[] = [
        {
          id: 1,
          first_name: 'First',
          last_name: 'User',
          role: UserRole.STUDENT,
          status: UserStatus.APPROVED,
          created_at: earliest,
        },
        {
          id: 2,
          first_name: 'Second',
          last_name: 'User',
          role: UserRole.TEACHER,
          status: UserStatus.PENDING,
          created_at: now,
        },
        {
          id: 3,
          first_name: 'Third',
          last_name: 'User',
          role: UserRole.STUDENT,
          status: UserStatus.APPROVED,
          created_at: earlier,
        },
      ];

      userRepository.find = jest.fn().mockResolvedValue(mockUsers);
      paymentRepository.find = jest.fn().mockResolvedValue([]);
      examAttemptRepository.find = jest.fn().mockResolvedValue([]);

      const result = await service.getRecentActivity(50);

      // Verify activities are sorted by timestamp (most recent first)
      for (let i = 0; i < result.activities.length - 1; i++) {
        const current = result.activities[i];
        const next = result.activities[i + 1];
        if (current && next) {
          expect(current.timestamp.getTime()).toBeGreaterThanOrEqual(
            next.timestamp.getTime(),
          );
        }
      }
    });
  });

  describe('invalidateCache', () => {
    it('should delete specific cache key when pattern is provided', async () => {
      await service.invalidateCache('dashboard:overview');

      expect(cacheManager.del).toHaveBeenCalledWith('dashboard:overview');
    });

    it('should delete all known dashboard cache keys when no pattern provided', async () => {
      await service.invalidateCache();

      expect(cacheManager.del).toHaveBeenCalledTimes(6);
      expect(cacheManager.del).toHaveBeenCalledWith('dashboard:overview');
      expect(cacheManager.del).toHaveBeenCalledWith('analytics:users');
      expect(cacheManager.del).toHaveBeenCalledWith('analytics:revenue');
      expect(cacheManager.del).toHaveBeenCalledWith('analytics:engagement');
      expect(cacheManager.del).toHaveBeenCalledWith('analytics:content');
      expect(cacheManager.del).toHaveBeenCalledWith('analytics:activity');
    });

    it('should handle cache deletion errors gracefully', async () => {
      cacheManager.del = jest.fn().mockRejectedValue(new Error('Cache error'));

      // Should not throw
      await expect(
        service.invalidateCache('dashboard:overview'),
      ).resolves.not.toThrow();
    });
  });
});
