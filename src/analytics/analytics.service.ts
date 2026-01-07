/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unused-vars */
// TypeORM getRawMany/getRawOne returns untyped results - we use type assertions
// Some dateRange parameters are kept for API consistency but not used in current implementation
import { Injectable, Inject, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';

import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/entities/user-role.enum';
import { UserStatus } from '../users/entities/user-status.enum';
import { Payment } from '../payments/entities/payment.entity';
import { PaymentStatus } from '../payments/entities/payment-status.enum';
import { LessonPurchase } from '../payments/entities/lesson-purchase.entity';
import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonPackage } from '../packages/entities/lesson-package.entity';
import { Exam } from '../exams/entities/exam.entity';
import { ExamAttempt } from '../exams/entities/exam-attempt.entity';
import { ExamStatus } from '../exams/entities/exam-status.enum';
import { Subject } from '../subjects/entities/subject.entity';

import {
  DashboardOverview,
  UserStats,
  RevenueStats,
  EngagementStats,
  ContentStats,
  UserAnalytics,
  RevenueAnalytics,
  EngagementAnalytics,
  ContentAnalytics,
  RecentActivity,
  ActivityItem,
  DateRange,
  UserGrowthTrend,
  RevenueTrend,
  RevenueBySubject,
  RevenueByTeacher,
} from './interfaces';

// Raw query result type interfaces for TypeORM getRawMany/getRawOne
interface UserStatsRaw {
  total: string;
  students: string;
  teachers: string;
  admins: string;
  call_center: string;
  pending: string;
  approved: string;
  rejected: string;
  new_this_month: string;
  new_this_week: string;
}

interface RevenueStatsRaw {
  total: string;
  this_month: string;
  last_month: string;
  this_week: string;
  average_transaction: string;
  total_transactions: string;
  successful_transactions: string;
  pending_transactions: string;
  failed_transactions: string;
}

interface ExamStatsRaw {
  total_attempts: string;
  completed_exams: string;
  average_score: string;
}

interface PassRateRaw {
  total_graded: string;
  passed: string;
}

interface PurchaseStatsRaw {
  total_purchases: string;
  active_access: string;
  expired_access: string;
}

