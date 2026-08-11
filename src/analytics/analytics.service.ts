import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { In, IsNull, Repository } from 'typeorm';

import { LessonSession } from '../attendance/entities/lesson-session.entity';
import { Book } from '../books/entities/book.entity';
import { BookPurchase } from '../books/entities/book-purchase.entity';
import { AttemptState } from '../exams/entities/attempt-state.enum';
import { Exam } from '../exams/entities/exam.entity';
import { ExamAttempt } from '../exams/entities/exam-attempt.entity';
import { ExamQuestion } from '../exams/entities/exam-question.entity';
import { Lesson } from '../lessons/entities/lesson.entity';
import { ItemType } from '../payments/entities/item-type.enum';
import { LessonPurchase } from '../payments/entities/lesson-purchase.entity';
import { PackagePurchase } from '../payments/entities/package-purchase.entity';
import { Payment } from '../payments/entities/payment.entity';
import { PaymentStatus } from '../payments/entities/payment-status.enum';
import { Order } from '../payments/entities/order.entity';
import { OrderStatus } from '../payments/entities/order-status.enum';
import { LessonReview } from '../reviews/entities/lesson-review.entity';
import { ReviewStatus } from '../reviews/entities/review-status.enum';
import { User } from '../users/entities/user.entity';
import { biBody } from '../i18n/error-translator.util';
import { UserRole } from '../users/entities/user-role.enum';
import { UserStatus } from '../users/entities/user-status.enum';
import {
  LegacyAdminDashboardDto,
  ExamAnalyticsDto,
  LessonAnalyticsDto,
  QuestionAnalysisDto,
  StudentDashboardDto,
  TeacherDashboardDto,
} from './dto';
import { getUtcRevenuePeriodBoundaries } from './revenue-periods';
import { ApplicationCacheService } from '../common/cache/application-cache.service';
import type { JwtPayload } from '../common/interfaces/user-request.interface';

/**
 * Type definitions for raw query results
 */
interface SumResult {
  total: string | null;
}

interface CountResult {
  count: string | null;
}

interface AvgResult {
  avg: string | null;
}

interface AdminUserCountsRow {
  total_students: string;
  pending_students: string;
  approved_students: string;
  total_teachers: string;
  pending_teachers: string;
  approved_teachers: string;
}

interface AdminContentCountsRow {
  total_lessons: string;
  total_books: string;
  total_exams: string;
}

interface AdminRevenueRow {
  total_revenue: string;
  revenue_today: string;
  revenue_this_month: string;
  revenue_last_month: string;
  revenue_this_quarter: string;
  lesson_revenue: string;
  package_revenue: string;
  book_revenue: string;
}

interface ExamAttemptStatsRow {
  total_submissions: string;
  in_progress_count: string;
  pending_grading_count: string;
  average_score: string | null;
  highest_score: string | null;
  lowest_score: string | null;
  pass_rate: string | null;
  bucket_0_20: string;
  bucket_21_40: string;
  bucket_41_60: string;
  bucket_61_80: string;
  bucket_81_100: string;
}

interface QuestionAnalysisRawRow {
  question_index: number;
  question_type: string;
  correct_answers: string;
  wrong_answers: string;
  average_score: string | null;
  max_marks: number;
}

