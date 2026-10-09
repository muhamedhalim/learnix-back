import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository, SelectQueryBuilder } from 'typeorm';

import { PaginationMeta } from '../common/interfaces/pagination.interface';
import { biBody } from '../i18n/error-translator.util';
import { User } from '../users/entities/user.entity';
import { GradeHomeworkDto } from './dto/homework.dto';
import {
  TeacherHomeworkAnalyticsDto,
  TeacherHomeworkFilterDto,
  TeacherHomeworkSubmissionFilterDto,
} from './dto/teacher-homework.dto';
import { HomeworkSubmission } from './entities/homework-submission.entity';
import { LessonHomework } from './entities/lesson-homework.entity';
import { LessonContentService } from './lesson-content.service';

type HomeworkStats = {
  homework_id: string;
  targeted_students: number;
  submission_count: number;
  late_submission_count: number;
  ungraded_submission_count: number;
  graded_submission_count: number;
  average_score: number | null;
  highest_score: number | null;
  lowest_score: number | null;
};

type RawStats = {
  homework_id: unknown;
  targeted_students?: unknown;
  submission_count?: unknown;
  late_submission_count?: unknown;
  ungraded_submission_count?: unknown;
  graded_submission_count?: unknown;
  average_score?: unknown;
  highest_score?: unknown;
  lowest_score?: unknown;
};

type SubmissionDetailRow = {
  submission_id: string;
  homework_id: string;
  answer_text: string | null;
  answers: unknown;
  submission_status: string;
  is_late: boolean;
  score: unknown;
  feedback: string | null;
  submitted_at: string;
  graded_at: string | null;
  updated_at: string;
  has_resource: string | null;
  resource_filename: string | null;
  student_id: string;
  student_name: string;
  student_identifier: string;
};

type SubmissionRosterRaw = {
  student_id: string;
  student_name: string;
  student_identifier: string;
  submission_id: string | null;
  submission_status: string | null;
  is_late: string | boolean | null;
  score: string | null;
  submitted_at: string | null;
  graded_at: string | null;
  updated_at: string | null;
};

type ScoreDistributionRow = { lower_bound: unknown; upper_bound: unknown; count: unknown };
type StudentPerformanceRow = {
  student_id: string;
  student_name: string;
  student_identifier: string;
  assigned_homework_count: unknown;
  submitted_homework_count: unknown;
  missing_homework_count: unknown;
  late_homework_count: unknown;
  graded_homework_count: unknown;
  average_score: unknown;
};

/**
 * Teacher-wide homework reporting and review. It intentionally delegates all
 * mutation and private-object authorization to LessonContentService so there
 * remains exactly one homework/submission business flow.
 */
@Injectable()
export class TeacherHomeworkService {
  constructor(
    @InjectRepository(LessonHomework)
    private readonly homeworkRepository: Repository<LessonHomework>,
    @InjectRepository(HomeworkSubmission)
    private readonly submissionsRepository: Repository<HomeworkSubmission>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly lessonContent: LessonContentService,
  ) {}

  public async dashboard(teacherId: string): Promise<Record<string, unknown>> {
    const homework = await this.ownedHomeworkQuery(teacherId).getMany();
    const stats = await this.getHomeworkStats(homework.map((row) => row.id));
    const statByHomework = new Map(stats.map((row) => [row.homework_id, row]));
    const now = new Date();
    const approaching = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    let targetedStudents = 0;
    let submitted = 0;
    let graded = 0;
    let late = 0;
    let ungraded = 0;
    let scoreTotal = 0;
    let scored = 0;
    for (const item of homework) {
      const row = statByHomework.get(item.id) ?? this.emptyStats(item.id);
      targetedStudents += row.targeted_students;
      submitted += row.submission_count;
      graded += row.graded_submission_count;
      late += row.late_submission_count;
      ungraded += row.ungraded_submission_count;
      if (row.average_score !== null) {
        scoreTotal += row.average_score * row.graded_submission_count;
        scored += row.graded_submission_count;
      }
    }

    return {
      total_published: homework.filter((item) => item.published_at !== null).length,
      draft_homework: homework.filter((item) => item.published_at === null).length,
      active_homework: homework.filter(
        (item) => item.published_at !== null && (item.due_at === null || item.due_at >= now),
      ).length,
      closed_homework: homework.filter(
        (item) => item.published_at !== null && item.due_at !== null && item.due_at < now,
      ).length,
      submissions_awaiting_grading: ungraded,
      graded_submissions: graded,
      late_submissions: late,
      students_not_submitted: Math.max(0, targetedStudents - submitted),
      average_homework_score: scored > 0 ? this.round(scoreTotal / scored) : null,
      homework_approaching_deadline: homework.filter(
        (item) =>
          item.published_at !== null &&
          item.due_at !== null &&
          item.due_at >= now &&
          item.due_at <= approaching,
      ).length,
    };
  }