interface ContentStatsRaw {
  total: string;
  this_month: string;
}

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  // Cache TTL constants (in milliseconds)
  private readonly CACHE_TTL_DASHBOARD = 15 * 60 * 1000; // 15 minutes
  private readonly CACHE_TTL_ANALYTICS = 5 * 60 * 1000; // 5 minutes
  private readonly CACHE_TTL_ACTIVITY = 1 * 60 * 1000; // 1 minute

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Payment)
    private readonly paymentRepository: Repository<Payment>,
    @InjectRepository(LessonPurchase)
    private readonly lessonPurchaseRepository: Repository<LessonPurchase>,
    @InjectRepository(Lesson)
    private readonly lessonRepository: Repository<Lesson>,
    @InjectRepository(LessonPackage)
    private readonly packageRepository: Repository<LessonPackage>,
    @InjectRepository(Exam)
    private readonly examRepository: Repository<Exam>,
    @InjectRepository(ExamAttempt)
    private readonly examAttemptRepository: Repository<ExamAttempt>,
    @InjectRepository(Subject)
    private readonly subjectRepository: Repository<Subject>,
    @Inject(CACHE_MANAGER)
    private readonly cacheManager: Cache,
  ) {}

  /**
   * Get comprehensive dashboard overview
   */
  async getDashboardOverview(dateRange: DateRange): Promise<DashboardOverview> {
    const cacheKey = `dashboard:overview:${dateRange.startDate.toISOString()}:${dateRange.endDate.toISOString()}`;

    const cached = await this.cacheManager.get<DashboardOverview>(cacheKey);
    if (cached) {
      this.logger.debug('Dashboard overview served from cache');
      return cached;
    }

    const [users, revenue, engagement, content] = await Promise.all([
      this.getUserStats(dateRange),
      this.getRevenueStats(dateRange),
      this.getEngagementStats(dateRange),
      this.getContentStats(dateRange),
    ]);

    const overview: DashboardOverview = {
      users,
      revenue,
      engagement,
      content,
      period: dateRange,
      generatedAt: new Date(),
    };

    await this.cacheManager.set(cacheKey, overview, this.CACHE_TTL_DASHBOARD);
    return overview;
  }

  /**
   * Get user statistics with efficient single-query aggregation
   */
  async getUserStats(_dateRange: DateRange): Promise<UserStats> {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfWeek = new Date(now.setDate(now.getDate() - now.getDay()));

    const result = (await this.userRepository
      .createQueryBuilder('user')
      .select([
        'COUNT(*) as total',
        `COUNT(*) FILTER (WHERE user.role = '${UserRole.STUDENT}') as students`,
        `COUNT(*) FILTER (WHERE user.role = '${UserRole.TEACHER}') as teachers`,
        `COUNT(*) FILTER (WHERE user.role = '${UserRole.ADMIN}') as admins`,
        `COUNT(*) FILTER (WHERE user.role = '${UserRole.CALL_CENTER}') as call_center`,
        `COUNT(*) FILTER (WHERE user.status = '${UserStatus.PENDING}') as pending`,
        `COUNT(*) FILTER (WHERE user.status = '${UserStatus.APPROVED}') as approved`,
        `COUNT(*) FILTER (WHERE user.status = '${UserStatus.REJECTED}') as rejected`,
        `COUNT(*) FILTER (WHERE user.created_at >= :startOfMonth) as new_this_month`,
        `COUNT(*) FILTER (WHERE user.created_at >= :startOfWeek) as new_this_week`,
      ])
      .where('user.deleted_at IS NULL')
      .setParameters({ startOfMonth, startOfWeek })
      .getRawOne()) as UserStatsRaw;

    return {
      total: parseInt(result.total, 10),
      students: parseInt(result.students, 10),
      teachers: parseInt(result.teachers, 10),
      admins: parseInt(result.admins, 10),
      callCenter: parseInt(result.call_center, 10),
      pending: parseInt(result.pending, 10),
      approved: parseInt(result.approved, 10),
      rejected: parseInt(result.rejected, 10),
      newThisMonth: parseInt(result.new_this_month, 10),
      newThisWeek: parseInt(result.new_this_week, 10),
    };
  }

  /**
   * Get revenue statistics
   */
  async getRevenueStats(_dateRange: DateRange): Promise<RevenueStats> {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());

    const result = (await this.paymentRepository
      .createQueryBuilder('payment')
      .select([
        `COALESCE(SUM(payment.final_amount) FILTER (WHERE payment.status = '${PaymentStatus.COMPLETED}'), 0) as total`,
        `COALESCE(SUM(payment.final_amount) FILTER (WHERE payment.status = '${PaymentStatus.COMPLETED}' AND payment.created_at >= :startOfMonth), 0) as this_month`,
        `COALESCE(SUM(payment.final_amount) FILTER (WHERE payment.status = '${PaymentStatus.COMPLETED}' AND payment.created_at >= :startOfLastMonth AND payment.created_at <= :endOfLastMonth), 0) as last_month`,
        `COALESCE(SUM(payment.final_amount) FILTER (WHERE payment.status = '${PaymentStatus.COMPLETED}' AND payment.created_at >= :startOfWeek), 0) as this_week`,
        `COALESCE(AVG(payment.final_amount) FILTER (WHERE payment.status = '${PaymentStatus.COMPLETED}'), 0) as average_transaction`,
        `COUNT(*) as total_transactions`,
        `COUNT(*) FILTER (WHERE payment.status = '${PaymentStatus.COMPLETED}') as successful_transactions`,
        `COUNT(*) FILTER (WHERE payment.status = '${PaymentStatus.PENDING}' OR payment.status = '${PaymentStatus.PROCESSING}') as pending_transactions`,
        `COUNT(*) FILTER (WHERE payment.status = '${PaymentStatus.FAILED}') as failed_transactions`,
      ])
      .setParameters({
        startOfMonth,
        startOfLastMonth,
        endOfLastMonth,
        startOfWeek,
      })
      .getRawOne()) as RevenueStatsRaw;

    const thisMonth = parseFloat(result.this_month) || 0;
    const lastMonth = parseFloat(result.last_month) || 0;
    const growthPercentage =
      lastMonth > 0 ? ((thisMonth - lastMonth) / lastMonth) * 100 : 0;

    return {
      total: parseFloat(result.total) || 0,
      thisMonth,
      lastMonth,
      thisWeek: parseFloat(result.this_week) || 0,
      growthPercentage: Math.round(growthPercentage * 100) / 100,
      averageTransaction: parseFloat(result.average_transaction) || 0,
      totalTransactions: parseInt(result.total_transactions, 10),
      successfulTransactions: parseInt(result.successful_transactions, 10),
      pendingTransactions: parseInt(result.pending_transactions, 10),
      failedTransactions: parseInt(result.failed_transactions, 10),
    };
  }

  /**
   * Get engagement statistics
   */
  async getEngagementStats(_dateRange: DateRange): Promise<EngagementStats> {
    const now = new Date();

    const examResult = (await this.examAttemptRepository
      .createQueryBuilder('attempt')
      .select([
        'COUNT(*) as total_attempts',
        `COUNT(*) FILTER (WHERE attempt.status = '${ExamStatus.GRADED}') as completed_exams`,
        `COALESCE(AVG(attempt.total_score) FILTER (WHERE attempt.status = '${ExamStatus.GRADED}'), 0) as average_score`,
      ])
      .getRawOne()) as ExamStatsRaw;

    // Calculate pass rate
    const passRateResult = (await this.examAttemptRepository
      .createQueryBuilder('attempt')
      .innerJoin('attempt.exam', 'exam')
      .select([
        'COUNT(*) as total_graded',
        `COUNT(*) FILTER (WHERE attempt.total_score >= exam.passing_marks) as passed`,
      ])
      .where(`attempt.status = '${ExamStatus.GRADED}'`)
      .getRawOne()) as PassRateRaw;

    const totalGraded = parseInt(passRateResult.total_graded, 10) || 0;
    const passed = parseInt(passRateResult.passed, 10) || 0;
    const passRate = totalGraded > 0 ? (passed / totalGraded) * 100 : 0;

    const purchaseResult = (await this.lessonPurchaseRepository
      .createQueryBuilder('purchase')
      .select([
        'COUNT(*) as total_purchases',
        `COUNT(*) FILTER (WHERE purchase.access_expires_at > :now) as active_access`,
        `COUNT(*) FILTER (WHERE purchase.access_expires_at <= :now) as expired_access`,
      ])
      .setParameter('now', now)
      .getRawOne()) as PurchaseStatsRaw;

    return {
      totalExamAttempts: parseInt(examResult.total_attempts, 10),
      completedExams: parseInt(examResult.completed_exams, 10),
      averageExamScore: parseFloat(examResult.average_score) || 0,
      passRate: Math.round(passRate * 100) / 100,
      totalLessonPurchases: parseInt(purchaseResult.total_purchases, 10),
      activeLessonAccess: parseInt(purchaseResult.active_access, 10),
      expiredLessonAccess: parseInt(purchaseResult.expired_access, 10),
    };
  }

  /**
   * Get content statistics
   */
  async getContentStats(_dateRange: DateRange): Promise<ContentStats> {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const [lessons, packages, exams, subjects] = await Promise.all([
      this.lessonRepository
        .createQueryBuilder('lesson')
        .select([
          'COUNT(*) as total',
          `COUNT(*) FILTER (WHERE lesson.created_at >= :startOfMonth) as this_month`,
        ])
        .where('lesson.deleted_at IS NULL')
        .setParameter('startOfMonth', startOfMonth)
        .getRawOne() as Promise<ContentStatsRaw>,
      this.packageRepository.count({ where: { deleted_at: IsNull() } }),
      this.examRepository
        .createQueryBuilder('exam')
        .select([
          'COUNT(*) as total',
          `COUNT(*) FILTER (WHERE exam.created_at >= :startOfMonth) as this_month`,
        ])
        .where('exam.deleted_at IS NULL')
        .setParameter('startOfMonth', startOfMonth)
        .getRawOne() as Promise<ContentStatsRaw>,
      this.subjectRepository.count({ where: { deleted_at: IsNull() } }),
    ]);

    return {
      totalLessons: parseInt(lessons.total, 10),
      totalPackages: packages,
      totalExams: parseInt(exams.total, 10),
      totalSubjects: subjects,
      lessonsThisMonth: parseInt(lessons.this_month, 10),
      examsThisMonth: parseInt(exams.this_month, 10),
    };
  }

  /**
   * Get detailed user analytics with trends
   */
  async getUserAnalytics(dateRange: DateRange): Promise<UserAnalytics> {
    const cacheKey = `analytics:users:${dateRange.startDate.toISOString()}:${dateRange.endDate.toISOString()}`;

    const cached = await this.cacheManager.get<UserAnalytics>(cacheKey);
    if (cached) {
      return cached;
    }

    const stats = await this.getUserStats(dateRange);

    // Get growth trends (daily registrations)
    const growthTrends = await this.userRepository
      .createQueryBuilder('user')
      .select([
        'DATE(user.created_at) as date',
        `COUNT(*) FILTER (WHERE user.role = '${UserRole.STUDENT}') as students`,
        `COUNT(*) FILTER (WHERE user.role = '${UserRole.TEACHER}') as teachers`,
        'COUNT(*) as total',
      ])
      .where('user.created_at BETWEEN :startDate AND :endDate', dateRange)
      .andWhere('user.deleted_at IS NULL')
      .groupBy('DATE(user.created_at)')
      .orderBy('date', 'ASC')
      .getRawMany();

    const trends: UserGrowthTrend[] = growthTrends.map((t) => ({
      date: t.date,
      students: parseInt(t.students, 10),
      teachers: parseInt(t.teachers, 10),
      total: parseInt(t.total, 10),
    }));

    // Calculate approval rate
    const total = stats.approved + stats.rejected;
    const approvalRate = total > 0 ? (stats.approved / total) * 100 : 0;

    // Registrations by role
    const totalUsers =
      stats.students + stats.teachers + stats.admins + stats.callCenter;
    const registrationsByRole = [
      {
        role: 'Student',
        count: stats.students,
        percentage: totalUsers > 0 ? (stats.students / totalUsers) * 100 : 0,
      },
      {
        role: 'Teacher',
        count: stats.teachers,
        percentage: totalUsers > 0 ? (stats.teachers / totalUsers) * 100 : 0,
      },
      {
        role: 'Admin',
        count: stats.admins,
        percentage: totalUsers > 0 ? (stats.admins / totalUsers) * 100 : 0,
      },
      {
        role: 'Call Center',
        count: stats.callCenter,
        percentage: totalUsers > 0 ? (stats.callCenter / totalUsers) * 100 : 0,
      },
    ];

    const analytics: UserAnalytics = {
      stats,
      growthTrends: trends,
      approvalRate: Math.round(approvalRate * 100) / 100,
      registrationsByRole,
      period: dateRange,
    };

    await this.cacheManager.set(cacheKey, analytics, this.CACHE_TTL_ANALYTICS);
    return analytics;
  }

  /**
   * Get detailed revenue analytics
   */
  async getRevenueAnalytics(dateRange: DateRange): Promise<RevenueAnalytics> {
    const cacheKey = `analytics:revenue:${dateRange.startDate.toISOString()}:${dateRange.endDate.toISOString()}`;

    const cached = await this.cacheManager.get<RevenueAnalytics>(cacheKey);
    if (cached) {
      return cached;
    }

    const stats = await this.getRevenueStats(dateRange);

    // Revenue trends (daily)
    const trendsResult = await this.paymentRepository
      .createQueryBuilder('payment')
      .select([
        'DATE(payment.created_at) as date',
        'COALESCE(SUM(payment.final_amount), 0) as amount',
        'COUNT(*) as transaction_count',
      ])
      .where('payment.created_at BETWEEN :startDate AND :endDate', dateRange)
      .andWhere(`payment.status = '${PaymentStatus.COMPLETED}'`)
      .groupBy('DATE(payment.created_at)')
      .orderBy('date', 'ASC')
      .getRawMany();

    const trends: RevenueTrend[] = trendsResult.map((t) => ({
      date: t.date,
      amount: parseFloat(t.amount) || 0,
      transactionCount: parseInt(t.transaction_count, 10),
    }));

    // Revenue by subject (via lessons)
    const bySubjectResult = await this.paymentRepository
      .createQueryBuilder('payment')
      .innerJoin(LessonPurchase, 'lp', 'lp.payment_id = payment.id')
      .innerJoin(Lesson, 'lesson', 'lesson.id = lp.lesson_id')
      .innerJoin(Subject, 'subject', 'subject.id = lesson.subject_id')
      .select([
        'subject.id as subject_id',
        'subject.title as subject_name',
        'COALESCE(SUM(payment.final_amount), 0) as revenue',
        'COUNT(*) as transaction_count',
      ])
      .where('payment.created_at BETWEEN :startDate AND :endDate', dateRange)
      .andWhere(`payment.status = '${PaymentStatus.COMPLETED}'`)
      .groupBy('subject.id, subject.title')
      .orderBy('revenue', 'DESC')
      .limit(10)
      .getRawMany();

    const totalRevenue = stats.total || 1;
    const bySubject: RevenueBySubject[] = bySubjectResult.map((s) => ({
      subjectId: s.subject_id,
      subjectName: s.subject_name,
      revenue: parseFloat(s.revenue) || 0,
      transactionCount: parseInt(s.transaction_count, 10),
      percentage: (parseFloat(s.revenue) / totalRevenue) * 100,
    }));

    // Top teachers by revenue
    const topTeachersResult = await this.paymentRepository
      .createQueryBuilder('payment')
      .innerJoin(LessonPurchase, 'lp', 'lp.payment_id = payment.id')
      .innerJoin(Lesson, 'lesson', 'lesson.id = lp.lesson_id')
      .innerJoin(User, 'teacher', 'teacher.id = lesson.teacher_id')
      .select([
        'teacher.id as teacher_id',
        "CONCAT(teacher.first_name, ' ', teacher.last_name) as teacher_name",
        'COALESCE(SUM(payment.final_amount), 0) as revenue',
        'COUNT(*) as lessons_sold',
      ])
      .where('payment.created_at BETWEEN :startDate AND :endDate', dateRange)
      .andWhere(`payment.status = '${PaymentStatus.COMPLETED}'`)
      .groupBy('teacher.id, teacher.first_name, teacher.last_name')
      .orderBy('revenue', 'DESC')
      .limit(10)
      .getRawMany();

    const topTeachers: RevenueByTeacher[] = topTeachersResult.map((t) => ({
      teacherId: t.teacher_id,
      teacherName: t.teacher_name || 'Unknown',
      revenue: parseFloat(t.revenue) || 0,
      lessonsSold: parseInt(t.lessons_sold, 10),
      packagesSold: 0, // Would require separate query
    }));

    const analytics: RevenueAnalytics = {
      stats,
      trends,
      bySubject,
      topTeachers,
      period: dateRange,
    };

    await this.cacheManager.set(cacheKey, analytics, this.CACHE_TTL_ANALYTICS);
    return analytics;
  }

  /**
   * Get engagement analytics
   */
  async getEngagementAnalytics(
    dateRange: DateRange,
  ): Promise<EngagementAnalytics> {
    const cacheKey = `analytics:engagement:${dateRange.startDate.toISOString()}:${dateRange.endDate.toISOString()}`;

    const cached = await this.cacheManager.get<EngagementAnalytics>(cacheKey);
    if (cached) {
      return cached;
    }

    const stats = await this.getEngagementStats(dateRange);

    // Top exams by attempts
    const topExamsResult = await this.examAttemptRepository
      .createQueryBuilder('attempt')
      .innerJoin('attempt.exam', 'exam')
      .select([
        'exam.id as exam_id',
        'exam.title as exam_title',
        'COUNT(*) as attempts',
        'COALESCE(AVG(attempt.total_score), 0) as average_score',
      ])
      .where('attempt.created_at BETWEEN :startDate AND :endDate', dateRange)
      .groupBy('exam.id, exam.title')
      .orderBy('attempts', 'DESC')
      .limit(10)
      .getRawMany();

    // Calculate pass rate for each exam
    const topExams = await Promise.all(
      topExamsResult.map(async (e) => {
        const passRateResult = await this.examAttemptRepository
          .createQueryBuilder('attempt')
          .innerJoin('attempt.exam', 'exam')
          .where('exam.id = :examId', { examId: e.exam_id })
          .andWhere(`attempt.status = '${ExamStatus.GRADED}'`)
          .andWhere('attempt.total_score >= exam.passing_marks')
          .getCount();

        const totalGraded = await this.examAttemptRepository
          .createQueryBuilder('attempt')
          .where('attempt.exam_id = :examId', { examId: e.exam_id })
          .andWhere(`attempt.status = '${ExamStatus.GRADED}'`)
          .getCount();

        return {
          examId: e.exam_id,
          examTitle: e.exam_title,
          attempts: parseInt(e.attempts, 10),
          averageScore: parseFloat(e.average_score) || 0,
          passRate: totalGraded > 0 ? (passRateResult / totalGraded) * 100 : 0,
        };
      }),
    );

    // Top lessons by purchases
    const topLessonsResult = await this.lessonPurchaseRepository
      .createQueryBuilder('purchase')
      .innerJoin('purchase.lesson', 'lesson')
      .innerJoin('lesson.teacher', 'teacher')
      .select([
        'lesson.id as lesson_id',
        'lesson.title as lesson_title',
        "CONCAT(teacher.first_name, ' ', teacher.last_name) as teacher_name",
        'COUNT(*) as purchases',
        `COUNT(*) FILTER (WHERE purchase.access_expires_at > NOW()) as active_access`,
      ])
      .where('purchase.created_at BETWEEN :startDate AND :endDate', dateRange)
      .groupBy('lesson.id, lesson.title, teacher.first_name, teacher.last_name')
      .orderBy('purchases', 'DESC')
      .limit(10)
      .getRawMany();

    const topLessons = topLessonsResult.map((l) => ({
      lessonId: l.lesson_id,
      lessonTitle: l.lesson_title,
      teacherName: l.teacher_name || 'Unknown',
      purchases: parseInt(l.purchases, 10),
      activeAccess: parseInt(l.active_access, 10),
    }));

    // Exam completion trend
    const completionTrendResult = await this.examAttemptRepository
      .createQueryBuilder('attempt')
      .select(['DATE(attempt.submitted_at) as date', 'COUNT(*) as completed'])
      .where('attempt.submitted_at BETWEEN :startDate AND :endDate', dateRange)
      .andWhere('attempt.submitted_at IS NOT NULL')
      .groupBy('DATE(attempt.submitted_at)')
      .orderBy('date', 'ASC')
      .getRawMany();

    const examCompletionTrend = completionTrendResult.map((t) => ({
      date: t.date,
      completed: parseInt(t.completed, 10),
    }));

    const analytics: EngagementAnalytics = {
      stats,
      topExams,
      topLessons,
      examCompletionTrend,
      period: dateRange,
    };

    await this.cacheManager.set(cacheKey, analytics, this.CACHE_TTL_ANALYTICS);
    return analytics;
  }

  /**
   * Get content analytics
   */
  async getContentAnalytics(dateRange: DateRange): Promise<ContentAnalytics> {
    const cacheKey = `analytics:content:${dateRange.startDate.toISOString()}:${dateRange.endDate.toISOString()}`;

    const cached = await this.cacheManager.get<ContentAnalytics>(cacheKey);
    if (cached) {
      return cached;
    }

    const stats = await this.getContentStats(dateRange);

    // Popular lessons
    const popularLessonsResult = await this.lessonRepository
      .createQueryBuilder('lesson')
      .innerJoin('lesson.teacher', 'teacher')
      .innerJoin('lesson.subject', 'subject')
      .leftJoin('lesson.purchases', 'purchase')
      .select([
        'lesson.id as id',
        'lesson.title as title',
        "CONCAT(teacher.first_name, ' ', teacher.last_name) as teacher_name",
        'subject.title as subject_name',
        'lesson.students_count as students_count',
        'COALESCE(SUM(purchase.price_paid), 0) as revenue',
      ])
      .where('lesson.deleted_at IS NULL')
      .groupBy(
        'lesson.id, lesson.title, teacher.first_name, teacher.last_name, subject.title, lesson.students_count',
      )
      .orderBy('lesson.students_count', 'DESC')
      .limit(10)
      .getRawMany();

    const popularLessons = popularLessonsResult.map((l) => ({
      id: l.id,
      title: l.title,
      teacherName: l.teacher_name || 'Unknown',
      subjectName: l.subject_name,
      studentsCount: parseInt(l.students_count, 10),
      revenue: parseFloat(l.revenue) || 0,
      rating: 0, // Would need rating table
    }));

    // Popular subjects
    const popularSubjectsResult = await this.subjectRepository
      .createQueryBuilder('subject')
      .leftJoin(
        Lesson,
        'lesson',
        'lesson.subject_id = subject.id AND lesson.deleted_at IS NULL',
      )
      .leftJoin(LessonPurchase, 'purchase', 'purchase.lesson_id = lesson.id')
      .select([
        'subject.id as id',
        'subject.title as name',
        'COUNT(DISTINCT lesson.id) as lessons_count',
        'COALESCE(SUM(lesson.students_count), 0) as students_count',
        'COALESCE(SUM(purchase.price_paid), 0) as revenue',
      ])
      .where('subject.deleted_at IS NULL')
      .groupBy('subject.id, subject.title')
      .orderBy('students_count', 'DESC')
      .limit(10)
      .getRawMany();

    const popularSubjects = popularSubjectsResult.map((s) => ({
      id: s.id,
      name: s.name,
      lessonsCount: parseInt(s.lessons_count, 10),
      studentsCount: parseInt(s.students_count, 10),
      revenue: parseFloat(s.revenue) || 0,
    }));

    // Content creation trend
    const trendResult = await this.lessonRepository
      .createQueryBuilder('lesson')
      .select('DATE(lesson.created_at) as date')
      .addSelect('COUNT(*) as lessons')
      .where('lesson.created_at BETWEEN :startDate AND :endDate', dateRange)
      .andWhere('lesson.deleted_at IS NULL')
      .groupBy('DATE(lesson.created_at)')
      .orderBy('date', 'ASC')
      .getRawMany();

    const examTrendResult = await this.examRepository
      .createQueryBuilder('exam')
      .select('DATE(exam.created_at) as date')
      .addSelect('COUNT(*) as exams')
      .where('exam.created_at BETWEEN :startDate AND :endDate', dateRange)
      .andWhere('exam.deleted_at IS NULL')
      .groupBy('DATE(exam.created_at)')
      .orderBy('date', 'ASC')
      .getRawMany();

    // Merge trends
    const trendMap = new Map<string, { lessons: number; exams: number }>();
    trendResult.forEach((t) => {
      trendMap.set(t.date, { lessons: parseInt(t.lessons, 10), exams: 0 });
    });
    examTrendResult.forEach((t) => {
      const existing = trendMap.get(t.date) || { lessons: 0, exams: 0 };
      trendMap.set(t.date, { ...existing, exams: parseInt(t.exams, 10) });
    });

    const contentCreationTrend = Array.from(trendMap.entries())
      .map(([date, data]) => ({ date, ...data }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const analytics: ContentAnalytics = {
      stats,
      popularLessons,
      popularSubjects,
      contentCreationTrend,
      period: dateRange,
    };

    await this.cacheManager.set(cacheKey, analytics, this.CACHE_TTL_ANALYTICS);
    return analytics;
  }

  /**
   * Get recent platform activity
   */
  async getRecentActivity(limit: number = 50): Promise<RecentActivity> {
    const cacheKey = `analytics:activity:${limit}`;

    const cached = await this.cacheManager.get<RecentActivity>(cacheKey);
    if (cached) {
      return cached;
    }

    const activities: ActivityItem[] = [];

    // Recent user registrations
    const recentUsers = await this.userRepository.find({
      where: { deleted_at: IsNull() },
      order: { created_at: 'DESC' },
      take: 10,
    });

    recentUsers.forEach((user) => {
      activities.push({
        id: user.id,
        type: 'user_registered',
        description: `New ${user.role} registered: ${user.first_name} ${user.last_name}`,
        userId: user.id,
        userName: `${user.first_name} ${user.last_name}`,
        metadata: { role: user.role, status: user.status },
        timestamp: user.created_at,
      });
    });

    // Recent payments
    const recentPayments = await this.paymentRepository.find({
      where: { status: PaymentStatus.COMPLETED },
      relations: ['user'],
      order: { created_at: 'DESC' },
      take: 10,
    });

    recentPayments.forEach((payment) => {
      activities.push({
        id: payment.id,
        type: 'payment_completed',
        description: `Payment of ${payment.final_amount} EGP completed`,
        userId: payment.user_id,
        userName: payment.user
          ? `${payment.user.first_name} ${payment.user.last_name}`
          : undefined,
        metadata: {
          amount: payment.final_amount,
          itemType: payment.item_type,
        },
        timestamp: payment.created_at,
      });
    });

    // Recent exam submissions
    const recentExams = await this.examAttemptRepository.find({
      where: { status: ExamStatus.GRADED },
      relations: ['student', 'exam'],
      order: { graded_at: 'DESC' },
      take: 10,
    });

    recentExams.forEach((attempt) => {
      if (attempt.graded_at) {
        activities.push({
          id: attempt.id,
          type: 'exam_graded',
          description: `Exam "${attempt.exam?.title}" graded for student`,
          userId: attempt.student_id,
          userName: attempt.student
            ? `${attempt.student.first_name} ${attempt.student.last_name}`
            : undefined,
          metadata: {
            examId: attempt.exam_id,
            score: attempt.total_score,
          },
          timestamp: attempt.graded_at,
        });
      }
    });

    // Sort all activities by timestamp (most recent first)
    activities.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    const result: RecentActivity = {
      activities: activities.slice(0, limit),
      totalCount: activities.length,
    };

    await this.cacheManager.set(cacheKey, result, this.CACHE_TTL_ACTIVITY);
    return result;
  }

  /**
   * Invalidate dashboard cache (call after significant data changes)
   */
  async invalidateCache(pattern?: string): Promise<void> {
    try {
      if (pattern) {
        this.logger.log(`Cache invalidation requested for pattern: ${pattern}`);
        // Delete specific cache key
        await this.cacheManager.del(pattern);
      } else {
        this.logger.log('Full cache invalidation requested');
        // Delete known dashboard cache keys
        const keysToInvalidate = [
          'dashboard:overview',
          'analytics:users',
          'analytics:revenue',
          'analytics:engagement',
          'analytics:content',
          'analytics:activity',
        ];
        await Promise.all(
          keysToInvalidate.map((key) => this.cacheManager.del(key)),
        );
      }
    } catch (error) {
      this.logger.error('Failed to invalidate cache', error);
    }
  }
}
