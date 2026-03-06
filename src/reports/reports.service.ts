import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Cache } from 'cache-manager';
import { Between, IsNull, Repository } from 'typeorm';

import { LessonSession } from '../attendance/entities/lesson-session.entity';
import { Book } from '../books/entities/book.entity';
import { BookPurchase } from '../books/entities/book-purchase.entity';
import { Exam } from '../exams/entities';
import { ExamAttempt } from '../exams/entities/exam-attempt.entity';
import { ExamStatus } from '../exams/entities/exam-status.enum';
import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonProgress } from '../lessons/entities/lesson-progress.entity';
import { LessonPackage } from '../packages/entities/lesson-package.entity';
import { LessonPurchase } from '../payments/entities/lesson-purchase.entity';
import { PackagePurchase } from '../payments/entities/package-purchase.entity';
import { LessonReview } from '../reviews/entities/lesson-review.entity';
import { Subject } from '../subjects/entities/subject.entity';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/entities/user-role.enum';

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
interface SumResult {
  total: string | null;
}

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

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

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
    @InjectRepository(LessonProgress)
    private readonly lessonProgressRepository: Repository<LessonProgress>,
    @InjectRepository(Subject)
    private readonly subjectsRepository: Repository<Subject>,
    @InjectRepository(LessonPackage)
    private readonly packagesRepository: Repository<LessonPackage>,
    @Inject(CACHE_MANAGER)
    private readonly cacheManager: Cache,
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
    const cacheKey = `report:teacher:${teacherId}:${startDate.toISOString()}:${endDate.toISOString()}`;

    const cached = await this.cacheManager.get<TeacherReportDto>(cacheKey);
    if (cached) {
      this.logger.debug(`Cache hit for teacher report: ${teacherId}`);
      return cached;
    }

    const range = { startDate, endDate };
    const [revenue, students, lessons, exams] = await Promise.all([
      this.getTeacherRevenueStats(teacherId, range),
      this.getTeacherStudentStats(teacherId, range),
      this.getTeacherLessonStats(teacherId, range),
      this.getTeacherExamStats(teacherId, range),
    ]);

    const report: TeacherReportDto = {
      period: {
        from: startDate.toISOString().split('T')[0] ?? '',
        to: endDate.toISOString().split('T')[0] ?? '',
      },
      revenue,
      students,
      lessons,
      exams,
    };

    await this.cacheManager.set(cacheKey, report, 300000);
    return report;
  }

  /**
   * Get student progress report
   */
  public async getStudentProgressReport(
    studentId: string,
  ): Promise<StudentProgressReportDto> {
    const cacheKey = `report:student:${studentId}`;

    const cached =
      await this.cacheManager.get<StudentProgressReportDto>(cacheKey);
    if (cached) {
      this.logger.debug(`Cache hit for student report: ${studentId}`);
      return cached;
    }

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

    await this.cacheManager.set(cacheKey, report, 300000);
    return report;
  }

  /**
   * Get platform-wide report with date range filtering (Admin only)
   */
  public async getPlatformReport(
    from?: Date,
    to?: Date,
  ): Promise<PlatformReportDto> {
    const { startDate, endDate } = this.normalizeDateRange(from, to);
    const cacheKey = `report:platform:${startDate.toISOString()}:${endDate.toISOString()}`;

    const cached = await this.cacheManager.get<PlatformReportDto>(cacheKey);
    if (cached) {
      this.logger.debug('Cache hit for platform report');
      return cached;
    }

    const range = { startDate, endDate };
    const [users, revenue, content, engagement] = await Promise.all([
      this.getPlatformUserStats(range),
      this.getPlatformRevenueStats(range),
      this.getPlatformContentStats(),
      this.getPlatformEngagementStats(range),
    ]);

    const report: PlatformReportDto = {
      period: {
        from: startDate.toISOString().split('T')[0] ?? '',
        to: endDate.toISOString().split('T')[0] ?? '',
      },
      users,
      revenue,
      content,
      engagement,
    };

    await this.cacheManager.set(cacheKey, report, 600000);
    return report;
  }

  // ====================== TEACHER REPORT HELPERS ======================

  private async getTeacherRevenueStats(
    teacherId: string,
    range: DateRange,
  ): Promise<RevenueBreakdownDto> {
    const { startDate, endDate } = range;

    const lessonRevenue = await this.lessonPurchasesRepository
      .createQueryBuilder('lp')
      .innerJoin('lp.lesson', 'lesson')
      .where('lesson.teacher_id = :teacherId', { teacherId })
      .andWhere('lp.created_at BETWEEN :start AND :end', {
        start: startDate,
        end: endDate,
      })
      .select('SUM(lp.price_paid)', 'total')
      .getRawOne<SumResult>();

    const packageRevenue = await this.packagePurchasesRepository
      .createQueryBuilder('pp')
      .innerJoin('pp.package', 'package')
      .innerJoin('package.items', 'items')
      .innerJoin('items.lesson', 'lesson')
      .where('lesson.teacher_id = :teacherId', { teacherId })
      .andWhere('pp.created_at BETWEEN :start AND :end', {
        start: startDate,
        end: endDate,
      })
      .select('SUM(pp.price_paid)', 'total')
      .getRawOne<SumResult>();

    const bookRevenue = await this.bookPurchasesRepository
      .createQueryBuilder('bp')
      .innerJoin('bp.book', 'book')
      .where('book.teacher_id = :teacherId', { teacherId })
      .andWhere('bp.created_at BETWEEN :start AND :end', {
        start: startDate,
        end: endDate,
      })
      .select('SUM(bp.price_paid)', 'total')
      .getRawOne<SumResult>();

    const lessons = parseFloat(lessonRevenue?.total ?? '0');
    const packages = parseFloat(packageRevenue?.total ?? '0');
    const books = parseFloat(bookRevenue?.total ?? '0');

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
      .andWhere('ls.enter_time BETWEEN :start AND :end', {
        start: startDate,
        end: endDate,
      })
      .select('COUNT(DISTINCT ls.student_id)', 'count')
      .getRawOne<CountResult>();

    return {
      total: parseInt(totalStudents?.count ?? '0', 10),
      newInPeriod: parseInt(newStudents?.count ?? '0', 10),
      active: parseInt(activeStudents?.count ?? '0', 10),
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
      .andWhere('ls.enter_time BETWEEN :start AND :end', {
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
      .andWhere('ea.status = :status', { status: ExamStatus.GRADED })
      .andWhere('ea.created_at BETWEEN :start AND :end', {
        start: startDate,
        end: endDate,
      })
      .select('AVG(ea.total_score)', 'avg')
      .getRawOne<AvgResult>();

    return {
      totalExams,
      totalAttempts,
      averageScore: this.parseAvgResult(avgScore),
    };
  }

  // ====================== STUDENT REPORT HELPERS ======================

  private async buildScoreBySubjectMap(
    studentId: string,
  ): Promise<Map<string, number>> {
    const examScores = await this.examAttemptsRepository
      .createQueryBuilder('ea')
      .innerJoin('ea.exam', 'exam')
      .where('ea.student_id = :studentId', { studentId })
      .andWhere('ea.status = :status', { status: ExamStatus.GRADED })
      .select([
        'exam.subject_id as subject_id',
        'AVG(ea.total_score) as avg_score',
      ])
      .groupBy('exam.subject_id')
      .getRawMany<SubjectScoreResult>();

    const scoreBySubject = new Map<string, number>();
    for (const score of examScores) {
      if (score.avg_score !== null) {
        scoreBySubject.set(score.subject_id, parseFloat(score.avg_score));
      }
    }
    return scoreBySubject;
  }

  private async calculateAllSubjectProgress(
    subjects: Subject[],
    progressRecords: LessonProgress[],
    scoreBySubject: Map<string, number>,
  ): Promise<SubjectProgressDto[]> {
    const subjectProgress: SubjectProgressDto[] = [];

    for (const subject of subjects) {
      const subjectLessons = await this.lessonsRepository.count({
        where: { subject_id: subject.id, deleted_at: IsNull() },
      });

      const completedLessons = progressRecords.filter(
        (p) => p.completed && p.lesson.subject_id === subject.id,
      ).length;

      const progressPercent =
        subjectLessons > 0
          ? Math.round((completedLessons / subjectLessons) * 100)
          : 0;

      subjectProgress.push({
        subjectId: subject.id,
        subjectName: subject.name,
        lessonsCompleted: completedLessons,
        lessonsTotal: subjectLessons,
        averageScore: scoreBySubject.get(subject.id) ?? null,
        progressPercent,
      });
    }

    return subjectProgress;
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
      subjectsWithProgress > 0
        ? Math.round(totalProgressSum / subjectsWithProgress)
        : 0;

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
      needsImprovement.push(
        `${sp.subjectName}: ${sp.averageScore.toFixed(0)}% avg (below 60%)`,
      );
    }

    if (sp.progressPercent >= 80 && sp.lessonsTotal > 0) {
      strengths.push(
        `${sp.subjectName}: ${sp.lessonsCompleted}/${sp.lessonsTotal} lessons`,
      );
    } else if (sp.progressPercent < 30 && sp.lessonsTotal > 5) {
      needsImprovement.push(
        `${sp.subjectName}: Only ${sp.progressPercent}% progress`,
      );
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

    const [
      totalUsers,
      students,
      teachers,
      admins,
      newUsers,
      activeUsersResult,
    ] = await Promise.all([
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
        .where('ls.enter_time BETWEEN :start AND :end', {
          start: startDate,
          end: endDate,
        })
        .select('COUNT(DISTINCT ls.student_id)', 'count')
        .getRawOne<CountResult>(),
    ]);

    return {
      totalUsers,
      students,
      teachers,
      admins,
      newUsers,
      activeUsers: parseInt(activeUsersResult?.count ?? '0', 10),
    };
  }

  private async getPlatformRevenueStats(range: DateRange): Promise<{
    totalRevenue: number;
    lessonsRevenue: number;
    booksRevenue: number;
    packagesRevenue: number;
  }> {
    const { startDate, endDate } = range;

    const [lessonRevenue, packageRevenue, bookRevenue] = await Promise.all([
      this.lessonPurchasesRepository
        .createQueryBuilder('lp')
        .where('lp.created_at BETWEEN :start AND :end', {
          start: startDate,
          end: endDate,
        })
        .select('SUM(lp.price_paid)', 'total')
        .getRawOne<SumResult>(),
      this.packagePurchasesRepository
        .createQueryBuilder('pp')
        .where('pp.created_at BETWEEN :start AND :end', {
          start: startDate,
          end: endDate,
        })
        .select('SUM(pp.price_paid)', 'total')
        .getRawOne<SumResult>(),
      this.bookPurchasesRepository
        .createQueryBuilder('bp')
        .where('bp.created_at BETWEEN :start AND :end', {
          start: startDate,
          end: endDate,
        })
        .select('SUM(bp.price_paid)', 'total')
        .getRawOne<SumResult>(),
    ]);

    const lessonsRevenue = parseFloat(lessonRevenue?.total ?? '0');
    const packagesRevenue = parseFloat(packageRevenue?.total ?? '0');
    const booksRevenue = parseFloat(bookRevenue?.total ?? '0');

    return {
      totalRevenue: lessonsRevenue + packagesRevenue + booksRevenue,
      lessonsRevenue,
      booksRevenue,
      packagesRevenue,
    };
  }

  private async getPlatformContentStats(): Promise<{
    totalLessons: number;
    totalBooks: number;
    totalExams: number;
    totalPackages: number;
  }> {
    const [totalLessons, totalBooks, totalExams, totalPackages] =
      await Promise.all([
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

    const [lessonViews, examAttempts, avgSessionDuration, completedSessions] =
      await Promise.all([
        this.lessonSessionsRepository
          .createQueryBuilder('ls')
          .where('ls.enter_time BETWEEN :start AND :end', {
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
          .where('ls.enter_time BETWEEN :start AND :end', {
            start: startDate,
            end: endDate,
          })
          .select('AVG(ls.duration_seconds)', 'avg')
          .getRawOne<AvgResult>(),
        this.lessonSessionsRepository
          .createQueryBuilder('ls')
          .where('ls.enter_time BETWEEN :start AND :end', {
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
      averageSessionDuration: Math.round(
        parseFloat(avgSessionDuration?.avg ?? '0'),
      ),
      completionRate,
    };
  }

  // ====================== UTILITY HELPERS ======================

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
    return Math.round(parseFloat(result.avg) * 100) / 100;
  }
}