  public async list(
    teacherId: string,
    filter: TeacherHomeworkFilterDto,
  ): Promise<{ data: Record<string, unknown>[]; meta: PaginationMeta }> {
    const qb = this.ownedHomeworkQuery(teacherId);
    this.applyHomeworkFilters(qb, filter, teacherId);
    const total = await qb.getCount();
    const order = filter.order?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    if (filter.sort_by === 'submission_count') {
      // Keep aggregate ordering in PostgreSQL. Sorting the already-paginated
      // response would make later pages appear out of order.
      qb.addSelect(
        '(SELECT COUNT(*) FROM homework_submissions submission WHERE submission.homework_id = homework.id)',
        'homework_submission_count',
      ).orderBy('homework_submission_count', order);
    } else if (filter.sort_by === 'average_score') {
      qb.addSelect(
        "(SELECT AVG(submission.score) FROM homework_submissions submission WHERE submission.homework_id = homework.id AND submission.status = 'graded')",
        'homework_average_score',
      ).orderBy('homework_average_score', order, 'NULLS LAST');
    } else if (filter.sort_by === 'due_at') {
      qb.orderBy('homework.due_at', order, 'NULLS LAST');
    } else {
      qb.orderBy('homework.created_at', order);
    }
    const homework = await qb
      .addOrderBy('homework.id', order)
      .skip((filter.page - 1) * filter.limit)
      .take(filter.limit)
      .getMany();
    const stats = await this.getHomeworkStats(homework.map((row) => row.id));
    const statByHomework = new Map(stats.map((row) => [row.homework_id, row]));
    const packageNames = await this.getPackageNames(
      homework.map((row) => row.lesson_id),
      teacherId,
    );

    const rows = homework.map((item) =>
      this.toHomeworkResponse(
        item,
        statByHomework.get(item.id),
        packageNames.get(item.lesson_id) ?? [],
      ),
    );
    return { data: rows, meta: this.pageMeta(filter.page, filter.limit, total) };
  }

  public async detail(teacherId: string, homeworkId: string): Promise<Record<string, unknown>> {
    const homework = await this.findOwnedHomework(teacherId, homeworkId);
    const [stats] = await this.getHomeworkStats([homework.id]);
    const packageNames = await this.getPackageNames([homework.lesson_id], teacherId);
    return this.toHomeworkResponse(homework, stats, packageNames.get(homework.lesson_id) ?? []);
  }

  public async listSubmissions(
    teacherId: string,
    homeworkId: string,
    filter: TeacherHomeworkSubmissionFilterDto,
  ): Promise<{ data: Record<string, unknown>[]; meta: PaginationMeta }> {
    const homework = await this.findOwnedHomework(teacherId, homeworkId);
    const qb = this.submissionRosterQuery(homework);
    this.applySubmissionFilters(qb, filter);
    const total = await qb.getCount();
    const order = filter.order?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
    const sortColumn = {
      submitted_at: 'submission.submitted_at',
      student_name: 'student.name',
      score: 'submission.score',
      late: 'submission.is_late',
    }[filter.sort_by ?? 'submitted_at'];
    if (filter.sort_by === 'submitted_at') qb.orderBy(sortColumn, order, 'NULLS LAST');
    else qb.orderBy(sortColumn, order);
    const data = await qb
      .select([
        'student.id AS student_id',
        'student.name AS student_name',
        'student.username AS student_identifier',
        'submission.id AS submission_id',
        'submission.status AS submission_status',
        'submission.is_late AS is_late',
        'submission.score AS score',
        'submission.submitted_at AS submitted_at',
        'submission.graded_at AS graded_at',
        'submission.updated_at AS updated_at',
      ])
      .addOrderBy('student.id', 'ASC')
      .skip((filter.page - 1) * filter.limit)
      .take(filter.limit)
      .getRawMany<SubmissionRosterRaw>();

    return {
      data: data.map((row) => this.toSubmissionRosterResponse(row, homework)),
      meta: this.pageMeta(filter.page, filter.limit, total),
    };
  }

