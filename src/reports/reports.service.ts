import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Between, IsNull, Repository } from 'typeorm';

import { LessonSession } from '../attendance/entities/lesson-session.entity';
import { Book } from '../books/entities/book.entity';
import { AttemptState } from '../exams/entities/attempt-state.enum';
import { Exam } from '../exams/entities/exam.entity';
import { ExamAttempt } from '../exams/entities/exam-attempt.entity';
import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonProgress } from '../lessons/entities/lesson-progress.entity';
import { LessonPackage } from '../packages/entities/lesson-package.entity';
import { LessonPurchase } from '../payments/entities/lesson-purchase.entity';
import { ItemType, Order, OrderStatus, PaymentStatus } from '../payments/entities';
import { LessonReview } from '../reviews/entities/lesson-review.entity';
import { Subject } from '../subjects/entities/subject.entity';
import { TeacherFollowUpService } from '../teacher-follow-up/teacher-follow-up.service';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/entities/user-role.enum';
import { ApplicationCacheService } from '../common/cache/application-cache.service';
import type {
  PlatformReportDto,
  RevenueBreakdownDto,
  StudentProgressReportDto,
  SubjectProgressDto,
  TeacherExamsStatsDto,
  TeacherLessonsStatsDto,
  TeacherReportDto,
  TeacherStudentsStatsDto,
} from './dto';

/**
 * Type definitions for raw query results
 */
interface CountResult {
  count: string | null;
}

interface AvgResult {
  avg: string | null;
}

interface SubjectScoreResult {
  subject_id: string;
  avg_score: string | null;
}

interface DateRange {
  startDate: Date;
  endDate: Date;
}

interface RevenueMinorRow {
  lessons_minor: string | null;
  packages_minor: string | null;
  books_minor: string | null;
}