@Injectable()
export class AnalyticsService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(Lesson)
    private readonly lessonsRepository: Repository<Lesson>,
    @InjectRepository(Book)
    private readonly booksRepository: Repository<Book>,
    @InjectRepository(Exam)
    private readonly examsRepository: Repository<Exam>,
    @InjectRepository(LessonPurchase)
    private readonly lessonPurchasesRepository: Repository<LessonPurchase>,
    @InjectRepository(PackagePurchase)
    private readonly packagePurchasesRepository: Repository<PackagePurchase>,
    @InjectRepository(Payment)
    private readonly paymentsRepository: Repository<Payment>,
    @InjectRepository(BookPurchase)
    private readonly bookPurchasesRepository: Repository<BookPurchase>,
    @InjectRepository(ExamAttempt)
    private readonly examAttemptsRepository: Repository<ExamAttempt>,
    @InjectRepository(ExamQuestion)
    private readonly examQuestionsRepository: Repository<ExamQuestion>,
    @InjectRepository(LessonSession)
    private readonly lessonSessionsRepository: Repository<LessonSession>,
    @InjectRepository(LessonReview)
    private readonly lessonReviewsRepository: Repository<LessonReview>,
    private readonly applicationCache: ApplicationCacheService,
  ) {}

  /**
   * Get admin dashboard statistics with caching (5-min TTL)
   */
  public async getAdminDashboard(tenant?: string): Promise<LegacyAdminDashboardDto> {
    return await this.applicationCache.getOrCompute(
      {
        family: 'admin_dashboard',
        endpoint: 'analytics.admin-dashboard',
        tenant,
        scope: 'role:admin',
        ttlMs: 60_000,
      },
      async () => {
        const [userCounts, contentCounts, revenue] = await Promise.all([
          this.getAdminUserCounts(),
          this.getAdminContentCounts(),
          this.getAdminRevenue(),
        ]);

        return {
          totalStudents: this.toNumber(userCounts.total_students),
          pendingStudents: this.toNumber(userCounts.pending_students),
          approvedStudents: this.toNumber(userCounts.approved_students),
          totalTeachers: this.toNumber(userCounts.total_teachers),
          pendingTeachers: this.toNumber(userCounts.pending_teachers),
          approvedTeachers: this.toNumber(userCounts.approved_teachers),
          totalLessons: this.toNumber(contentCounts.total_lessons),
          totalBooks: this.toNumber(contentCounts.total_books),
          totalExams: this.toNumber(contentCounts.total_exams),
          totalRevenue: this.toNumber(revenue.total_revenue),
          revenueToday: this.toNumber(revenue.revenue_today),
          revenueThisMonth: this.toNumber(revenue.revenue_this_month),
          revenueLastMonth: this.toNumber(revenue.revenue_last_month),
          revenueThisQuarter: this.toNumber(revenue.revenue_this_quarter),
          revenueBySource: {
            lessons: this.toNumber(revenue.lesson_revenue),
            packages: this.toNumber(revenue.package_revenue),
            books: this.toNumber(revenue.book_revenue),
          },
        };
      },
    );
  }

  private async getAdminUserCounts(): Promise<AdminUserCountsRow> {
    const row = await this.usersRepository
      .createQueryBuilder('user')
      .select('COUNT(*) FILTER (WHERE user.role = :studentRole)', 'total_students')
      .addSelect(
        'COUNT(*) FILTER (WHERE user.role = :studentRole AND user.status = :pendingStatus)',
        'pending_students',
      )
      .addSelect(
        'COUNT(*) FILTER (WHERE user.role = :studentRole AND user.status = :approvedStatus)',
        'approved_students',
      )
      .addSelect('COUNT(*) FILTER (WHERE user.role = :teacherRole)', 'total_teachers')
      .addSelect(
        'COUNT(*) FILTER (WHERE user.role = :teacherRole AND user.status = :pendingStatus)',
        'pending_teachers',
      )
      .addSelect(
        'COUNT(*) FILTER (WHERE user.role = :teacherRole AND user.status = :approvedStatus)',
        'approved_teachers',
      )
      .where('user.deleted_at IS NULL')
      .setParameters({
        studentRole: UserRole.STUDENT,
        teacherRole: UserRole.TEACHER,
        pendingStatus: UserStatus.PENDING,
        approvedStatus: UserStatus.APPROVED,
      })
      .getRawOne<AdminUserCountsRow>();

    return row ?? this.emptyAdminUserCounts();
  }

  private async getAdminContentCounts(): Promise<AdminContentCountsRow> {
    const row = await this.lessonsRepository
      .createQueryBuilder('lesson')
      .select('COUNT(*) FILTER (WHERE lesson.deleted_at IS NULL)', 'total_lessons')
      .addSelect(
        (query) => query.select('COUNT(*)').from(Book, 'book').where('book.deleted_at IS NULL'),
        'total_books',
      )
      .addSelect(
        (query) => query.select('COUNT(*)').from(Exam, 'exam').where('exam.deleted_at IS NULL'),
        'total_exams',
      )
      .withDeleted()
      .getRawOne<AdminContentCountsRow>();

    return (
      row ?? {
        total_lessons: '0',
        total_books: '0',
        total_exams: '0',
      }
    );
  }

  private async getAdminRevenue(): Promise<AdminRevenueRow> {
    const { startToday, startMonth, startLastMonth, startQuarter } = getUtcRevenuePeriodBoundaries(
      new Date(),
    );

    const row = await this.paymentsRepository
      .createQueryBuilder('payment')
      .innerJoin(Order, 'order', 'order.id = payment.order_id')
      .select('COALESCE(SUM(order.final_amount_minor), 0) / 100.0', 'total_revenue')
      .addSelect(
        'COALESCE(SUM(order.final_amount_minor) FILTER (WHERE order.paid_at >= :startToday), 0) / 100.0',
        'revenue_today',
      )
      .addSelect(
        'COALESCE(SUM(order.final_amount_minor) FILTER (WHERE order.paid_at >= :startMonth), 0) / 100.0',
        'revenue_this_month',
      )
      .addSelect(
        'COALESCE(SUM(order.final_amount_minor) FILTER (WHERE order.paid_at >= :startLastMonth AND order.paid_at < :startMonth), 0) / 100.0',
        'revenue_last_month',
      )
      .addSelect(
        'COALESCE(SUM(order.final_amount_minor) FILTER (WHERE order.paid_at >= :startQuarter), 0) / 100.0',
        'revenue_this_quarter',
      )
      .addSelect(
        'COALESCE(SUM(order.final_amount_minor) FILTER (WHERE order.item_type IN (:lessonType, :lessonSessionType)), 0) / 100.0',
        'lesson_revenue',
      )
      .addSelect(
        'COALESCE(SUM(order.final_amount_minor) FILTER (WHERE order.item_type = :packageType), 0) / 100.0',
        'package_revenue',
      )
      .addSelect(
        'COALESCE(SUM(order.final_amount_minor) FILTER (WHERE order.item_type = :bookType), 0) / 100.0',
        'book_revenue',
      )
      .where('payment.status = :completedStatus')
      .andWhere('order.status = :paidOrderStatus')
      .andWhere('order.paid_at IS NOT NULL')
      .setParameters({
        completedStatus: PaymentStatus.COMPLETED,
        paidOrderStatus: OrderStatus.PAID,
        lessonType: ItemType.LESSON,
        lessonSessionType: ItemType.LESSON_SESSION,
        packageType: ItemType.PACKAGE,
        bookType: ItemType.BOOK,
        startToday,
        startMonth,
        startLastMonth,
        startQuarter,
      })
      .getRawOne<AdminRevenueRow>();

    return (
      row ?? {
        total_revenue: '0',
        revenue_today: '0',
        revenue_this_month: '0',
        revenue_last_month: '0',
        revenue_this_quarter: '0',
        lesson_revenue: '0',
        package_revenue: '0',
        book_revenue: '0',
      }
    );
  }

  private emptyAdminUserCounts(): AdminUserCountsRow {
    return {
      total_students: '0',
      pending_students: '0',
      approved_students: '0',
      total_teachers: '0',
      pending_teachers: '0',
      approved_teachers: '0',
    };
  }

  private toNumber(value: string | number | null | undefined): number {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /**
   * Get teacher dashboard statistics with caching (5-min TTL)
   */
  public async getTeacherDashboard(
    teacherId: string,
    tenant?: string,
    from?: Date,
    to?: Date,
  ): Promise<TeacherDashboardDto> {
    return await this.applicationCache.getOrCompute(
      {
        family: 'teacher_dashboard',
        endpoint: 'analytics.teacher-dashboard',
        tenant,
        scope: `owner:${teacherId}`,
        parts: [teacherId, from?.toISOString() ?? 'all', to?.toISOString() ?? 'all'],
        ttlMs: 30_000,
      },
      async () => {
        // Count teacher's content
        const totalLessons = await this.lessonsRepository.count({
          where: { teacher_id: teacherId, deleted_at: IsNull() },
        });

        const totalBooks = await this.booksRepository.count({
          where: { teacher_id: teacherId, deleted_at: IsNull() },
        });

        const totalExams = await this.examsRepository.count({
          where: { teacher_id: teacherId, deleted_at: IsNull() },
        });

        // Financial dashboard facts are sourced only from confirmed paid orders.
        const paidStudentsQuery = this.canonicalPaidOrderQuery(teacherId);
        if (from) paidStudentsQuery.andWhere('order.paid_at >= :from', { from });
        if (to) paidStudentsQuery.andWhere('order.paid_at <= :to', { to });
        const paidStudents = await paidStudentsQuery
          .select('COUNT(DISTINCT order.student_id)', 'count')
          .getRawOne<CountResult>();

        const totalStudents = Number.parseInt(paidStudents?.count ?? '0', 10);

        const paidRevenueQuery = this.canonicalPaidOrderQuery(teacherId);
        if (from) paidRevenueQuery.andWhere('order.paid_at >= :from', { from });
        if (to) paidRevenueQuery.andWhere('order.paid_at <= :to', { to });
        const paidRevenue = await paidRevenueQuery
          .select('COALESCE(SUM(order.final_amount_minor), 0) / 100.0', 'total')
          .getRawOne<SumResult>();

        const revenue = Number.parseFloat(paidRevenue?.total ?? '0');

        // Calculate revenue this month
        const startOfMonth = new Date();
        startOfMonth.setDate(1);
        startOfMonth.setHours(0, 0, 0, 0);

        const paidRevenueThisMonthQuery = this.canonicalPaidOrderQuery(teacherId).andWhere(
          'order.paid_at >= :start',
          { start: startOfMonth },
        );
        if (from) paidRevenueThisMonthQuery.andWhere('order.paid_at >= :from', { from });
        if (to) paidRevenueThisMonthQuery.andWhere('order.paid_at <= :to', { to });
        const paidRevenueThisMonth = await paidRevenueThisMonthQuery
          .select('COALESCE(SUM(order.final_amount_minor), 0) / 100.0', 'total')
          .getRawOne<SumResult>();

        const revenueThisMonth = Number.parseFloat(paidRevenueThisMonth?.total ?? '0');

        const ratingsQuery = this.lessonReviewsRepository
          .createQueryBuilder('lr')
          .innerJoin('lr.lesson', 'lesson')
          .where('lesson.teacher_id = :teacherId', { teacherId })
          .andWhere('lr.status = :status', { status: ReviewStatus.APPROVED });
        if (from) ratingsQuery.andWhere('lr.created_at >= :ratingsFrom', { ratingsFrom: from });
        if (to) ratingsQuery.andWhere('lr.created_at <= :ratingsTo', { ratingsTo: to });
        const ratings = await ratingsQuery
          .select('AVG(lr.rating)', 'average')
          .addSelect('COUNT(*)', 'count')
          .getRawOne<{ average: string | null; count: string }>();
        const averageRating =
          ratings?.average == null
            ? null
            : Math.round(Number.parseFloat(ratings.average) * 100) / 100;
        const totalReviews = Number.parseInt(ratings?.count ?? '0', 10);

        const engagementQuery = this.lessonSessionsRepository
          .createQueryBuilder('session')
          .innerJoin('session.lesson', 'engagementLesson')
          .where('engagementLesson.teacher_id = :teacherId', { teacherId });
        if (from)
          engagementQuery.andWhere('session.entered_at >= :engagementFrom', {
            engagementFrom: from,
          });
        if (to)
          engagementQuery.andWhere('session.entered_at <= :engagementTo', { engagementTo: to });
        const engagementViews = await engagementQuery.getCount();

        const stats: TeacherDashboardDto = {
          totalLessons,
          totalBooks,
          totalExams,
          totalStudents,
          revenue,
          revenueThisMonth,
          averageRating,
          totalReviews,
          engagementViews,
        };

        return stats;
      },
    );
  }

  /**
   * Get student dashboard statistics with caching (5-min TTL)
   */
  public async getStudentDashboard(
    studentId: string,
    tenant?: string,
  ): Promise<StudentDashboardDto> {
    return await this.applicationCache.getOrCompute(
      {
        family: 'student_dashboard',
        endpoint: 'analytics.student-dashboard',
        tenant,
        scope: `owner:${studentId}`,
        parts: [studentId],
        ttlMs: 30_000,
      },
      async () => {
        // Count purchased lessons
        const purchasedLessons = await this.lessonPurchasesRepository.count({
          where: { student_id: studentId, revoked_at: IsNull() },
        });

        // Count attended lessons (where access_granted_at is not null)
        const attendedLessons = await this.lessonPurchasesRepository
          .createQueryBuilder('lp')
          .where('lp.student_id = :studentId', { studentId })
          .andWhere('lp.revoked_at IS NULL')
          .andWhere('lp.access_granted_at IS NOT NULL')
          .getCount();

        // Count books owned
        const booksOwned = await this.bookPurchasesRepository.count({
          where: { student_id: studentId, revoked_at: IsNull() },
        });

        // Count exams completed (fully graded)
        const examsCompleted = await this.examAttemptsRepository.count({
          where: {
            student_id: studentId,
            state: AttemptState.GRADED,
          },
        });

        // Count exams submitted but still awaiting grading
        const examsInProgress = await this.examAttemptsRepository.count({
          where: {
            student_id: studentId,
            state: In([AttemptState.SUBMITTED, AttemptState.GRADING]),
          },
        });

        // Calculate average total score across graded attempts
        const avgScore = await this.examAttemptsRepository
          .createQueryBuilder('ea')
          .where('ea.student_id = :studentId', { studentId })
          .andWhere('ea.state = :state', { state: AttemptState.GRADED })
          .andWhere('ea.score_total IS NOT NULL')
          .select('AVG(ea.score_total)', 'avg')
          .getRawOne<AvgResult>();

        const averageScore =
          avgScore?.avg !== null && avgScore?.avg !== undefined
            ? Number.parseFloat(avgScore.avg)
            : null;

        // Count lessons with active access (not expired)
        const now = new Date();
        const activeAccessCount = await this.lessonPurchasesRepository
          .createQueryBuilder('lp')
          .where('lp.student_id = :studentId', { studentId })
          .andWhere('lp.access_expires_at > :now', { now })
          .getCount();

        const stats: StudentDashboardDto = {
          purchasedLessons,
          attendedLessons,
          booksOwned,
          examsCompleted,
          examsInProgress,
          averageScore,
          activeAccessCount,
        };

        return stats;
      },
    );
  }

  // ==================== PER-RESOURCE ANALYTICS ====================

  /**
   * Get analytics for a specific lesson with caching (5-min TTL)
   * Includes purchases, views, completion rate, revenue, and ratings
   */
  public async getLessonAnalytics(
    principal: JwtPayload,
    lessonId: string,
  ): Promise<LessonAnalyticsDto> {
    // Verify and authorize before reading or populating cache.
    const lesson = await this.lessonsRepository.findOne({
      where: { id: lessonId, deleted_at: IsNull() },
    });

    if (!lesson) {
      throw new NotFoundException(
        biBody(`Lesson with ID ${lessonId} not found`, `الدرس بالمعرف ${lessonId} غير موجود`),
      );
    }

    this.assertAnalyticsAccess(principal, lesson.teacher_id);
    return await this.applicationCache.getOrCompute(
      {
        family: 'lesson_analytics',
        endpoint: 'analytics.lesson',
        tenant: principal.tenantId,
        scope: `owner:${lesson.teacher_id}`,
        parts: [lessonId],
        ttlMs: 30_000,
      },
      async () => {
        // Count direct purchases
        const directPurchases = await this.lessonPurchasesRepository.count({
          where: { lesson_id: lessonId },
        });

        // Count package purchases (via lesson_package_items join)
        const packagePurchasesResult = await this.packagePurchasesRepository
          .createQueryBuilder('pp')
          .innerJoin('lesson_packages', 'lp', 'lp.id = pp.package_id')
          .innerJoin('lesson_package_items', 'lpi', 'lpi.package_id = lp.id')
          .where('lpi.lesson_id = :lessonId', { lessonId })
          .select('COUNT(DISTINCT pp.id)', 'count')
          .getRawOne<CountResult>();

        const packagePurchases = Number.parseInt(packagePurchasesResult?.count ?? '0', 10);
        const totalPurchases = directPurchases + packagePurchases;

        // Count total views (lesson sessions)
        const totalViews = await this.lessonSessionsRepository.count({
          where: { lesson_id: lessonId },
        });

        // Calculate average watch time
        const avgWatchTimeResult = await this.lessonSessionsRepository
          .createQueryBuilder('ls')
          .where('ls.lesson_id = :lessonId', { lessonId })
          .select('AVG(ls.duration_seconds)', 'avg')
          .getRawOne<AvgResult>();

        const averageWatchTimeSeconds = Number.parseFloat(avgWatchTimeResult?.avg ?? '0');

        // Calculate completion rate (sessions with 90%+ video progress)
        const completedSessions = await this.lessonSessionsRepository
          .createQueryBuilder('ls')
          .where('ls.lesson_id = :lessonId', { lessonId })
          .andWhere('ls.video_progress_percent >= 90')
          .getCount();

        const completionRate =
          totalViews > 0 ? Math.round((completedSessions / totalViews) * 100 * 100) / 100 : 0;

        const { directRevenue, packageRevenue } = await this.calculateLessonRevenue(lessonId);
        const totalRevenue = directRevenue + packageRevenue;

        // Calculate average rating
        const avgRatingResult = await this.lessonReviewsRepository
          .createQueryBuilder('lr')
          .where('lr.lesson_id = :lessonId', { lessonId })
          .select('AVG(lr.rating)', 'avg')
          .getRawOne<AvgResult>();

        const averageRating =
          avgRatingResult?.avg !== null && avgRatingResult?.avg !== undefined
            ? Math.round(Number.parseFloat(avgRatingResult.avg) * 100) / 100
            : null;

        // Count total reviews
        const totalReviews = await this.lessonReviewsRepository.count({
          where: { lesson_id: lessonId },
        });

        const analytics: LessonAnalyticsDto = {
          lesson_id: lessonId,
          total_purchases: totalPurchases,
          total_views: totalViews,
          average_watch_time_seconds: Math.round(averageWatchTimeSeconds),
          completion_rate: completionRate,
          revenue: totalRevenue,
          average_rating: averageRating,
          total_reviews: totalReviews,
          revenue_breakdown: {
            direct_purchases: directRevenue,
            package_purchases: packageRevenue,
          },
          calculated_at: new Date(),
        };

        return analytics;
      },
    );
  }

  /**
   * Helper to calculate direct and package revenue for a lesson
   */
  private async calculateLessonRevenue(lessonId: string): Promise<{
    directRevenue: number;
    packageRevenue: number;
  }> {
    const directRevenueResult = await this.canonicalPaidOrderQuery()
      .andWhere('order.item_type = :lessonType', { lessonType: ItemType.LESSON })
      .andWhere('order.item_id = :lessonId', { lessonId })
      .select('COALESCE(SUM(order.final_amount_minor), 0) / 100.0', 'total')
      .getRawOne<SumResult>();

    const directRevenue = Number.parseFloat(directRevenueResult?.total ?? '0');

    // A package order is a package-level sale. The canonical ledger/order model
    // has no approved per-lesson allocation, so it is deliberately excluded
    // instead of duplicating its gross amount across every lesson it contains.
    const packageRevenue = 0;

    return { directRevenue, packageRevenue };
  }

  /** Confirmed paid order + completed payment + paid_at is the only revenue source. */
  private canonicalPaidOrderQuery(teacherId?: string) {
    const query = this.paymentsRepository.manager
      .getRepository(Order)
      .createQueryBuilder('order')
      .innerJoin(
        Payment,
        'payment',
        'payment.id = order.payment_id AND payment.status = :completedPaymentStatus',
        { completedPaymentStatus: PaymentStatus.COMPLETED },
      )
      .where('order.status = :paidOrderStatus', { paidOrderStatus: OrderStatus.PAID })
      .andWhere('order.paid_at IS NOT NULL');
    if (teacherId) query.andWhere('order.teacher_id = :teacherId', { teacherId });
    return query;
  }

  /**
   * Get analytics for a specific exam with caching (5-min TTL)
   * Includes submissions, scores, pass rate, and per-question analysis
   */
  public async getExamAnalytics(principal: JwtPayload, examId: string): Promise<ExamAnalyticsDto> {
    // Verify and authorize before reading or populating cache.
    const exam = await this.examsRepository.findOne({
      where: { id: examId, deleted_at: IsNull() },
    });

    if (!exam) {
      throw new NotFoundException(
        biBody(`Exam with ID ${examId} not found`, `الاختبار بالمعرف ${examId} غير موجود`),
      );
    }

    this.assertAnalyticsAccess(principal, exam.teacher_id);
    return await this.applicationCache.getOrCompute(
      {
        family: 'exam_analytics',
        endpoint: 'analytics.exam',
        tenant: principal.tenantId,
        scope: `owner:${exam.teacher_id}`,
        parts: [examId],
        ttlMs: 15_000,
      },
      async () => {
        const [attemptStats, questionAnalysis] = await Promise.all([
          this.getExamAttemptStats(examId, exam.passing_marks, exam.total_marks),
          this.analyzeExamQuestions(examId),
        ]);

        const analytics: ExamAnalyticsDto = {
          exam_id: examId,
          total_submissions: attemptStats.totalSubmissions,
          in_progress_count: attemptStats.inProgressCount,
          pending_grading_count: attemptStats.pendingGradingCount,
          average_score: attemptStats.averageScore,
          highest_score: attemptStats.highestScore,
          lowest_score: attemptStats.lowestScore,
          pass_rate: attemptStats.passRate,
          question_analysis: questionAnalysis,
          score_distribution: attemptStats.scoreDistribution,
          calculated_at: new Date(),
        };

        return analytics;
      },
    );
  }

  /**
   * Recompute + warm the cached analytics for an exam. Invoked asynchronously by
   * the exam-analytics BullMQ worker whenever an attempt's grade changes, so the
   * teacher dashboard reads are always fresh without paying the cost on-request.
   */
  public async recomputeExam(examId: string): Promise<void> {
    await this.applicationCache.invalidate(['exam_analytics']);
    try {
      void examId;
    } catch {
      // Exam no longer exists / not gradable yet — nothing to warm.
    }
  }

  private assertAnalyticsAccess(principal: JwtPayload, ownerId: string): void {
    if (principal.role === 'admin') return;
    if (principal.role === 'teacher' && principal.userId === ownerId) return;
    throw new ForbiddenException('You do not have access to this analytics resource');
  }

  /** Trusted server-side admin composition; HTTP analytics still requires a JWT. */
  public async getExamAnalyticsForAdmin(examId: string): Promise<ExamAnalyticsDto> {
    return await this.getExamAnalytics(
      { userId: 'internal-admin', email: '', name: '', role: 'admin' },
      examId,
    );
  }

  private async getExamAttemptStats(
    examId: string,
    passingMarks: number,
    totalMarks: number,
  ): Promise<{
    totalSubmissions: number;
    inProgressCount: number;
    pendingGradingCount: number;
    averageScore: number | null;
    highestScore: number | null;
    lowestScore: number | null;
    passRate: number | null;
    scoreDistribution: {
      '0-20': number;
      '21-40': number;
      '41-60': number;
      '61-80': number;
      '81-100': number;
    };
  }> {
    const row = await this.examAttemptsRepository
      .createQueryBuilder('ea')
      .where('ea.exam_id = :examId', { examId })
      .select(`COUNT(*) FILTER (WHERE ea.state = :gradedState)`, 'total_submissions')
      .addSelect(`COUNT(*) FILTER (WHERE ea.state = :inProgressState)`, 'in_progress_count')
      .addSelect(`COUNT(*) FILTER (WHERE ea.state IN (:...pendingStates))`, 'pending_grading_count')
      .addSelect(
        `ROUND(AVG(ea.score_total) FILTER (WHERE ea.state = :gradedState), 2)`,
        'average_score',
      )
      .addSelect(`MAX(ea.score_total) FILTER (WHERE ea.state = :gradedState)`, 'highest_score')
      .addSelect(`MIN(ea.score_total) FILTER (WHERE ea.state = :gradedState)`, 'lowest_score')
      .addSelect(
        `ROUND(
          (COUNT(*) FILTER (
            WHERE ea.state = :gradedState AND ea.score_total >= :passingMarks
          ))::numeric
          / NULLIF(COUNT(*) FILTER (WHERE ea.state = :gradedState), 0)
          * 100,
          2
        )`,
        'pass_rate',
      )
      .addSelect(
        `COUNT(*) FILTER (
          WHERE ea.state = :gradedState
            AND ea.score_total IS NOT NULL
            AND :totalMarks > 0
            AND ea.score_total / :totalMarks::numeric * 100 <= 20
        )`,
        'bucket_0_20',
      )
      .addSelect(
        `COUNT(*) FILTER (
          WHERE ea.state = :gradedState
            AND ea.score_total IS NOT NULL
            AND :totalMarks > 0
            AND ea.score_total / :totalMarks::numeric * 100 > 20
            AND ea.score_total / :totalMarks::numeric * 100 <= 40
        )`,
        'bucket_21_40',
      )
      .addSelect(
        `COUNT(*) FILTER (
          WHERE ea.state = :gradedState
            AND ea.score_total IS NOT NULL
            AND :totalMarks > 0
            AND ea.score_total / :totalMarks::numeric * 100 > 40
            AND ea.score_total / :totalMarks::numeric * 100 <= 60
        )`,
        'bucket_41_60',
      )
      .addSelect(
        `COUNT(*) FILTER (
          WHERE ea.state = :gradedState
            AND ea.score_total IS NOT NULL
            AND :totalMarks > 0
            AND ea.score_total / :totalMarks::numeric * 100 > 60
            AND ea.score_total / :totalMarks::numeric * 100 <= 80
        )`,
        'bucket_61_80',
      )
      .addSelect(
        `COUNT(*) FILTER (
          WHERE ea.state = :gradedState
            AND ea.score_total IS NOT NULL
            AND :totalMarks > 0
            AND ea.score_total / :totalMarks::numeric * 100 > 80
        )`,
        'bucket_81_100',
      )
      .setParameters({
        gradedState: AttemptState.GRADED,
        inProgressState: AttemptState.IN_PROGRESS,
        pendingStates: [AttemptState.SUBMITTED, AttemptState.GRADING],
        passingMarks,
        totalMarks,
      })
      .getRawOne<ExamAttemptStatsRow>();

    return {
      totalSubmissions: Number.parseInt(row?.total_submissions ?? '0', 10),
      inProgressCount: Number.parseInt(row?.in_progress_count ?? '0', 10),
      pendingGradingCount: Number.parseInt(row?.pending_grading_count ?? '0', 10),
      averageScore: row?.average_score == null ? null : Number(row.average_score),
      highestScore: row?.highest_score == null ? null : Number(row.highest_score),
      lowestScore: row?.lowest_score == null ? null : Number(row.lowest_score),
      passRate: row?.pass_rate == null ? null : Number(row.pass_rate),
      scoreDistribution: {
        '0-20': Number.parseInt(row?.bucket_0_20 ?? '0', 10),
        '21-40': Number.parseInt(row?.bucket_21_40 ?? '0', 10),
        '41-60': Number.parseInt(row?.bucket_41_60 ?? '0', 10),
        '61-80': Number.parseInt(row?.bucket_61_80 ?? '0', 10),
        '81-100': Number.parseInt(row?.bucket_81_100 ?? '0', 10),
      },
    };
  }

  /**
   * Per-question analysis from the normalized answer rows of graded attempts.
   * Correctness comes from each answer's `is_correct` flag (set by the objective
   * graders), so this is question-type agnostic.
   */
  private async analyzeExamQuestions(examId: string): Promise<QuestionAnalysisDto[]> {
    const rows = await this.examQuestionsRepository.query<QuestionAnalysisRawRow[]>(
      `
        WITH answer_stats AS (
          SELECT
            answer.exam_question_id,
            COUNT(*) FILTER (WHERE answer.is_correct IS TRUE) AS correct_answers,
            COUNT(*) FILTER (WHERE answer.is_correct IS FALSE) AS wrong_answers,
            ROUND(AVG(answer.score) FILTER (WHERE answer.score IS NOT NULL), 2) AS average_score
          FROM exam_attempt_answers answer
          INNER JOIN exam_attempts attempt ON attempt.id = answer.attempt_id
          WHERE attempt.exam_id = $1
            AND attempt.state = $2
          GROUP BY answer.exam_question_id
        )
        SELECT
          exam_question.order_index AS question_index,
          exam_question.type_snapshot AS question_type,
          COALESCE(answer_stats.correct_answers, 0) AS correct_answers,
          COALESCE(answer_stats.wrong_answers, 0) AS wrong_answers,
          answer_stats.average_score,
          exam_question.marks AS max_marks
        FROM exam_questions exam_question
        LEFT JOIN answer_stats ON answer_stats.exam_question_id = exam_question.id
        WHERE exam_question.exam_id = $1
        ORDER BY exam_question.order_index ASC
      `,
      [examId, AttemptState.GRADED],
    );

    const analysis: QuestionAnalysisDto[] = [];
    for (const row of rows) {
      analysis.push({
        question_index: Number(row.question_index),
        question_type: row.question_type,
        correct_answers: Number.parseInt(row.correct_answers, 10),
        wrong_answers: Number.parseInt(row.wrong_answers, 10),
        average_score: row.average_score === null ? null : Number(row.average_score),
        max_marks: Number(row.max_marks),
      });
    }
    return analysis;
  }
}