  public async submissionDetail(
    teacherId: string,
    homeworkId: string,
    submissionId: string,
  ): Promise<Record<string, unknown>> {
    const homework = await this.findOwnedHomework(teacherId, homeworkId);
    const row = await this.submissionsRepository
      .createQueryBuilder('submission')
      .innerJoin('submission.student', 'student')
      .where('submission.id = :submissionId', { submissionId })
      .andWhere('submission.homework_id = :homeworkId', { homeworkId })
      .andWhere(`submission.student_id IN (${this.audienceSql(':lessonId')})`)
      .setParameters({ lessonId: homework.lesson_id, accessNow: new Date() })
      .select([
        'submission.id AS submission_id',
        'submission.homework_id AS homework_id',
        'submission.answer_text AS answer_text',
        'submission.answers AS answers',
        'submission.status AS submission_status',
        'submission.is_late AS is_late',
        'submission.score AS score',
        'submission.feedback AS feedback',
        'submission.submitted_at AS submitted_at',
        'submission.graded_at AS graded_at',
        'submission.updated_at AS updated_at',
        'submission.resource_url AS has_resource',
        'submission.resource_filename AS resource_filename',
        'student.id AS student_id',
        'student.name AS student_name',
        'student.username AS student_identifier',
      ])
      .getRawOne<SubmissionDetailRow>();
    if (!row) {
      throw new NotFoundException(
        biBody('Homework submission not found', 'إجابة الواجب غير موجودة'),
      );
    }
    return {
      homework: {
        id: homework.id,
        lesson_id: homework.lesson_id,
        lesson_title: homework.lesson.title,
        title: homework.title,
        title_ar: homework.title_ar,
        description: homework.description,
        description_ar: homework.description_ar,
        questions: homework.questions,
        max_score: Number(homework.max_score),
        due_at: homework.due_at,
      },
      submission: {
        id: row.submission_id,
        student: {
          id: row.student_id,
          name: row.student_name,
          identifier: row.student_identifier,
        },
        answer_text: row.answer_text,
        answers: row.answers,
        status: row.submission_status,
        grading_status: row.submission_status === 'graded' ? 'graded' : 'awaiting_grading',
        is_late: this.toBoolean(row.is_late),
        score: this.toNullableNumber(row.score),
        feedback: row.feedback,
        submitted_at: row.submitted_at,
        graded_at: row.graded_at,
        updated_at: row.updated_at,
        file_download_url: row.has_resource
          ? `/api/v1/teacher/homework/${homeworkId}/submissions/${submissionId}/file`
          : null,
        file_name: row.resource_filename ?? 'homework-submission',
      },
    };
  }

  public async grade(
    teacherId: string,
    homeworkId: string,
    submissionId: string,
    dto: GradeHomeworkDto,
  ): Promise<Record<string, unknown>> {
    const homework = await this.findOwnedHomework(teacherId, homeworkId);
    await this.assertSubmissionInAudience(homework, submissionId);
    const submission = await this.lessonContent.gradeHomework(
      homework.lesson_id,
      homeworkId,
      submissionId,
      teacherId,
      dto,
    );
    return {
      id: submission.id,
      status: submission.status,
      grading_status: 'graded',
      score: Number(submission.score),
      feedback: submission.feedback,
      graded_at: submission.graded_at,
      max_score: Number(homework.max_score),
    };
  }

  public async analytics(
    teacherId: string,
    filter: TeacherHomeworkAnalyticsDto,
  ): Promise<Record<string, unknown>> {
    const homeworkQuery = this.ownedHomeworkQuery(teacherId);
    if (filter.homework_id)
      homeworkQuery.andWhere('homework.id = :homeworkId', { homeworkId: filter.homework_id });
    if (filter.lesson_id)
      homeworkQuery.andWhere('homework.lesson_id = :lessonId', { lessonId: filter.lesson_id });
    if (filter.package_id) {
      homeworkQuery.andWhere(
        `EXISTS (SELECT 1 FROM lesson_package_items lpi WHERE lpi.lesson_id = homework.lesson_id AND lpi.package_id = :packageId)`,
        { packageId: filter.package_id },
      );
    }
    if (filter.from)
      homeworkQuery.andWhere('homework.created_at >= :from', { from: new Date(filter.from) });
    if (filter.to)
      homeworkQuery.andWhere('homework.created_at <= :to', { to: new Date(filter.to) });
    const homework = await homeworkQuery.getMany();
    const homeworkIds = homework.map((row) => row.id);
    const stats = await this.getHomeworkStats(homeworkIds);
    const statByHomework = new Map(stats.map((row) => [row.homework_id, row]));
    // Everything below depends only on the homework id list (and the optional
    // student), not on each other: run it as one wave instead of five sequential
    // round trips. Every statement and its result are unchanged.
    const [
      filteredStats,
      scoreDistribution,
      { medianScore, belowPass },
      studentPerformance,
      performanceTrend,
      packageNames,
    ] = await Promise.all([
      filter.student_id
        ? this.getHomeworkStatsForStudent(homeworkIds, filter.student_id)
        : Promise.resolve(stats),
      this.scoreDistribution(homeworkIds, filter.student_id),
      this.medianAndBelowPass(homeworkIds, filter.student_id, filter.pass_threshold),
      this.studentPerformance(homeworkIds, filter.student_id),
      this.performanceTrend(homeworkIds, filter.student_id),
      this.getPackageNames(
        homework.map((row) => row.lesson_id),
        teacherId,
      ),
    ]);
    const resultStats = filter.student_id ? filteredStats : stats;
    const targeted = resultStats.reduce((sum, row) => sum + row.targeted_students, 0);
    const submitted = resultStats.reduce((sum, row) => sum + row.submission_count, 0);
    const graded = resultStats.reduce((sum, row) => sum + row.graded_submission_count, 0);
    const late = resultStats.reduce((sum, row) => sum + row.late_submission_count, 0);
    const scored = resultStats.filter((row) => row.average_score !== null);
    const weightedScore = resultStats.reduce(
      (sum, row) => sum + (row.average_score ?? 0) * row.graded_submission_count,
      0,
    );
    const scoreCount = resultStats.reduce((sum, row) => sum + row.graded_submission_count, 0);

    return {
      overview: {
        targeted_students: targeted,
        submissions: submitted,
        submission_rate: this.percent(submitted, targeted),
        missing_submissions: Math.max(0, targeted - submitted),
        missing_submission_rate: this.percent(Math.max(0, targeted - submitted), targeted),
        late_submissions: late,
        late_submission_rate: this.percent(late, submitted),
        grading_completion_rate: this.percent(graded, submitted),
        average_score: scoreCount > 0 ? this.round(weightedScore / scoreCount) : null,
        median_score: medianScore,
        highest_score: scored.length
          ? Math.max(...scored.map((row) => row.highest_score ?? 0))
          : null,
        lowest_score: scored.length
          ? Math.min(...scored.map((row) => row.lowest_score ?? 0))
          : null,
        below_pass_threshold: belowPass,
        below_pass_threshold_rate: this.percent(belowPass, scoreCount),
        pass_threshold: filter.pass_threshold,
        per_question_available: false,
        per_question_reason:
          'Homework questions currently store student responses but no per-question grades.',
      },
      score_distribution: scoreDistribution,
      by_homework: homework.map((item) => ({
        ...this.toHomeworkResponse(
          item,
          statByHomework.get(item.id),
          packageNames.get(item.lesson_id) ?? [],
        ),
        ...(filter.student_id
          ? {
              student_metrics:
                resultStats.find((row) => row.homework_id === item.id) ?? this.emptyStats(item.id),
            }
          : {}),
      })),
      student_performance: studentPerformance,
      performance_trend: performanceTrend,
      question_performance: [],
    };
  }

