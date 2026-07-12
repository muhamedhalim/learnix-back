import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { IsNull, Repository } from 'typeorm';

import { AnalyticsService } from '../../analytics/analytics.service';
import { ExamAnalyticsDto } from '../../analytics/dto';
import { PaginatedResponse, PaginationMeta } from '../../common/interfaces/pagination.interface';
import { biBody } from '../../i18n/error-translator.util';
import { AdminExamFilterDto } from '../dto';
import { AttemptState, Exam, ExamAttempt, ExamStatus } from '../entities';

interface RawExamStatsRow {
  exam_id: string;
  total_attempts: string;
  completed_attempts: string;
  passed_attempts: string;
  average_score: string | null;
  last_activity: Date | null;
}

interface ExamAttemptStats {
  total_attempts: number;
  completed_attempts: number;
  pass_rate: number | null;
  average_score: number | null;
  last_activity: Date | null;
}

export interface AdminExamListItem {
  id: string;
  title: string;
  title_ar: string;
  status: ExamStatus;
  total_marks: number;
  passing_marks: number;
  teacher: { id: string; name: string };
  subject: { id: string; name: string };
  total_attempts: number;
  completed_attempts: number;
  pass_rate: number | null;
  average_score: number | null;
  last_activity: Date | null;
  created_at: Date;
}

export type AdminExamDetail = AdminExamListItem & ExamAnalyticsDto;

/**
 * Admin-wide exam oversight: lists/aggregates exams across ALL teachers (unlike
 * `ExamAuthoringService.listExams`, which is teacher-scoped). Per-exam detail
 * analytics are delegated to the existing, cache-backed `AnalyticsService` —
 * this service only adds the bulk (list-page) aggregation that doesn't exist
 * anywhere else, computed in one grouped query to avoid N+1.
 */
@Injectable()
export class AdminExamsService {
  constructor(
    @InjectRepository(Exam) private readonly exams: Repository<Exam>,
    @InjectRepository(ExamAttempt) private readonly attempts: Repository<ExamAttempt>,
    private readonly analytics: AnalyticsService,
  ) {}

  public async list(filter: AdminExamFilterDto): Promise<PaginatedResponse<AdminExamListItem>> {
    const page = filter.page ?? 1;
    const limit = filter.limit ?? 20;
    const qb = this.exams
      .createQueryBuilder('exam')
      .leftJoinAndSelect('exam.teacher', 'teacher')
      .leftJoinAndSelect('exam.subject', 'subject')
      .where('exam.deleted_at IS NULL');

    if (filter.subject_id)
      qb.andWhere('exam.subject_id = :subjectId', { subjectId: filter.subject_id });
    if (filter.teacher_id)
      qb.andWhere('exam.teacher_id = :teacherId', { teacherId: filter.teacher_id });
    if (filter.status) qb.andWhere('exam.status = :status', { status: filter.status });
    if (filter.search !== undefined && filter.search !== '') {
      qb.andWhere('(exam.title ILIKE :q OR exam.title_ar ILIKE :q)', { q: `%${filter.search}%` });
    }
    if (filter.date_from)
      qb.andWhere('exam.created_at >= :dateFrom', { dateFrom: filter.date_from });
    if (filter.date_to) qb.andWhere('exam.created_at <= :dateTo', { dateTo: filter.date_to });

    qb.orderBy(`exam.${filter.sort_by ?? 'created_at'}`, filter.sort_order ?? 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [exams, total] = await qb.getManyAndCount();
    const stats = await this.getAttemptStats(exams.map((e) => e.id));
    const data = exams.map((exam) => this.toListItem(exam, stats.get(exam.id)));
    return { data, meta: this.meta(total, page, limit) };
  }

  public async getOne(examId: string): Promise<AdminExamDetail> {
    const exam = await this.exams.findOne({
      where: { id: examId, deleted_at: IsNull() },
      relations: ['teacher', 'subject'],
    });
    if (!exam) throw new NotFoundException(biBody('Exam not found', 'الاختبار غير موجود'));

    const stats = await this.getAttemptStats([examId]);
    const listItem = this.toListItem(exam, stats.get(examId));
    const analytics = await this.analytics.getExamAnalytics(examId);
    return { ...listItem, ...analytics };
  }

  // ---- helpers ----

  /** One grouped query for every exam id on the current page — avoids N+1. */
  private async getAttemptStats(examIds: string[]): Promise<Map<string, ExamAttemptStats>> {
    const map = new Map<string, ExamAttemptStats>();
    if (examIds.length === 0) return map;

    // AttemptState.GRADED is a compile-time enum constant (not user input), so
    // inlining it into the FILTER clauses is safe — TypeORM's addSelect/select
    // don't register :named parameters the way where()/andWhere() do.
    const rows = await this.attempts
      .createQueryBuilder('ea')
      .innerJoin(Exam, 'e', 'e.id = ea.exam_id')
      .select('ea.exam_id', 'exam_id')
      .addSelect('COUNT(*)', 'total_attempts')
      .addSelect(
        `COUNT(*) FILTER (WHERE ea.state = '${AttemptState.GRADED}')`,
        'completed_attempts',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE ea.state = '${AttemptState.GRADED}' AND ea.score_total >= e.passing_marks)`,
        'passed_attempts',
      )
      .addSelect(
        `AVG(ea.score_total) FILTER (WHERE ea.state = '${AttemptState.GRADED}')`,
        'average_score',
      )
      .addSelect('MAX(ea.updated_at)', 'last_activity')
      .where('ea.exam_id IN (:...examIds)', { examIds })
      .groupBy('ea.exam_id')
      .getRawMany<RawExamStatsRow>();

    for (const row of rows) {
      const totalAttempts = Number.parseInt(row.total_attempts, 10);
      const completedAttempts = Number.parseInt(row.completed_attempts, 10);
      const passedAttempts = Number.parseInt(row.passed_attempts, 10);
      map.set(row.exam_id, {
        total_attempts: totalAttempts,
        completed_attempts: completedAttempts,
        pass_rate:
          completedAttempts > 0
            ? Math.round((passedAttempts / completedAttempts) * 100 * 100) / 100
            : null,
        average_score:
          row.average_score !== null
            ? Math.round(Number.parseFloat(row.average_score) * 100) / 100
            : null,
        last_activity: row.last_activity,
      });
    }
    return map;
  }

  private toListItem(exam: Exam, stats: ExamAttemptStats | undefined): AdminExamListItem {
    return {
      id: exam.id,
      title: exam.title,
      title_ar: exam.title_ar,
      status: exam.status,
      total_marks: exam.total_marks,
      passing_marks: exam.passing_marks,
      teacher: { id: exam.teacher.id, name: exam.teacher.name },
      subject: { id: exam.subject.id, name: exam.subject.name },
      total_attempts: stats?.total_attempts ?? 0,
      completed_attempts: stats?.completed_attempts ?? 0,
      pass_rate: stats?.pass_rate ?? null,
      average_score: stats?.average_score ?? null,
      last_activity: stats?.last_activity ?? null,
      created_at: exam.created_at,
    };
  }

  private meta(total: number, page: number, limit: number): PaginationMeta {
    const totalPages = Math.ceil(total / limit);
    return {
      total,
      page,
      limit,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };
  }
}
