import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject,Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Book } from '../books/entities/book.entity';
import { BookPurchase } from '../books/entities/book-purchase.entity';
import { Exam } from '../exams/entities/exam.entity';
import { ExamAttempt } from '../exams/entities/exam-attempt.entity';
import { ExamStatus } from '../exams/entities/exam-status.enum';
import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonPurchase } from '../payments/entities/lesson-purchase.entity';
import { PackagePurchase } from '../payments/entities/package-purchase.entity';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/entities/user-role.enum';
import { UserStatus } from '../users/entities/user-status.enum';
import {
  AdminDashboardDto,
  StudentDashboardDto,
  TeacherDashboardDto,
} from './dto';
import type { Cache } from 'cache-manager';
import { IsNull,Repository } from 'typeorm';

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
    @Inject(CACHE_MANAGER)
    private readonly cacheManager: Cache,
  ) {}

  /**
   * Get admin dashboard statistics with caching (5-min TTL)
   */
  public async getAdminDashboard(): Promise<AdminDashboardDto> {
    const cacheKey = 'dashboard:admin';
    const cached = await this.cacheManager.get<AdminDashboardDto>(cacheKey);
    if(cached) {
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
    await this.cacheManager.set(cacheKey, stats, 300000);

    return stats;
  }

  /**
   * Get teacher dashboard statistics with caching (5-min TTL)
   */
  public async getTeacherDashboard(teacherId: string): Promise<TeacherDashboardDto> {
    const cacheKey = `dashboard:teacher:${teacherId}`;
    const cached = await this.cacheManager.get<TeacherDashboardDto>(cacheKey);
    if(cached) {
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

    const totalStudents = parseInt(lessonStudents?.count ?? '0', 10);

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
      parseFloat(lessonRevenue?.total ?? '0') +
      parseFloat(packageRevenue?.total ?? '0');

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
      parseFloat(lessonRevenueThisMonth?.total ?? '0') +
      parseFloat(packageRevenueThisMonth?.total ?? '0');

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
    await this.cacheManager.set(cacheKey, stats, 300000);

    return stats;
  }

  /**
   * Get student dashboard statistics with caching (5-min TTL)
   */
  public async getStudentDashboard(studentId: string): Promise<StudentDashboardDto> {
    const cacheKey = `dashboard:student:${studentId}`;
    const cached = await this.cacheManager.get<StudentDashboardDto>(cacheKey);
    if(cached) {
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

    const averageScore = avgScore?.avg ? parseFloat(avgScore.avg) : null;

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
    await this.cacheManager.set(cacheKey, stats, 300000);

    return stats;
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

    return(
      parseFloat(lessonRevenue?.total ?? '0') +
      parseFloat(packageRevenue?.total ?? '0') +
      parseFloat(bookRevenue?.total ?? '0')
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
      .where('bp.created_at >= :start', { start: startOfMonth })
      .andWhere('bp.created_at < :end', { end: endOfMonth })
      .select('SUM(bp.price_paid)', 'total')
      .getRawOne<SumResult>();

    return(
      parseFloat(lessonRevenue?.total ?? '0') +
      parseFloat(packageRevenue?.total ?? '0') +
      parseFloat(bookRevenue?.total ?? '0')
    );
  }
}