  public async getHomeworkResource(teacherId: string, homeworkId: string) {
    const homework = await this.findOwnedHomework(teacherId, homeworkId);
    return {
      object: await this.lessonContent.getHomeworkResourceForTeacher(
        teacherId,
        homework.lesson_id,
        homework.id,
      ),
      filename: homework.resource_filename ?? 'homework-resource',
    };
  }

  public async getSubmissionFile(teacherId: string, homeworkId: string, submissionId: string) {
    const homework = await this.findOwnedHomework(teacherId, homeworkId);
    await this.assertSubmissionInAudience(homework, submissionId);
    const submission = await this.submissionsRepository.findOne({
      where: { id: submissionId, homework_id: homeworkId },
      select: { id: true, resource_filename: true },
    });
    return {
      object: await this.lessonContent.getSubmissionFileForTeacher(
        teacherId,
        homework.lesson_id,
        homework.id,
        submissionId,
      ),
      filename: submission?.resource_filename ?? 'homework-submission',
    };
  }

  private ownedHomeworkQuery(teacherId: string): SelectQueryBuilder<LessonHomework> {
    return this.homeworkRepository
      .createQueryBuilder('homework')
      .innerJoinAndSelect('homework.lesson', 'lesson')
      .where('lesson.teacher_id = :teacherId', { teacherId })
      .andWhere('homework.deleted_at IS NULL');
  }

  private async findOwnedHomework(teacherId: string, homeworkId: string): Promise<LessonHomework> {
    const homework = await this.ownedHomeworkQuery(teacherId)
      .andWhere('homework.id = :homeworkId', { homeworkId })
      .getOne();
    if (!homework) {
      // A 404 for foreign IDs prevents a teacher from probing another teacher's work.
      throw new NotFoundException(biBody('Homework not found', 'الواجب غير موجود'));
    }
    return homework;
  }