@Injectable()
export class ReportsService {
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
    @InjectRepository(Order)
    private readonly ordersRepository: Repository<Order>,
    @InjectRepository(ExamAttempt)
    private readonly examAttemptsRepository: Repository<ExamAttempt>,
    @InjectRepository(LessonSession)
    private readonly lessonSessionsRepository: Repository<LessonSession>,
    @InjectRepository(LessonReview)
    private readonly lessonReviewsRepository: Repository<LessonReview>,
    @InjectRepository(LessonProgress)
    private readonly lessonProgressRepository: Repository<LessonProgress>,
    @InjectRepository(Subject)
    private readonly subjectsRepository: Repository<Subject>,
    @InjectRepository(LessonPackage)
    private readonly packagesRepository: Repository<LessonPackage>,
    private readonly applicationCache: ApplicationCacheService,
    private readonly teacherFollowUp: TeacherFollowUpService,
  ) {}

  /**
   * Get teacher report summary with date range filtering
   */
  public async getTeacherReport(
    teacherId: string,
    from?: Date,
    to?: Date,
  ): Promise<TeacherReportDto> {
    const { startDate, endDate } = this.normalizeDateRange(from, to);
    return await this.applicationCache.getOrCompute(
      {
        family: 'teacher_report',
        endpoint: 'reports.teacher',
        scope: `owner:${teacherId}`,
        parts: [teacherId, startDate.toISOString(), endDate.toISOString()],
        ttlMs: 30_000,
      },
      async () => {
        const range = { startDate, endDate };
        const [revenue, students, lessons, exams, followUp] = await Promise.all([
          this.getTeacherRevenueStats(teacherId, range),
          this.getTeacherStudentStats(teacherId, range),
          this.getTeacherLessonStats(teacherId, range),
          this.getTeacherExamStats(teacherId, range),
          this.teacherFollowUp.getAnalyticsSummary(teacherId),
        ]);

        const report: TeacherReportDto = {
          period: {
            from: this.formatDay(startDate),
            to: this.formatDay(endDate),
          },
          revenue,
          students,
          lessons,
          exams,
          guardians: followUp.guardians,
          notifications: followUp.notifications,
          riskStudentCount: followUp.riskStudentCount,
        };

        return report;
      },
    );
  }

  /**
   * Get student progress report
   */
  public async getStudentProgressReport(studentId: string): Promise<StudentProgressReportDto> {
    return await this.applicationCache.getOrCompute(
      {
        family: 'student_report',
        endpoint: 'reports.student-progress',
        scope: `owner:${studentId}`,
        parts: [studentId],
        ttlMs: 30_000,
      },
      async () => {
        const subjects = await this.subjectsRepository.find({
          where: { deleted_at: IsNull() },
        });

        const progressRecords = await this.lessonProgressRepository.find({
          where: { student_id: studentId },
          relations: ['lesson'],
        });

        const scoreBySubject = await this.buildScoreBySubjectMap(studentId);
        const subjectProgress = await this.calculateAllSubjectProgress(
          subjects,
          progressRecords,
          scoreBySubject,
        );

        const { overallProgress, strengths, needsImprovement } =
          this.analyzeStudentProgress(subjectProgress);

        const report: StudentProgressReportDto = {
          overallProgress,
          subjects: subjectProgress,
          strengths,
          needsImprovement,
        };

        return report;
      },
    );
  }

  /**
   * Get platform-wide report with date range filtering (Admin only)
   */
  public async getPlatformReport(from?: Date, to?: Date): Promise<PlatformReportDto> {
    const { startDate, endDate } = this.normalizeDateRange(from, to);
    return await this.applicationCache.getOrCompute(
      {
        family: 'platform_report',
        endpoint: 'reports.platform',
        scope: 'role:admin',
        parts: [startDate.toISOString(), endDate.toISOString()],
        ttlMs: 60_000,
      },
      async () => {
        const range = { startDate, endDate };
        const [users, revenue, content, engagement] = await Promise.all([
          this.getPlatformUserStats(range),
          this.getPlatformRevenueStats(range),
          this.getPlatformContentStats(),
          this.getPlatformEngagementStats(range),
        ]);

        const report: PlatformReportDto = {
          period: {
            from: this.formatDay(startDate),
            to: this.formatDay(endDate),
          },
          users,
          revenue,
          content,
          engagement,
        };

        return report;
      },
    );
  }

  // ====================== TEACHER REPORT HELPERS ======================

  private async getTeacherRevenueStats(
    teacherId: string,
    range: DateRange,
  ): Promise<RevenueBreakdownDto> {
    const { startDate, endDate } = range;
    const row = await this.paidOrderRevenueQuery()
      .andWhere('order.teacher_id = :teacherId', { teacherId })
      .andWhere('order.paid_at BETWEEN :start AND :end', { start: startDate, end: endDate })
      .getRawOne<RevenueMinorRow>();
    const lessons = this.majorFromMinor(row?.lessons_minor);
    const packages = this.majorFromMinor(row?.packages_minor);
    const books = this.majorFromMinor(row?.books_minor);

    return { total: lessons + packages + books, lessons, books, packages };
  }

  private async getTeacherStudentStats(
    teacherId: string,
    range: DateRange,
  ): Promise<TeacherStudentsStatsDto> {
    const { startDate, endDate } = range;

    const totalStudents = await this.lessonPurchasesRepository
      .createQueryBuilder('lp')
      .innerJoin('lp.lesson', 'lesson')
      .where('lesson.teacher_id = :teacherId', { teacherId })
      .select('COUNT(DISTINCT lp.student_id)', 'count')
      .getRawOne<CountResult>();

    const newStudents = await this.lessonPurchasesRepository
      .createQueryBuilder('lp')
      .innerJoin('lp.lesson', 'lesson')
      .where('lesson.teacher_id = :teacherId', { teacherId })
      .andWhere('lp.created_at BETWEEN :start AND :end', {
        start: startDate,
        end: endDate,
      })
      .select('COUNT(DISTINCT lp.student_id)', 'count')
      .getRawOne<CountResult>();

    const activeStudents = await this.lessonSessionsRepository
      .createQueryBuilder('ls')
      .innerJoin('ls.lesson', 'lesson')
      .where('lesson.teacher_id = :teacherId', { teacherId })
      .andWhere('ls.entered_at BETWEEN :start AND :end', {
        start: startDate,
        end: endDate,
      })
      .select('COUNT(DISTINCT ls.student_id)', 'count')
      .getRawOne<CountResult>();

    return {
      total: Number.parseInt(totalStudents?.count ?? '0', 10),
      newInPeriod: Number.parseInt(newStudents?.count ?? '0', 10),
      active: Number.parseInt(activeStudents?.count ?? '0', 10),
    };
  }

  private async getTeacherLessonStats(
    teacherId: string,
    range: DateRange,
  ): Promise<TeacherLessonsStatsDto> {
    const { startDate, endDate } = range;

    const totalLessons = await this.lessonsRepository.count({
      where: { teacher_id: teacherId, deleted_at: IsNull() },
    });

    const totalViews = await this.lessonSessionsRepository
      .createQueryBuilder('ls')
      .innerJoin('ls.lesson', 'lesson')
      .where('lesson.teacher_id = :teacherId', { teacherId })
      .andWhere('ls.entered_at BETWEEN :start AND :end', {
        start: startDate,
        end: endDate,
      })
      .getCount();

    const avgRating = await this.lessonReviewsRepository
      .createQueryBuilder('lr')
      .innerJoin('lr.lesson', 'lesson')
      .where('lesson.teacher_id = :teacherId', { teacherId })
      .select('AVG(lr.rating)', 'avg')
      .getRawOne<AvgResult>();

    return {
      totalLessons,
      totalViews,
      averageRating: this.parseAvgResult(avgRating),
    };
  }

  private async getTeacherExamStats(
    teacherId: string,
    range: DateRange,
  ): Promise<TeacherExamsStatsDto> {
    const { startDate, endDate } = range;

    const totalExams = await this.examsRepository.count({
      where: { teacher_id: teacherId, deleted_at: IsNull() },
    });

    const totalAttempts = await this.examAttemptsRepository
      .createQueryBuilder('ea')
      .innerJoin('ea.exam', 'exam')
      .where('exam.teacher_id = :teacherId', { teacherId })
      .andWhere('ea.created_at BETWEEN :start AND :end', {
        start: startDate,
        end: endDate,
      })
      .getCount();

    const avgScore = await this.examAttemptsRepository
      .createQueryBuilder('ea')
      .innerJoin('ea.exam', 'exam')
      .where('exam.teacher_id = :teacherId', { teacherId })
      .andWhere('ea.state = :state', { state: AttemptState.GRADED })
      .andWhere('ea.created_at BETWEEN :start AND :end', {
        start: startDate,
        end: endDate,
      })
      .select('AVG(ea.score_total)', 'avg')
      .getRawOne<AvgResult>();

    return {
      totalExams,
      totalAttempts,
      averageScore: this.parseAvgResult(avgScore),
    };
  }

  // ====================== STUDENT REPORT HELPERS ======================

  private async buildScoreBySubjectMap(studentId: string): Promise<Map<string, number>> {
    const examScores = await this.examAttemptsRepository
      .createQueryBuilder('ea')
      .innerJoin('ea.exam', 'exam')
      .where('ea.student_id = :studentId', { studentId })
      .andWhere('ea.state = :state', { state: AttemptState.GRADED })
      .select(['exam.subject_id as subject_id', 'AVG(ea.score_total) as avg_score'])
      .groupBy('exam.subject_id')
      .getRawMany<SubjectScoreResult>();

    const scoreBySubject = new Map<string, number>();
    for (const score of examScores) {
      if (score.avg_score !== null) {
        scoreBySubject.set(score.subject_id, Number.parseFloat(score.avg_score));
      }
    }
    return scoreBySubject;
  }

  private async calculateAllSubjectProgress(
    subjects: Subject[],
    progressRecords: LessonProgress[],
    scoreBySubject: Map<string, number>,
  ): Promise<SubjectProgressDto[]> {
    if (subjects.length === 0) return [];

    // Lesson counts for ALL subjects in a single grouped query (avoids one
    // COUNT per subject — an N+1 on the student progress report).
    const countRows = await this.lessonsRepository
      .createQueryBuilder('lesson')
      .select('lesson.subject_id', 'subject_id')
      .addSelect('COUNT(*)', 'count')
      .where('lesson.deleted_at IS NULL')
      .andWhere('lesson.subject_id IN (:...ids)', {
        ids: subjects.map((s) => s.id),
      })
      .groupBy('lesson.subject_id')
      .getRawMany<{ subject_id: string; count: string }>();

    const lessonCountBySubject = new Map<string, number>(
      countRows.map((r) => [r.subject_id, Number.parseInt(r.count, 10)]),
    );

    return subjects.map((subject) => {
      const subjectLessons = lessonCountBySubject.get(subject.id) ?? 0;
      const completedLessons = progressRecords.filter(
        (p) => p.completed && p.lesson.subject_id === subject.id,
      ).length;

      const progressPercent =
        subjectLessons > 0 ? Math.round((completedLessons / subjectLessons) * 100) : 0;

      return {
        subjectId: subject.id,
        subjectName: subject.name,
        lessonsCompleted: completedLessons,
        lessonsTotal: subjectLessons,
        averageScore: scoreBySubject.get(subject.id) ?? null,
        progressPercent,
      };
    });
  }

  private analyzeStudentProgress(subjectProgress: SubjectProgressDto[]): {
    overallProgress: number;
    strengths: string[];
    needsImprovement: string[];
  } {
    let totalProgressSum = 0;
    let subjectsWithProgress = 0;
    const strengths: string[] = [];
    const needsImprovement: string[] = [];

    for (const sp of subjectProgress) {
      if (sp.lessonsTotal > 0) {
        totalProgressSum += sp.progressPercent;
        subjectsWithProgress++;
      }

      this.categorizeSubjectPerformance(sp, strengths, needsImprovement);
    }

    const overallProgress =
      subjectsWithProgress > 0 ? Math.round(totalProgressSum / subjectsWithProgress) : 0;

    return {
      overallProgress,
      strengths: strengths.slice(0, 5),
      needsImprovement: needsImprovement.slice(0, 5),
    };
  }

  private categorizeSubjectPerformance(
    sp: SubjectProgressDto,
    strengths: string[],
    needsImprovement: string[],
  ): void {
    if (sp.averageScore !== null && sp.averageScore >= 80) {
      strengths.push(`${sp.subjectName}: ${sp.averageScore.toFixed(0)}% avg`);
    } else if (sp.averageScore !== null && sp.averageScore < 60) {
      needsImprovement.push(`${sp.subjectName}: ${sp.averageScore.toFixed(0)}% avg (below 60%)`);
    }

    if (sp.progressPercent >= 80 && sp.lessonsTotal > 0) {
      strengths.push(`${sp.subjectName}: ${sp.lessonsCompleted}/${sp.lessonsTotal} lessons`);
    } else if (sp.progressPercent < 30 && sp.lessonsTotal > 5) {
      needsImprovement.push(`${sp.subjectName}: Only ${sp.progressPercent}% progress`);
    }
  }

  // ====================== PLATFORM REPORT HELPERS ======================

  private async getPlatformUserStats(range: DateRange): Promise<{
    totalUsers: number;
    students: number;
    teachers: number;
    admins: number;
    newUsers: number;
    activeUsers: number;
  }> {
    const { startDate, endDate } = range;

    const [totalUsers, students, teachers, admins, newUsers, activeUsersResult] = await Promise.all(
      [
        this.usersRepository.count({ where: { deleted_at: IsNull() } }),
        this.usersRepository.count({
          where: { role: UserRole.STUDENT, deleted_at: IsNull() },
        }),
        this.usersRepository.count({
          where: { role: UserRole.TEACHER, deleted_at: IsNull() },
        }),
        this.usersRepository.count({
          where: { role: UserRole.ADMIN, deleted_at: IsNull() },
        }),
        this.usersRepository.count({
          where: {
            created_at: Between(startDate, endDate),
            deleted_at: IsNull(),
          },
        }),
        this.lessonSessionsRepository
          .createQueryBuilder('ls')
          .where('ls.entered_at BETWEEN :start AND :end', {
            start: startDate,
            end: endDate,
          })
          .select('COUNT(DISTINCT ls.student_id)', 'count')
          .getRawOne<CountResult>(),
      ],
    );

    return {
      totalUsers,
      students,
      teachers,
      admins,
      newUsers,
      activeUsers: Number.parseInt(activeUsersResult?.count ?? '0', 10),
    };
  }

  private async getPlatformRevenueStats(range: DateRange): Promise<{
    totalRevenue: number;
    lessonsRevenue: number;
    booksRevenue: number;
    packagesRevenue: number;
  }> {
    const { startDate, endDate } = range;
    const row = await this.paidOrderRevenueQuery()
      .andWhere('order.paid_at BETWEEN :start AND :end', { start: startDate, end: endDate })
      .getRawOne<RevenueMinorRow>();
    const lessonsRevenue = this.majorFromMinor(row?.lessons_minor);
    const packagesRevenue = this.majorFromMinor(row?.packages_minor);
    const booksRevenue = this.majorFromMinor(row?.books_minor);

    return {
      totalRevenue: lessonsRevenue + packagesRevenue + booksRevenue,
      lessonsRevenue,
      booksRevenue,
      packagesRevenue,
    };
  }

  /** Canonical financial revenue: finalized paid orders, minor units, paid_at. */
  private paidOrderRevenueQuery() {
    return this.ordersRepository
      .createQueryBuilder('order')
      .select(
        `COALESCE(SUM(order.final_amount_minor) FILTER (WHERE order.item_type IN (:lessonType, :lessonSessionType)), 0)`,
        'lessons_minor',
      )
      .addSelect(
        `COALESCE(SUM(order.final_amount_minor) FILTER (WHERE order.item_type = :packageType), 0)`,
        'packages_minor',
      )
      .addSelect(
        `COALESCE(SUM(order.final_amount_minor) FILTER (WHERE order.item_type = :bookType), 0)`,
        'books_minor',
      )
      .where('order.status = :paidStatus', { paidStatus: OrderStatus.PAID })
      .andWhere('order.paid_at IS NOT NULL')
      .andWhere(
        `EXISTS (
          SELECT 1 FROM payments finalized_payment
          WHERE finalized_payment.id = order.payment_id
            AND finalized_payment.status = :completedPaymentStatus
        )`,
      )
      .setParameters({
        lessonType: ItemType.LESSON,
        lessonSessionType: ItemType.LESSON_SESSION,
        packageType: ItemType.PACKAGE,
        bookType: ItemType.BOOK,
        completedPaymentStatus: PaymentStatus.COMPLETED,
      });
  }

  private majorFromMinor(value: string | null | undefined): number {
    return Number(value ?? 0) / 100;
  }

  private async getPlatformContentStats(): Promise<{
    totalLessons: number;
    totalBooks: number;
    totalExams: number;
    totalPackages: number;
  }> {
    const [totalLessons, totalBooks, totalExams, totalPackages] = await Promise.all([
      this.lessonsRepository.count({ where: { deleted_at: IsNull() } }),
      this.booksRepository.count({ where: { deleted_at: IsNull() } }),
      this.examsRepository.count({ where: { deleted_at: IsNull() } }),
      this.packagesRepository.count({ where: { deleted_at: IsNull() } }),
    ]);

    return { totalLessons, totalBooks, totalExams, totalPackages };
  }

  private async getPlatformEngagementStats(range: DateRange): Promise<{
    lessonViews: number;
    examAttempts: number;
    averageSessionDuration: number;
    completionRate: number;
  }> {
    const { startDate, endDate } = range;

    const [lessonViews, examAttempts, avgSessionDuration, completedSessions] = await Promise.all([
      this.lessonSessionsRepository
        .createQueryBuilder('ls')
        .where('ls.entered_at BETWEEN :start AND :end', {
          start: startDate,
          end: endDate,
        })
        .getCount(),
      this.examAttemptsRepository
        .createQueryBuilder('ea')
        .where('ea.created_at BETWEEN :start AND :end', {
          start: startDate,
          end: endDate,
        })
        .getCount(),
      this.lessonSessionsRepository
        .createQueryBuilder('ls')
        .where('ls.entered_at BETWEEN :start AND :end', {
          start: startDate,
          end: endDate,
        })
        .select('AVG(ls.duration_seconds)', 'avg')
        .getRawOne<AvgResult>(),
      this.lessonSessionsRepository
        .createQueryBuilder('ls')
        .where('ls.entered_at BETWEEN :start AND :end', {
          start: startDate,
          end: endDate,
        })
        .andWhere('ls.video_progress_percent >= 90')
        .getCount(),
    ]);

    const completionRate =
      lessonViews > 0 ? Math.round((completedSessions / lessonViews) * 100) : 0;

    return {
      lessonViews,
      examAttempts,
      averageSessionDuration: Math.round(Number.parseFloat(avgSessionDuration?.avg ?? '0')),
      completionRate,
    };
  }

  // ====================== UTILITY HELPERS ======================

  /**
   * The range bounds are local-midnight instants, so `toISOString()` would
   * report the previous day on east-of-UTC servers. Format in local time.
   */
  private formatDay(date: Date): string {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
  }

  private normalizeDateRange(from?: Date, to?: Date): DateRange {
    const endDate = to ?? new Date();
    endDate.setHours(23, 59, 59, 999);

    const startDate = from ?? new Date();
    if (from === undefined) {
      startDate.setDate(startDate.getDate() - 30);
    }
    startDate.setHours(0, 0, 0, 0);

    return { startDate, endDate };
  }

  private parseAvgResult(result: AvgResult | undefined): number | null {
    if (result?.avg === null || result?.avg === undefined) {
      return null;
    }
    return Math.round(Number.parseFloat(result.avg) * 100) / 100;
  }
}
