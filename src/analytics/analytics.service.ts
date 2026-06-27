import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import type { Cache } from 'cache-manager';
import { IsNull, Repository } from 'typeorm';

import { LessonSession } from '../attendance/entities/lesson-session.entity';
import { Book } from '../books/entities/book.entity';
import { BookPurchase } from '../books/entities/book-purchase.entity';
import { Exam } from '../exams/entities';
import { ExamAttempt } from '../exams/entities/exam-attempt.entity';
import { ExamStatus } from '../exams/entities/exam-status.enum';
import { QuestionType } from '../exams/entities/question-type.enum';
import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonPurchase } from '../payments/entities/lesson-purchase.entity';
import { PackagePurchase } from '../payments/entities/package-purchase.entity';
import { LessonReview } from '../reviews/entities/lesson-review.entity';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/entities/user-role.enum';
import { UserStatus } from '../users/entities/user-status.enum';
import {
  AdminDashboardDto,
  ExamAnalyticsDto,
  LessonAnalyticsDto,
  QuestionAnalysisDto,
  StudentDashboardDto,
  TeacherDashboardDto,
} from './dto';

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

interface AnswerData {
  question_index: number;
  is_correct?: boolean;
  score?: number | null;
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
    @InjectRepository(BookPurchase)
    private readonly bookPurchasesRepository: Repository<BookPurchase>,
    @InjectRepository(ExamAttempt)
    private readonly examAttemptsRepository: Repository<ExamAttempt>,
    @InjectRepository(LessonSession)
    private readonly lessonSessionsRepository: Repository<LessonSession>,
    @InjectRepository(LessonReview)
    private readonly lessonReviewsRepository: Repository<LessonReview>,
    @Inject(CACHE_MANAGER)
    private readonly cacheManager: Cache,
  ) {}

  /**
   * Get admin dashboard statistics with caching (5-min TTL)
   */
  public async getAdminDashboard(): Promise<AdminDashboardDto> {
    const cacheKey = 'dashboard:admin';
    const cached = await this.cacheManager.get<AdminDashboardDto>(cacheKey);
    if (cached) {
      return cached;
    }

    // Count students by status
    const totalStudents = await this.usersRepository.count({
      where: {
        role: UserRole.STUDENT,
        deleted_at: IsNull(),
      },
    });

    const pendingStudents = await this.usersRepository.count({
      where: {
        role: UserRole.STUDENT,
        status: UserStatus.PENDING,
        deleted_at: IsNull(),
      },
    });

    const approvedStudents = await this.usersRepository.count({
      where: {
        role: UserRole.STUDENT,
        status: UserStatus.APPROVED,
        deleted_at: IsNull(),
      },
    });

    // Count teachers by status
    const totalTeachers = await this.usersRepository.count({
      where: {
        role: UserRole.TEACHER,
        deleted_at: IsNull(),
      },
    });

    const pendingTeachers = await this.usersRepository.count({
      where: {
        role: UserRole.TEACHER,
        status: UserStatus.PENDING,
        deleted_at: IsNull(),
      },
    });

    const approvedTeachers = await this.usersRepository.count({
      where: {
        role: UserRole.TEACHER,
        status: UserStatus.APPROVED,
        deleted_at: IsNull(),
      },
    });

    // Count content
    const totalLessons = await this.lessonsRepository.count({
      where: { deleted_at: IsNull() },
    });

    const totalBooks = await this.booksRepository.count({
      where: { deleted_at: IsNull() },
    });

    // Calculate revenue
    const totalRevenue = await this.calculateTotalRevenue();
    const revenueThisMonth = await this.calculateMonthlyRevenue(new Date());
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    const revenueLastMonth = await this.calculateMonthlyRevenue(lastMonth);

    const stats: AdminDashboardDto = {
      totalStudents,
      pendingStudents,
      approvedStudents,
      totalTeachers,
      pendingTeachers,
      approvedTeachers,
      totalLessons,
      totalBooks,
      totalRevenue,
      revenueThisMonth,
      revenueLastMonth,
    };

    // Cache for 5 minutes (300000ms)
    await this.cacheManager.set(cacheKey, stats, 300_000);

    return stats;
  }

  /**
   * Get teacher dashboard statistics with caching (5-min TTL)
   */
  public async getTeacherDashboard(
    teacherId: string,
  ): Promise<TeacherDashboardDto> {
    const cacheKey = `dashboard:teacher:${teacherId}`;
    const cached = await this.cacheManager.get<TeacherDashboardDto>(cacheKey);
    if (cached) {
      return cached;
    }

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

    // Count unique students who purchased from this teacher
    const lessonStudents = await this.lessonPurchasesRepository
      .createQueryBuilder('lp')
      .innerJoin('lp.lesson', 'lesson')
      .where('lesson.teacher_id = :teacherId', { teacherId })
      .select('COUNT(DISTINCT lp.student_id)', 'count')
      .getRawOne<CountResult>();

    const totalStudents = Number.parseInt(lessonStudents?.count ?? '0', 10);

    // Calculate revenue from lesson and package purchases
    const lessonRevenue = await this.lessonPurchasesRepository
      .createQueryBuilder('lp')
      .innerJoin('lp.lesson', 'lesson')
      .where('lesson.teacher_id = :teacherId', { teacherId })
      .select('SUM(lp.price_paid)', 'total')
      .getRawOne<SumResult>();

    const packageRevenue = await this.packagePurchasesRepository
      .createQueryBuilder('pp')
      .innerJoin('pp.package', 'package')
      .innerJoin('package.items', 'items')
      .innerJoin('items.lesson', 'lesson')
      .where('lesson.teacher_id = :teacherId', { teacherId })
      .select('SUM(pp.price_paid)', 'total')
      .getRawOne<SumResult>();

    const revenue =
      Number.parseFloat(lessonRevenue?.total ?? '0') +
      Number.parseFloat(packageRevenue?.total ?? '0');

    // Calculate revenue this month
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const lessonRevenueThisMonth = await this.lessonPurchasesRepository
      .createQueryBuilder('lp')
      .innerJoin('lp.lesson', 'lesson')
      .where('lesson.teacher_id = :teacherId', { teacherId })
      .andWhere('lp.created_at >= :start', { start: startOfMonth })
      .select('SUM(lp.price_paid)', 'total')
      .getRawOne<SumResult>();

    const packageRevenueThisMonth = await this.packagePurchasesRepository
      .createQueryBuilder('pp')
      .innerJoin('pp.package', 'package')
      .innerJoin('package.items', 'items')
      .innerJoin('items.lesson', 'lesson')
      .where('lesson.teacher_id = :teacherId', { teacherId })
      .andWhere('pp.created_at >= :start', { start: startOfMonth })
      .select('SUM(pp.price_paid)', 'total')
      .getRawOne<SumResult>();

    const revenueThisMonth =
      Number.parseFloat(lessonRevenueThisMonth?.total ?? '0') +
      Number.parseFloat(packageRevenueThisMonth?.total ?? '0');

    // TODO: Implement ratings when ratings system is added
    const averageRating = null;
    const totalReviews = 0;

    const stats: TeacherDashboardDto = {
      totalLessons,
      totalBooks,
      totalExams,
      totalStudents,
      revenue,
      revenueThisMonth,
      averageRating,
      totalReviews,
    };

    // Cache for 5 minutes (300000ms)
    await this.cacheManager.set(cacheKey, stats, 300_000);

    return stats;
  }

  /**
   * Get student dashboard statistics with caching (5-min TTL)
   */
  public async getStudentDashboard(
    studentId: string,
  ): Promise<StudentDashboardDto> {
    const cacheKey = `dashboard:student:${studentId}`;
    const cached = await this.cacheManager.get<StudentDashboardDto>(cacheKey);
    if (cached) {
      return cached;
    }

    // Count purchased lessons
    const purchasedLessons = await this.lessonPurchasesRepository.count({
      where: { student_id: studentId },
    });

    // Count attended lessons (where access_granted_at is not null)
    const attendedLessons = await this.lessonPurchasesRepository
      .createQueryBuilder('lp')
      .where('lp.student_id = :studentId', { studentId })
      .andWhere('lp.access_granted_at IS NOT NULL')
      .getCount();

    // Count books owned
    const booksOwned = await this.bookPurchasesRepository.count({
      where: { student_id: studentId },
    });

    // Count exams completed (graded)
    const examsCompleted = await this.examAttemptsRepository.count({
      where: {
        student_id: studentId,
        status: ExamStatus.GRADED,
      },
    });

    // Count exams in progress (submitted but not graded)
    const examsInProgress = await this.examAttemptsRepository.count({
      where: {
        student_id: studentId,
        status: ExamStatus.PENDING_GRADING,
      },
    });

    // Calculate average score
    const avgScore = await this.examAttemptsRepository
      .createQueryBuilder('ea')
      .where('ea.student_id = :studentId', { studentId })
      .andWhere('ea.status = :status', { status: ExamStatus.GRADED })
      .andWhere('ea.total_score IS NOT NULL')
      .select('AVG(ea.total_score)', 'avg')
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

    // Cache for 5 minutes (300000ms)
    await this.cacheManager.set(cacheKey, stats, 300_000);

    return stats;
  }

  // ==================== PER-RESOURCE ANALYTICS ====================

  /**
   * Get analytics for a specific lesson with caching (5-min TTL)
   * Includes purchases, views, completion rate, revenue, and ratings
   */
  public async getLessonAnalytics(
    lessonId: string,
  ): Promise<LessonAnalyticsDto> {
    const cacheKey = `analytics:lesson:${lessonId}`;
    const cached = await this.cacheManager.get<LessonAnalyticsDto>(cacheKey);
    if (cached) {
      return cached;
    }

    // Verify lesson exists
    const lesson = await this.lessonsRepository.findOne({
      where: { id: lessonId, deleted_at: IsNull() },
    });

    if (!lesson) {
      throw new NotFoundException(`Lesson with ID ${lessonId} not found`);
    }

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
      totalViews > 0
        ? Math.round((completedSessions / totalViews) * 100 * 100) / 100
        : 0;

    const { directRevenue, packageRevenue } =
      await this.calculateLessonRevenue(lessonId);
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

    // Cache for 5 minutes (300000ms)
    await this.cacheManager.set(cacheKey, analytics, 300_000);

    return analytics;
  }

  /**
   * Helper to calculate direct and package revenue for a lesson
   */
  private async calculateLessonRevenue(lessonId: string): Promise<{
    directRevenue: number;
    packageRevenue: number;
  }> {
    // Calculate revenue from direct purchases
    const directRevenueResult = await this.lessonPurchasesRepository
      .createQueryBuilder('lp')
      .where('lp.lesson_id = :lessonId', { lessonId })
      .select('SUM(lp.price_paid)', 'total')
      .getRawOne<SumResult>();

    const directRevenue = Number.parseFloat(directRevenueResult?.total ?? '0');

    // Calculate revenue from package purchases (proportional based on lesson price in package)
    const packageRevenueResult = await this.packagePurchasesRepository
      .createQueryBuilder('pp')
      .innerJoin('lesson_packages', 'lp', 'lp.id = pp.package_id')
      .innerJoin('lesson_package_items', 'lpi', 'lpi.package_id = lp.id')
      .where('lpi.lesson_id = :lessonId', { lessonId })
      .select('SUM(pp.price_paid)', 'total')
      .getRawOne<SumResult>();

    // Estimate package revenue contribution (total package revenue / items in package)
    const packageRevenue = Number.parseFloat(packageRevenueResult?.total ?? '0');

    return { directRevenue, packageRevenue };
  }

  /**
   * Get analytics for a specific exam with caching (5-min TTL)
   * Includes submissions, scores, pass rate, and per-question analysis
   */
  public async getExamAnalytics(examId: string): Promise<ExamAnalyticsDto> {
    const cacheKey = `analytics:exam:${examId}`;
    const cached = await this.cacheManager.get<ExamAnalyticsDto>(cacheKey);
    if (cached) {
      return cached;
    }

    // Verify exam exists and get questions for analysis
    const exam = await this.examsRepository.findOne({
      where: { id: examId, deleted_at: IsNull() },
    });

    if (!exam) {
      throw new NotFoundException(`Exam with ID ${examId} not found`);
    }

    const { totalSubmissions, inProgressCount, pendingGradingCount } =
      await this.getExamSubmissionCounts(examId);

    const { averageScore, highestScore, lowestScore } =
      await this.getExamScoreStats(examId);

    // Calculate pass rate
    const passRate = await this.calculatePassRate(
      examId,
      totalSubmissions,
      exam.passing_marks,
    );

    // Get all graded attempts for question analysis
    const gradedAttempts = await this.examAttemptsRepository.find({
      where: { exam_id: examId, status: ExamStatus.GRADED },
      select: ['answers'],
    });

    // Analyze each question
    const questionAnalysis: QuestionAnalysisDto[] = this.analyzeExamQuestions(
      exam,
      gradedAttempts,
    );

    // Calculate score distribution (percentage buckets)
    const scoreDistribution = await this.calculateScoreDistribution(
      examId,
      totalSubmissions,
      exam.total_marks,
    );

    const analytics: ExamAnalyticsDto = {
      exam_id: examId,
      total_submissions: totalSubmissions,
      in_progress_count: inProgressCount,
      pending_grading_count: pendingGradingCount,
      average_score: averageScore,
      highest_score: highestScore,
      lowest_score: lowestScore,
      pass_rate: passRate,
      question_analysis: questionAnalysis,
      score_distribution: scoreDistribution,
      calculated_at: new Date(),
    };

    // Cache for 5 minutes (300000ms)
    await this.cacheManager.set(cacheKey, analytics, 300_000);

    return analytics;
  }

  /**
   * Helper to get exam submission counts
   */
  private async getExamSubmissionCounts(examId: string): Promise<{
    totalSubmissions: number;
    inProgressCount: number;
    pendingGradingCount: number;
  }> {
    const totalSubmissions = await this.examAttemptsRepository.count({
      where: { exam_id: examId, status: ExamStatus.GRADED },
    });

    const inProgressCount = await this.examAttemptsRepository.count({
      where: { exam_id: examId, status: ExamStatus.IN_PROGRESS },
    });

    const pendingGradingCount = await this.examAttemptsRepository.count({
      where: { exam_id: examId, status: ExamStatus.PENDING_GRADING },
    });

    return { totalSubmissions, inProgressCount, pendingGradingCount };
  }

  /**
   * Helper to get exam score statistics
   */
  private async getExamScoreStats(examId: string): Promise<{
    averageScore: number | null;
    highestScore: number | null;
    lowestScore: number | null;
  }> {
    const scoreStats = await this.examAttemptsRepository
      .createQueryBuilder('ea')
      .where('ea.exam_id = :examId', { examId })
      .andWhere('ea.status = :status', { status: ExamStatus.GRADED })
      .andWhere('ea.total_score IS NOT NULL')
      .select([
        'AVG(ea.total_score) as avg_score',
        'MAX(ea.total_score) as max_score',
        'MIN(ea.total_score) as min_score',
      ])
      .getRawOne<{
        avg_score: string | null;
        max_score: string | null;
        min_score: string | null;
      }>();

    const averageScore =
      typeof scoreStats?.avg_score === 'string'
        ? Math.round(Number.parseFloat(scoreStats.avg_score) * 100) / 100
        : null;
    const highestScore =
      typeof scoreStats?.max_score === 'string'
        ? Number.parseFloat(scoreStats.max_score)
        : null;
    const lowestScore =
      typeof scoreStats?.min_score === 'string'
        ? Number.parseFloat(scoreStats.min_score)
        : null;

    return { averageScore, highestScore, lowestScore };
  }

  /**
   * Helper to calculate exam pass rate
   */
  private async calculatePassRate(
    examId: string,
    totalSubmissions: number,
    passingMarks: number,
  ): Promise<number | null> {
    if (totalSubmissions <= 0) {
      return null;
    }

    const passedCount = await this.examAttemptsRepository
      .createQueryBuilder('ea')
      .where('ea.exam_id = :examId', { examId })
      .andWhere('ea.status = :status', { status: ExamStatus.GRADED })
      .andWhere('ea.total_score >= :passingMarks', {
        passingMarks,
      })
      .getCount();

    return Math.round((passedCount / totalSubmissions) * 100 * 100) / 100;
  }

  /**
   * Helper to analyze questions in an exam
   */
  private analyzeExamQuestions(
    exam: Exam,
    gradedAttempts: ExamAttempt[],
  ): QuestionAnalysisDto[] {
    return exam.questions.map((question, index) => {
      let correctAnswers = 0;
      let wrongAnswers = 0;
      let totalScore = 0;
      let scoreCount = 0;

      for (const attempt of gradedAttempts) {
        const answers = attempt.answers as unknown as AnswerData[];
        const answer = answers.find((a) => a.question_index === index);
        if (!answer) {
          continue;
        }

        if (question.type === QuestionType.MCQ) {
          if (answer.is_correct === true) {
            correctAnswers++;
          } else {
            wrongAnswers++;
          }
        }

        if (typeof answer.score === 'number') {
          totalScore += answer.score;
          scoreCount++;
        }
      }

      return {
        question_index: index,
        question_type: question.type,
        correct_answers: correctAnswers,
        wrong_answers: wrongAnswers,
        average_score:
          scoreCount > 0
            ? Math.round((totalScore / scoreCount) * 100) / 100
            : null,
        max_marks: question.marks,
      };
    });
  }

  /**
   * Helper to calculate score distribution buckets
   */
  private async calculateScoreDistribution(
    examId: string,
    totalSubmissions: number,
    totalMarks: number,
  ): Promise<{
    '0-20': number;
    '21-40': number;
    '41-60': number;
    '61-80': number;
    '81-100': number;
  }> {
    const scoreDistribution = {
      '0-20': 0,
      '21-40': 0,
      '41-60': 0,
      '61-80': 0,
      '81-100': 0,
    };

    if (totalSubmissions > 0 && totalMarks > 0) {
      const allScores = await this.examAttemptsRepository.find({
        where: { exam_id: examId, status: ExamStatus.GRADED },
        select: ['total_score'],
      });

      for (const attempt of allScores) {
        if (typeof attempt.total_score !== 'number') {
          continue;
        }
        const percentage = (attempt.total_score / totalMarks) * 100;

        if (percentage <= 20) {
          scoreDistribution['0-20']++;
        } else if (percentage <= 40) {
          scoreDistribution['21-40']++;
        } else if (percentage <= 60) {
          scoreDistribution['41-60']++;
        } else if (percentage <= 80) {
          scoreDistribution['61-80']++;
        } else {
          scoreDistribution['81-100']++;
        }
      }
    }

    return scoreDistribution;
  }

  /**
   * Helper: Calculate total revenue from all purchases
   */
  private async calculateTotalRevenue(): Promise<number> {
    const lessonRevenue = await this.lessonPurchasesRepository
      .createQueryBuilder('lp')
      .select('SUM(lp.price_paid)', 'total')
      .getRawOne<SumResult>();

    const packageRevenue = await this.packagePurchasesRepository
      .createQueryBuilder('pp')
      .select('SUM(pp.price_paid)', 'total')
      .getRawOne<SumResult>();

    const bookRevenue = await this.bookPurchasesRepository
      .createQueryBuilder('bp')
      .select('SUM(bp.price_paid)', 'total')
      .getRawOne<SumResult>();

    return (
      Number.parseFloat(lessonRevenue?.total ?? '0') +
      Number.parseFloat(packageRevenue?.total ?? '0') +
      Number.parseFloat(bookRevenue?.total ?? '0')
    );
  }

  /**
   * Helper: Calculate revenue for a specific month
   */
  private async calculateMonthlyRevenue(month: Date): Promise<number> {
    const startOfMonth = new Date(month);
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const endOfMonth = new Date(startOfMonth);
    endOfMonth.setMonth(endOfMonth.getMonth() + 1);

    const lessonRevenue = await this.lessonPurchasesRepository
      .createQueryBuilder('lp')
      .where('lp.created_at >= :start', { start: startOfMonth })
      .andWhere('lp.created_at < :end', { end: endOfMonth })
      .select('SUM(lp.price_paid)', 'total')
      .getRawOne<SumResult>();

    const packageRevenue = await this.packagePurchasesRepository
      .createQueryBuilder('pp')
      .where('pp.created_at >= :start', { start: startOfMonth })
      .andWhere('pp.created_at < :end', { end: endOfMonth })
      .select('SUM(pp.price_paid)', 'total')
      .getRawOne<SumResult>();

    const bookRevenue = await this.bookPurchasesRepository
      .createQueryBuilder('bp')
      .where('bp.purchased_at >= :start', { start: startOfMonth })
      .andWhere('bp.purchased_at < :end', { end: endOfMonth })
      .select('SUM(bp.price_paid)', 'total')
      .getRawOne<SumResult>();

    return (
      Number.parseFloat(lessonRevenue?.total ?? '0') +
      Number.parseFloat(packageRevenue?.total ?? '0') +
      Number.parseFloat(bookRevenue?.total ?? '0')
    );
  }
}