  private applyHomeworkFilters(
    qb: SelectQueryBuilder<LessonHomework>,
    filter: TeacherHomeworkFilterDto,
    teacherId: string,
  ): void {
    if (filter.search?.trim()) {
      qb.andWhere('(homework.title ILIKE :search OR homework.title_ar ILIKE :search)', {
        search: `%${filter.search.trim()}%`,
      });
    }
    if (filter.lesson_id)
      qb.andWhere('homework.lesson_id = :lessonId', { lessonId: filter.lesson_id });
    if (filter.package_id) {
      qb.andWhere(
        `EXISTS (
          SELECT 1 FROM lesson_package_items lpi
          INNER JOIN lesson_packages package ON package.id = lpi.package_id
          WHERE lpi.lesson_id = homework.lesson_id
            AND lpi.package_id = :packageId
            AND package.teacher_id = :teacherId
            AND package.deleted_at IS NULL
        )`,
        { packageId: filter.package_id, teacherId },
      );
    }
    const now = new Date();
    if (filter.status === 'draft') qb.andWhere('homework.published_at IS NULL');
    if (filter.status === 'active') {
      qb.andWhere('homework.published_at IS NOT NULL').andWhere(
        '(homework.due_at IS NULL OR homework.due_at >= :now)',
        { now },
      );
    }
    if (filter.status === 'closed') {
      qb.andWhere('homework.published_at IS NOT NULL').andWhere('homework.due_at < :now', { now });
    }
    if (filter.due_from)
      qb.andWhere('homework.due_at >= :dueFrom', { dueFrom: new Date(filter.due_from) });
    if (filter.due_to) qb.andWhere('homework.due_at <= :dueTo', { dueTo: new Date(filter.due_to) });
    if (filter.needs_grading) {
      qb.andWhere(
        `EXISTS (SELECT 1 FROM homework_submissions submission WHERE submission.homework_id = homework.id AND submission.status = 'submitted')`,
      );
    }
    if (filter.submission_filter === 'graded') {
      qb.andWhere(
        `EXISTS (SELECT 1 FROM homework_submissions submission WHERE submission.homework_id = homework.id AND submission.status = 'graded')`,
      );
    }
    if (filter.submission_filter === 'late') {
      qb.andWhere(
        `EXISTS (SELECT 1 FROM homework_submissions submission WHERE submission.homework_id = homework.id AND submission.is_late = true)`,
      );
    }
    if (filter.submission_filter === 'missing') {
      qb.andWhere(
        `EXISTS (
          SELECT 1 FROM (${this.audienceSql('homework.lesson_id')}) audience
          WHERE NOT EXISTS (
            SELECT 1 FROM homework_submissions submission
            WHERE submission.homework_id = homework.id AND submission.student_id = audience.student_id
          )
        )`,
      ).setParameter('accessNow', now);
    }
  }

  private submissionRosterQuery(homework: LessonHomework): SelectQueryBuilder<User> {
    return this.usersRepository
      .createQueryBuilder('student')
      .leftJoin(
        'homework_submissions',
        'submission',
        'submission.homework_id = :homeworkId AND submission.student_id = student.id',
        { homeworkId: homework.id },
      )
      .where(`student.id IN (${this.audienceSql(':lessonId')})`)
      .andWhere('student.deleted_at IS NULL')
      .setParameters({ lessonId: homework.lesson_id, accessNow: new Date() });
  }

  private async assertSubmissionInAudience(
    homework: LessonHomework,
    submissionId: string,
  ): Promise<void> {
    const submission = await this.submissionsRepository
      .createQueryBuilder('submission')
      .where('submission.id = :submissionId', { submissionId })
      .andWhere('submission.homework_id = :homeworkId', { homeworkId: homework.id })
      .andWhere(`submission.student_id IN (${this.audienceSql(':lessonId')})`)
      .setParameters({ lessonId: homework.lesson_id, accessNow: new Date() })
      .select('submission.id')
      .getOne();
    if (!submission) {
      throw new NotFoundException(
        biBody('Homework submission not found', 'إجابة الواجب غير موجودة'),
      );
    }
  }

  private applySubmissionFilters(
    qb: SelectQueryBuilder<User>,
    filter: TeacherHomeworkSubmissionFilterDto,
  ): void {
    if (filter.search?.trim()) {
      qb.andWhere('(student.name ILIKE :search OR student.username ILIKE :search)', {
        search: `%${filter.search.trim()}%`,
      });
    }
    if (filter.status === 'not_submitted') qb.andWhere('submission.id IS NULL');
    if (filter.status === 'submitted') qb.andWhere("submission.status = 'submitted'");
    if (filter.status === 'graded') qb.andWhere("submission.status = 'graded'");
    if (filter.late !== undefined) qb.andWhere('submission.is_late = :late', { late: filter.late });
    if (filter.min_score !== undefined)
      qb.andWhere('submission.score >= :minScore', { minScore: filter.min_score });
    if (filter.max_score !== undefined)
      qb.andWhere('submission.score <= :maxScore', { maxScore: filter.max_score });
  }

  /** Active lesson access, expressed once for aggregate and roster queries. */
  private audienceSql(lessonIdExpression: string, accessNowParameter = ':accessNow'): string {
    return `
      SELECT DISTINCT audience.student_id
      FROM (
        SELECT purchase.student_id
        FROM lesson_purchases purchase
        WHERE purchase.lesson_id = ${lessonIdExpression}
          AND purchase.revoked_at IS NULL
          AND purchase.access_expires_at > ${accessNowParameter}
      ) audience
    `;
  }

  private async getHomeworkStats(homeworkIds: string[]): Promise<HomeworkStats[]> {
    if (homeworkIds.length === 0) return [];
    const rows = await this.homeworkRepository.query(
      `
      SELECT
        homework.id AS homework_id,
        COUNT(DISTINCT audience.student_id)::int AS targeted_students,
        COUNT(DISTINCT submission.id)::int AS submission_count,
        COUNT(DISTINCT submission.id) FILTER (WHERE submission.is_late = true)::int AS late_submission_count,
        COUNT(DISTINCT submission.id) FILTER (WHERE submission.status = 'submitted')::int AS ungraded_submission_count,
        COUNT(DISTINCT submission.id) FILTER (WHERE submission.status = 'graded')::int AS graded_submission_count,
        AVG(submission.score) FILTER (WHERE submission.status = 'graded') AS average_score,
        MAX(submission.score) FILTER (WHERE submission.status = 'graded') AS highest_score,
        MIN(submission.score) FILTER (WHERE submission.status = 'graded') AS lowest_score
      FROM lesson_homework homework
      LEFT JOIN LATERAL (${this.audienceSql('homework.lesson_id', '$2')}) audience ON true
      LEFT JOIN homework_submissions submission
        ON submission.homework_id = homework.id AND submission.student_id = audience.student_id
      WHERE homework.id = ANY($1::uuid[])
      GROUP BY homework.id
      `,
      [homeworkIds, new Date()],
    );
    return rows.map((row: RawStats) => this.toStats(row));
  }

  private async getHomeworkStatsForStudent(
    homeworkIds: string[],
    studentId: string,
  ): Promise<HomeworkStats[]> {
    if (homeworkIds.length === 0) return [];
    const rows = await this.homeworkRepository.query(
      `
      SELECT
        homework.id AS homework_id,
        COUNT(DISTINCT audience.student_id)::int AS targeted_students,
        COUNT(DISTINCT submission.id)::int AS submission_count,
        COUNT(DISTINCT submission.id) FILTER (WHERE submission.is_late = true)::int AS late_submission_count,
        COUNT(DISTINCT submission.id) FILTER (WHERE submission.status = 'submitted')::int AS ungraded_submission_count,
        COUNT(DISTINCT submission.id) FILTER (WHERE submission.status = 'graded')::int AS graded_submission_count,
        AVG(submission.score) FILTER (WHERE submission.status = 'graded') AS average_score,
        MAX(submission.score) FILTER (WHERE submission.status = 'graded') AS highest_score,
        MIN(submission.score) FILTER (WHERE submission.status = 'graded') AS lowest_score
      FROM lesson_homework homework
      LEFT JOIN LATERAL (${this.audienceSql('homework.lesson_id', '$3')}) audience
        ON audience.student_id = $2::uuid
      LEFT JOIN homework_submissions submission
        ON submission.homework_id = homework.id AND submission.student_id = audience.student_id
      WHERE homework.id = ANY($1::uuid[])
      GROUP BY homework.id
      `,
      [homeworkIds, studentId, new Date()],
    );
    return rows.map((row: RawStats) => this.toStats(row));
  }

  private async getPackageNames(
    lessonIds: string[],
    teacherId: string,
  ): Promise<Map<string, Array<{ id: string; title: string; title_ar: string | null }>>> {
    if (lessonIds.length === 0) return new Map();
    const rows = await this.homeworkRepository.query(
      `
      SELECT item.lesson_id, package.id, package.title, package.title_ar
      FROM lesson_package_items item
      INNER JOIN lesson_packages package ON package.id = item.package_id
      WHERE item.lesson_id = ANY($1::uuid[])
        AND package.teacher_id = $2::uuid
        AND package.deleted_at IS NULL
      ORDER BY package.title ASC
      `,
      [lessonIds, teacherId],
    );
    const map = new Map<string, Array<{ id: string; title: string; title_ar: string | null }>>();
    for (const row of rows as Array<{
      lesson_id: string;
      id: string;
      title: string;
      title_ar: string | null;
    }>) {
      const values = map.get(row.lesson_id) ?? [];
      values.push({ id: row.id, title: row.title, title_ar: row.title_ar });
      map.set(row.lesson_id, values);
    }
    return map;
  }

  private async scoreDistribution(
    homeworkIds: string[],
    studentId?: string,
  ): Promise<Array<{ lower_bound: number; upper_bound: number; count: number }>> {
    if (homeworkIds.length === 0) return [];
    const rows = await this.submissionsRepository.query(
      `
      SELECT
        FLOOR((submission.score / NULLIF(homework.max_score, 0)) * 5) * 20 AS lower_bound,
        LEAST(FLOOR((submission.score / NULLIF(homework.max_score, 0)) * 5) * 20 + 19.99, 100) AS upper_bound,
        COUNT(*)::int AS count
      FROM homework_submissions submission
      INNER JOIN lesson_homework homework ON homework.id = submission.homework_id
      WHERE submission.homework_id = ANY($1::uuid[])
        AND submission.status = 'graded'
        ${studentId ? 'AND submission.student_id = $2::uuid' : ''}
      GROUP BY 1, 2
      ORDER BY 1 ASC
      `,
      studentId ? [homeworkIds, studentId] : [homeworkIds],
    );
    return rows.map((row: ScoreDistributionRow) => ({
      lower_bound: Number(row.lower_bound),
      upper_bound: Number(row.upper_bound),
      count: Number(row.count),
    }));
  }

  private async studentPerformance(
    homeworkIds: string[],
    studentId?: string,
  ): Promise<Record<string, unknown>[]> {
    if (homeworkIds.length === 0) return [];
    const rows = await this.submissionsRepository.query(
      `
      WITH audience AS (
        SELECT homework.id AS homework_id, purchase.student_id
        FROM lesson_homework homework
        INNER JOIN lesson_purchases purchase ON purchase.lesson_id = homework.lesson_id
        WHERE homework.id = ANY($1::uuid[])
          AND purchase.revoked_at IS NULL
          AND purchase.access_expires_at > $2::timestamptz
      )
      SELECT
        student.id AS student_id,
        student.name AS student_name,
        student.username AS student_identifier,
        COUNT(DISTINCT audience.homework_id)::int AS assigned_homework_count,
        COUNT(submission.id)::int AS submitted_homework_count,
        (COUNT(DISTINCT audience.homework_id) - COUNT(submission.id))::int AS missing_homework_count,
        COUNT(submission.id) FILTER (WHERE submission.is_late = true)::int AS late_homework_count,
        COUNT(submission.id) FILTER (WHERE submission.status = 'graded')::int AS graded_homework_count,
        AVG(submission.score) FILTER (WHERE submission.status = 'graded') AS average_score
      FROM audience
      INNER JOIN users student ON student.id = audience.student_id AND student.deleted_at IS NULL
      LEFT JOIN homework_submissions submission
        ON submission.homework_id = audience.homework_id AND submission.student_id = audience.student_id
      WHERE 1 = 1
        ${studentId ? 'AND student.id = $3::uuid' : ''}
      GROUP BY student.id, student.name, student.username
      ORDER BY average_score ASC NULLS LAST, submitted_homework_count DESC
      LIMIT 100
      `,
      studentId ? [homeworkIds, new Date(), studentId] : [homeworkIds, new Date()],
    );
    return rows.map((row: StudentPerformanceRow) => ({
      student: { id: row.student_id, name: row.student_name, identifier: row.student_identifier },
      assigned_homework_count: Number(row.assigned_homework_count),
      submitted_homework_count: Number(row.submitted_homework_count),
      missing_homework_count: Number(row.missing_homework_count),
      late_homework_count: Number(row.late_homework_count),
      graded_homework_count: Number(row.graded_homework_count),
      average_score: this.toNullableNumber(row.average_score),
      completion_rate: this.percent(
        Number(row.submitted_homework_count),
        Number(row.assigned_homework_count),
      ),
    }));
  }

  private async performanceTrend(
    homeworkIds: string[],
    studentId?: string,
  ): Promise<Record<string, unknown>[]> {
    if (homeworkIds.length === 0) return [];
    const rows = await this.submissionsRepository.query(
      `
      SELECT
        DATE_TRUNC('day', submission.submitted_at) AS date,
        COUNT(*)::int AS submissions,
        COUNT(*) FILTER (WHERE submission.is_late = true)::int AS late_submissions,
        AVG((submission.score / NULLIF(homework.max_score, 0)) * 100)
          FILTER (WHERE submission.status = 'graded') AS average_score_percentage
      FROM homework_submissions submission
      INNER JOIN lesson_homework homework ON homework.id = submission.homework_id
      WHERE submission.homework_id = ANY($1::uuid[])
        ${studentId ? 'AND submission.student_id = $2::uuid' : ''}
      GROUP BY 1
      ORDER BY 1 ASC
      LIMIT 180
      `,
      studentId ? [homeworkIds, studentId] : [homeworkIds],
    );
    return rows.map(
      (row: {
        date: unknown;
        submissions: unknown;
        late_submissions: unknown;
        average_score_percentage: unknown;
      }) => ({
        date: row.date,
        submissions: Number(row.submissions),
        late_submissions: Number(row.late_submissions),
        average_score_percentage: this.toNullableNumber(row.average_score_percentage),
      }),
    );
  }

  /**
   * Median graded percentage and the count of graded submissions below the pass
   * threshold, from ONE statement over the same submission set (the former
   * `medianScore` + `countBelowPassThreshold`). Both aggregates are scalars over
   * graded submissions; submission:homework is N:1, so nothing is multiplied.
   * Parameter numbering is re-derived: the student id (when present) is $2 and
   * the threshold follows it.
   */
  private async medianAndBelowPass(
    homeworkIds: string[],
    studentId: string | undefined,
    threshold: number,
  ): Promise<{ medianScore: number | null; belowPass: number }> {
    if (homeworkIds.length === 0) return { medianScore: null, belowPass: 0 };
    const rows = await this.submissionsRepository.query(
      `
      SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (
               ORDER BY (submission.score / NULLIF(homework.max_score, 0)) * 100
             ) FILTER (WHERE submission.status = 'graded') AS median_score,
             (COUNT(*) FILTER (
               WHERE submission.status = 'graded'
                 AND ((submission.score / NULLIF(homework.max_score, 0)) * 100) < $${studentId ? '3' : '2'}
             ))::int AS below_pass
      FROM homework_submissions submission
      INNER JOIN lesson_homework homework ON homework.id = submission.homework_id
      WHERE submission.homework_id = ANY($1::uuid[])
        ${studentId ? 'AND submission.student_id = $2::uuid' : ''}
      `,
      studentId ? [homeworkIds, studentId, threshold] : [homeworkIds, threshold],
    );
    const row = rows[0] as { median_score?: unknown; below_pass?: unknown } | undefined;
    return {
      medianScore: this.toNullableNumber(row?.median_score),
      belowPass: Number(row?.below_pass ?? 0),
    };
  }

  private toHomeworkResponse(
    homework: LessonHomework,
    stats: HomeworkStats | undefined,
    packages: Array<{ id: string; title: string; title_ar: string | null }>,
  ): Record<string, unknown> {
    const result = stats ?? this.emptyStats(homework.id);
    const now = new Date();
    const status =
      homework.published_at === null
        ? 'draft'
        : homework.due_at !== null && homework.due_at < now
          ? 'closed'
          : 'active';
    return {
      id: homework.id,
      title: homework.title,
      title_ar: homework.title_ar,
      description: homework.description,
      description_ar: homework.description_ar,
      type: homework.type,
      questions: homework.questions,
      max_score: Number(homework.max_score),
      publish_status: status,
      published_at: homework.published_at,
      due_at: homework.due_at,
      created_at: homework.created_at,
      updated_at: homework.updated_at,
      lesson: { id: homework.lesson.id, title: homework.lesson.title },
      packages,
      resource_download_url: homework.resource_url
        ? `/api/v1/teacher/homework/${homework.id}/resource`
        : null,
      resource_filename: homework.resource_filename,
      targeted_students: result.targeted_students,
      submission_count: result.submission_count,
      missing_submission_count: Math.max(0, result.targeted_students - result.submission_count),
      late_submission_count: result.late_submission_count,
      ungraded_submission_count: result.ungraded_submission_count,
      graded_submission_count: result.graded_submission_count,
      average_score: result.average_score,
      submission_completion_percentage: this.percent(
        result.submission_count,
        result.targeted_students,
      ),
    };
  }

  private toSubmissionRosterResponse(
    row: SubmissionRosterRaw,
    homework: LessonHomework,
  ): Record<string, unknown> {
    const status =
      row.submission_id === null
        ? 'not_submitted'
        : row.submission_status === 'graded'
          ? 'graded'
          : this.toBoolean(row.is_late)
            ? 'submitted_late'
            : 'submitted';
    return {
      student: { id: row.student_id, name: row.student_name, identifier: row.student_identifier },
      submission_id: row.submission_id,
      status,
      grading_status:
        row.submission_id === null
          ? 'not_started'
          : row.submission_status === 'graded'
            ? 'graded'
            : 'awaiting_grading',
      submitted_at: row.submitted_at,
      updated_at: row.updated_at,
      is_late: this.toBoolean(row.is_late),
      score: this.toNullableNumber(row.score),
      max_score: Number(homework.max_score),
      graded_at: row.graded_at,
      detail_url: row.submission_id
        ? `/api/v1/teacher/homework/${homework.id}/submissions/${row.submission_id}`
        : null,
    };
  }

  private toStats(row: RawStats): HomeworkStats {
    return {
      homework_id: String(row.homework_id),
      targeted_students: Number(row.targeted_students ?? 0),
      submission_count: Number(row.submission_count ?? 0),
      late_submission_count: Number(row.late_submission_count ?? 0),
      ungraded_submission_count: Number(row.ungraded_submission_count ?? 0),
      graded_submission_count: Number(row.graded_submission_count ?? 0),
      average_score: this.toNullableNumber(row.average_score),
      highest_score: this.toNullableNumber(row.highest_score),
      lowest_score: this.toNullableNumber(row.lowest_score),
    };
  }

  private emptyStats(homeworkId: string): HomeworkStats {
    return {
      homework_id: homeworkId,
      targeted_students: 0,
      submission_count: 0,
      late_submission_count: 0,
      ungraded_submission_count: 0,
      graded_submission_count: 0,
      average_score: null,
      highest_score: null,
      lowest_score: null,
    };
  }

  private pageMeta(page: number, limit: number, total: number): PaginationMeta {
    const totalPages = Math.ceil(total / limit);
    return {
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };
  }

  private percent(numerator: number, denominator: number): number {
    return denominator === 0 ? 0 : this.round((numerator / denominator) * 100);
  }

  private round(value: number): number {
    return Math.round(value * 100) / 100;
  }

  private toNullableNumber(value: unknown): number | null {
    return value === null || value === undefined ? null : Number(value);
  }

  private toBoolean(value: unknown): boolean {
    return value === true || value === 'true' || value === 't' || value === 1 || value === '1';
  }
}
