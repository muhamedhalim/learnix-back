import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { In, Repository } from 'typeorm';

import { ApplicationCacheService } from '../common/cache/application-cache.service';
import { Exam } from '../exams/entities/exam.entity';
import { ExamAttempt } from '../exams/entities/exam-attempt.entity';
import { ExamAttemptAnswer } from '../exams/entities/exam-attempt-answer.entity';
import { AttemptState } from '../exams/entities/attempt-state.enum';
import { ReviewPolicy } from '../exams/entities/review-policy.enum';
import { QuestionSolve } from '../gamification/entities/question-solve.entity';
import { biBody } from '../i18n/error-translator.util';
import { AttendanceRecord } from '../attendance/entities/attendance-record.entity';
import { HomeworkSubmission } from '../lessons/entities/homework-submission.entity';
import { LessonProgress } from '../lessons/entities/lesson-progress.entity';
import { Subject } from '../subjects/entities/subject.entity';

interface StudentAnalyticsFilter {
  subjectId?: string;
  teacherId?: string;
  from?: string;
  to?: string;
}

interface StudentAttemptHighlightsRow {
  bestQuiz: { title: string; percent: number } | null;
  worstQuiz: { title: string; percent: number } | null;
  progress: { date: string; percent: number }[];
}

/** Attempts that reached submission; drafts, expired, and voided work are not analytics. */
const TEACHER_ANALYTICS_ATTEMPT_STATES = [
  AttemptState.SUBMITTED,
  AttemptState.GRADING,
  AttemptState.GRADED,
];

/** Legacy internal helper result; the student API uses StudentPerformanceInsight. */
interface StudentTopicHighlightsRow {
  strongTopics: { topic: string; percent: number; answers: number }[];
  weakTopics: { topic: string; percent: number; answers: number }[];
}

export interface StudentPerformanceInsight {
  /** Current taxonomy is subject-level because practice and homework are subject-scoped. */
  topic: string;
  scope: 'subject';
  percent: number;
  /** Number of completed questions or graded assignments included in the score. */
  answers: number;
  sources: { exams: number; practice: number; homework: number };
  trend: 'improving' | 'stable' | 'declining' | 'insufficient_data';
  lessonProgressPercent: number | null;
  lessonCompletionPercent: number | null;
  attendancePercent: number | null;
}

interface SubjectPerformanceBucket {
  scores: Array<{
    score: number;
    max: number;
    completedAt: Date;
    source: 'exam' | 'practice' | 'homework';
  }>;
  completedLessons: number;
  lessonsWithProgress: number;
  totalLessonProgress: number;
  attended: number;
  attendanceRecords: number;
}

interface StudentVisibleAttempt {
  examName: string;
  teacher: string | null;
  subject: string | null;
  course: string | null;
  attemptedAt: string | null;
  reviewedAt: string;
  scoreAuto: number;
  scoreManual: number;
  scoreTotal: number;
  maxScore: number;
  percentage: number;
  passed: boolean | null;
  feedback: string[];
}

/** Teacher-wide quiz analytics; cached per teacher (`teacher_quiz_analytics`). */
export interface TeacherQuizAnalytics {
  totalAttempts: number;
  averageScore: number;
  highestScore: number;
  lowestScore: number;
  passRate: number;
  failRate: number;
  completionRate: number;
  eligibleStudents: number;
  completedStudents: number;
  gradeDistribution: { range: string; count: number }[];
  mostFailedQuestions: {
    questionId: string;
    topic: string | null;
    correctRate: number;
    attempts: number;
  }[];
  attemptTimeline: { date: string; count: number; avgPercent: number }[];
  periodComparison: {
    current: { attempts: number; avgPercent: number };
    previous: { attempts: number; avgPercent: number };
  };
  leaderboard: { studentName: string; avgPercent: number; attempts: number }[];
  weakLessons: { lessonTitle: string; avgPercent: number }[];
  examComparisons: {
    examId: string;
    title: string;
    attempts: number;
    avgPercent: number;
    passRate: number;
  }[];
  coursePerformance: {
    courseId: string;
    title: string;
    attempts: number;
    avgPercent: number;
  }[];
}

/**
 * Quiz/exam analytics derived from the attempt engine's data. All score
 * percentages are computed as score_total / max_score (guarded against zero).
 * Only scored attempts (score_total IS NOT NULL) are counted.
 */
@Injectable()
export class QuizAnalyticsService {
  constructor(
    @InjectRepository(ExamAttempt)
    private readonly attemptsRepository: Repository<ExamAttempt>,
    @InjectRepository(ExamAttemptAnswer)
    private readonly answersRepository: Repository<ExamAttemptAnswer>,
    @InjectRepository(Exam)
    private readonly examsRepository: Repository<Exam>,
    @InjectRepository(QuestionSolve)
    private readonly questionSolvesRepository: Repository<QuestionSolve>,
    @InjectRepository(HomeworkSubmission)
    private readonly homeworkSubmissionsRepository: Repository<HomeworkSubmission>,
    @InjectRepository(LessonProgress)
    private readonly lessonProgressRepository: Repository<LessonProgress>,
    @InjectRepository(AttendanceRecord)
    private readonly attendanceRepository: Repository<AttendanceRecord>,
    @InjectRepository(Subject)
    private readonly subjectsRepository: Repository<Subject>,
    private readonly applicationCache: ApplicationCacheService,
  ) {}

  /* ===================== Student ===================== */

  public async getStudentAnalytics(
    studentId: string,
    filter: StudentAnalyticsFilter = {},
  ): Promise<{
    totalAttempts: number;
    averageScore: number;
    passRate: number;
    totalTimeMinutes: number;
    bestQuiz: { title: string; percent: number } | null;
    worstQuiz: { title: string; percent: number } | null;
    progress: { date: string; percent: number }[];
    strongTopics: StudentPerformanceInsight[];
    weakTopics: StudentPerformanceInsight[];
    performanceInsights: { minimumAssessments: number; hasEnoughData: boolean };
    performanceByQuestionType: { type: string; percent: number; answers: number }[];
    attempts: StudentVisibleAttempt[];
  }> {
    const query = this.attemptsRepository
      .createQueryBuilder('attempt')
      .innerJoinAndSelect('attempt.exam', 'exam')
      .leftJoinAndSelect('exam.teacher', 'teacher')
      .leftJoinAndSelect('exam.subject', 'subject')
      .leftJoinAndSelect('exam.package', 'course')
      .where('attempt.student_id = :studentId', { studentId })
      .andWhere('attempt.state = :state', { state: AttemptState.GRADED })
      .andWhere('attempt.score_total IS NOT NULL')
      .andWhere('exam.deleted_at IS NULL');
    if (filter.subjectId)
      query.andWhere('exam.subject_id = :subjectId', { subjectId: filter.subjectId });
    if (filter.teacherId)
      query.andWhere('exam.teacher_id = :teacherId', { teacherId: filter.teacherId });
    if (filter.from) query.andWhere('attempt.submitted_at >= :from', { from: filter.from });
    if (filter.to) query.andWhere('attempt.submitted_at <= :to', { to: filter.to });
    const gradedAttempts = await query.orderBy('attempt.graded_at', 'DESC').getMany();
    const visibleAttempts = gradedAttempts.filter((attempt) =>
      this.isStudentResultVisible(attempt),
    );
    const attemptIds = visibleAttempts.map((attempt) => attempt.id);
    const answers = attemptIds.length
      ? await this.answersRepository.find({
          where: { attempt_id: In(attemptIds) },
          relations: ['exam_question', 'exam_question.question'],
        })
      : [];
    const answerByAttempt = new Map<string, ExamAttemptAnswer[]>();
    for (const answer of answers) {
      const group = answerByAttempt.get(answer.attempt_id) ?? [];
      group.push(answer);
      answerByAttempt.set(answer.attempt_id, group);
    }
    const percentages = visibleAttempts.map((attempt) =>
      attempt.max_score > 0
        ? Math.round((Number(attempt.score_total) / Number(attempt.max_score)) * 100)
        : 0,
    );
    const totalTimeMinutes = Math.round(
      visibleAttempts.reduce((total, attempt) => {
        if (!attempt.submitted_at) return total;
        return total + Math.max(0, attempt.submitted_at.getTime() - attempt.started_at.getTime());
      }, 0) / 60_000,
    );
    const performanceInsights = await this.getStudentPerformanceInsights(
      studentId,
      answers,
      filter,
    );
    const typeStats = this.aggregateQuestionTypes(answers);
    const attempts: StudentVisibleAttempt[] = visibleAttempts.map((attempt, index) => ({
      examName: attempt.exam.title,
      teacher: attempt.exam.teacher?.name ?? null,
      subject: attempt.exam.subject?.name ?? null,
      course: attempt.exam.package?.title ?? null,
      attemptedAt: attempt.submitted_at?.toISOString() ?? null,
      reviewedAt: attempt.graded_at?.toISOString() ?? attempt.updated_at.toISOString(),
      scoreAuto: Number(attempt.score_auto ?? 0),
      scoreManual: Number(attempt.score_manual ?? 0),
      scoreTotal: Number(attempt.score_total ?? 0),
      maxScore: Number(attempt.max_score ?? 0),
      percentage: percentages[index] ?? 0,
      passed: attempt.passed,
      feedback: (answerByAttempt.get(attempt.id) ?? [])
        .map((answer) => answer.feedback?.trim())
        .filter((feedback): feedback is string => Boolean(feedback)),
    }));
    const best = attempts.length
      ? [...attempts].sort((a, b) => b.percentage - a.percentage)[0]
      : null;
    const worst = attempts.length
      ? [...attempts].sort((a, b) => a.percentage - b.percentage)[0]
      : null;

    return {
      totalAttempts: attempts.length,
      averageScore: attempts.length
        ? Math.round(percentages.reduce((sum, value) => sum + value, 0) / attempts.length)
        : 0,
      passRate: attempts.length
        ? Math.round(
            (attempts.filter((attempt) => attempt.passed === true).length / attempts.length) * 100,
          )
        : 0,
      totalTimeMinutes,
      bestQuiz: best ? { title: best.examName, percent: best.percentage } : null,
      worstQuiz: worst ? { title: worst.examName, percent: worst.percentage } : null,
      progress: [...attempts]
        .reverse()
        .map((attempt) => ({ date: attempt.reviewedAt.slice(0, 10), percent: attempt.percentage })),
      strongTopics: performanceInsights
        .filter((topic) => topic.percent >= 75)
        .sort((a, b) => b.percent - a.percent)
        .slice(0, 5),
      weakTopics: performanceInsights
        .filter((topic) => topic.percent < 55)
        .sort((a, b) => a.percent - b.percent)
        .slice(0, 5),
      performanceInsights: {
        minimumAssessments: 5,
        hasEnoughData: performanceInsights.length > 0,
      },
      performanceByQuestionType: typeStats,
      attempts,
    };
  }

  private isStudentResultVisible(attempt: ExamAttempt): boolean {
    if (attempt.state !== AttemptState.GRADED || attempt.score_total === null) return false;
    const policy = attempt.exam.config.review_policy;
    if (policy === ReviewPolicy.NEVER) return false;
    if (policy === ReviewPolicy.AFTER_CLOSE) {
      const closesAt = attempt.exam.config.end_window_at;
      return Boolean(closesAt && Date.now() > new Date(closesAt).getTime());
    }
    return true;
  }

  /**
   * Builds subject-level mastery insights from student-visible scored work.
   *
   * A subject is eligible only after at least five completed questions or
   * graded assignments. Strength is >=75%, needs-work is <55%; the middle
   * band intentionally remains unclassified. Scores are mark-weighted
   * (sum(score) / sum(max)), not a frontend approximation. Lesson completion
   * and attendance are shown as learning-engagement evidence only and never
   * change a mastery percentage. Trend compares the earlier and later halves
   * of at least four dated score observations; a 10-point move is meaningful.
   */
  private async getStudentPerformanceInsights(
    studentId: string,
    examAnswers: ExamAttemptAnswer[],
    filter: StudentAnalyticsFilter,
  ): Promise<StudentPerformanceInsight[]> {
    const [practiceSolves, homeworkSubmissions, lessonProgress, attendance] = await Promise.all([
      this.questionSolvesRepository.find({
        where: { user_id: studentId, suspicious: false },
        order: { created_at: 'ASC' },
      }),
      this.homeworkSubmissionsRepository.find({
        where: { student_id: studentId, status: 'graded' },
        relations: ['homework', 'homework.lesson'],
      }),
      this.lessonProgressRepository.find({
        where: { student_id: studentId },
        relations: ['lesson'],
      }),
      this.attendanceRepository.find({ where: { student_id: studentId }, relations: ['lesson'] }),
    ]);

    const buckets = new Map<string, SubjectPerformanceBucket>();
    const ensureBucket = (subjectId: string): SubjectPerformanceBucket => {
      const existing = buckets.get(subjectId);
      if (existing) return existing;
      const created: SubjectPerformanceBucket = {
        scores: [],
        completedLessons: 0,
        lessonsWithProgress: 0,
        totalLessonProgress: 0,
        attended: 0,
        attendanceRecords: 0,
      };
      buckets.set(subjectId, created);
      return created;
    };
    const isSelectedSubject = (subjectId: string) =>
      !filter.subjectId || filter.subjectId === subjectId;
    const inDateRange = (date: Date | null | undefined) => {
      if (!date) return false;
      return (
        (!filter.from || date >= new Date(filter.from)) &&
        (!filter.to || date <= new Date(filter.to))
      );
    };

    for (const answer of examAnswers) {
      const subjectId = answer.exam_question?.question?.subject_id;
      if (
        !subjectId ||
        answer.score === null ||
        answer.max_score <= 0 ||
        !isSelectedSubject(subjectId)
      )
        continue;
      // The enclosing exam query already applies its student-visible state,
      // teacher, subject, and date filters. Answer marks include manual review.
      ensureBucket(subjectId).scores.push({
        score: Number(answer.score),
        max: Number(answer.max_score),
        completedAt: answer.updated_at ?? new Date(0),
        source: 'exam',
      });
    }
    // Practice cannot be attributed to one teacher, so do not mix it into a
    // teacher-filtered report. It remains part of the student's general view.
    if (!filter.teacherId) {
      for (const solve of practiceSolves) {
        if (!isSelectedSubject(solve.subject_id) || !inDateRange(solve.created_at)) continue;
        ensureBucket(solve.subject_id).scores.push({
          score: solve.is_correct ? 1 : 0,
          max: 1,
          completedAt: solve.created_at,
          source: 'practice',
        });
      }
      for (const submission of homeworkSubmissions) {
        const subjectId = submission.homework?.lesson?.subject_id;
        if (
          !subjectId ||
          submission.score === null ||
          Number(submission.homework.max_score) <= 0 ||
          !isSelectedSubject(subjectId) ||
          !inDateRange(submission.graded_at)
        )
          continue;
        ensureBucket(subjectId).scores.push({
          score: Number(submission.score),
          max: Number(submission.homework.max_score),
          completedAt: submission.graded_at!,
          source: 'homework',
        });
      }
    }
    if (!filter.teacherId) {
      for (const progress of lessonProgress) {
        const subjectId = progress.lesson?.subject_id;
        if (!subjectId || !isSelectedSubject(subjectId) || !inDateRange(progress.last_watched_at))
          continue;
        const bucket = ensureBucket(subjectId);
        bucket.lessonsWithProgress += 1;
        bucket.completedLessons += progress.completed ? 1 : 0;
        bucket.totalLessonProgress += Math.max(0, Math.min(100, progress.progress_percent));
      }
      for (const record of attendance) {
        const subjectId = record.lesson?.subject_id;
        if (
          !subjectId ||
          !isSelectedSubject(subjectId) ||
          record.status === 'excused' ||
          !inDateRange(record.marked_at)
        )
          continue;
        const bucket = ensureBucket(subjectId);
        bucket.attendanceRecords += 1;
        bucket.attended += record.status === 'present' || record.status === 'late' ? 1 : 0;
      }
    }

    const subjectIds = [...buckets.keys()];
    const subjects = subjectIds.length
      ? await this.subjectsRepository.find({ where: { id: In(subjectIds) } })
      : [];
    const subjectNames = new Map(subjects.map((subject) => [subject.id, subject.name]));

    return subjectIds.flatMap((subjectId) => {
      const bucket = buckets.get(subjectId)!;
      const label = subjectNames.get(subjectId);
      if (!label || bucket.scores.length < 5) return [];
      const score = bucket.scores.reduce((total, item) => total + item.score, 0);
      const max = bucket.scores.reduce((total, item) => total + item.max, 0);
      if (max <= 0) return [];
      const bySource = { exams: 0, practice: 0, homework: 0 };
      for (const item of bucket.scores) {
        if (item.source === 'exam') bySource.exams += 1;
        else if (item.source === 'practice') bySource.practice += 1;
        else bySource.homework += 1;
      }
      return [
        {
          topic: label,
          scope: 'subject' as const,
          percent: Math.round((score / max) * 100),
          answers: bucket.scores.length,
          sources: bySource,
          trend: this.getPerformanceTrend(bucket.scores),
          lessonProgressPercent: bucket.lessonsWithProgress
            ? Math.round(bucket.totalLessonProgress / bucket.lessonsWithProgress)
            : null,
          lessonCompletionPercent: bucket.lessonsWithProgress
            ? Math.round((bucket.completedLessons / bucket.lessonsWithProgress) * 100)
            : null,
          attendancePercent: bucket.attendanceRecords
            ? Math.round((bucket.attended / bucket.attendanceRecords) * 100)
            : null,
        },
      ];
    });
  }

  private getPerformanceTrend(
    scores: SubjectPerformanceBucket['scores'],
  ): StudentPerformanceInsight['trend'] {
    if (scores.length < 4) return 'insufficient_data';
    const sorted = [...scores].sort((a, b) => a.completedAt.getTime() - b.completedAt.getTime());
    const middle = Math.floor(sorted.length / 2);
    const average = (items: typeof sorted) =>
      items.reduce((sum, item) => sum + (item.score / item.max) * 100, 0) / items.length;
    const difference = average(sorted.slice(middle)) - average(sorted.slice(0, middle));
    if (difference >= 10) return 'improving';
    if (difference <= -10) return 'declining';
    return 'stable';
  }

  private aggregateQuestionTypes(
    answers: ExamAttemptAnswer[],
  ): { type: string; percent: number; answers: number }[] {
    const rows = new Map<string, { score: number; max: number; answers: number }>();
    for (const answer of answers) {
      const type = answer.exam_question?.type_snapshot;
      if (!type || answer.score === null || answer.max_score <= 0) continue;
      const row = rows.get(type) ?? { score: 0, max: 0, answers: 0 };
      row.score += Number(answer.score);
      row.max += Number(answer.max_score);
      row.answers += 1;
      rows.set(type, row);
    }
    return [...rows].map(([type, value]) => ({
      type,
      answers: value.answers,
      percent: Math.round((value.score / value.max) * 100),
    }));
  }

  public async getStudentAttemptHighlights(
    studentId: string,
  ): Promise<StudentAttemptHighlightsRow> {
    const rows = await this.attemptsRepository.query<StudentAttemptHighlightsRow[]>(
      `
        WITH scored AS (
          SELECT
            exam.title,
            ROUND(attempt.score_total::numeric / NULLIF(attempt.max_score, 0) * 100)::int AS percent,
            attempt.submitted_at
          FROM exam_attempts attempt
          INNER JOIN exams exam ON exam.id = attempt.exam_id
          WHERE attempt.student_id = $1
            AND attempt.score_total IS NOT NULL
        )
        SELECT
          (
            SELECT jsonb_build_object('title', title, 'percent', percent)
            FROM scored
            ORDER BY percent DESC, submitted_at DESC NULLS LAST
            LIMIT 1
          ) AS "bestQuiz",
          (
            SELECT jsonb_build_object('title', title, 'percent', percent)
            FROM scored
            ORDER BY percent ASC, submitted_at DESC NULLS LAST
            LIMIT 1
          ) AS "worstQuiz",
          COALESCE(
            (
              SELECT jsonb_agg(
                jsonb_build_object('date', progress.date, 'percent', progress.percent)
                ORDER BY progress.submitted_at ASC
              )
              FROM (
                SELECT
                  TO_CHAR(submitted_at, 'YYYY-MM-DD') AS date,
                  percent,
                  submitted_at
                FROM scored
                WHERE submitted_at IS NOT NULL
                ORDER BY submitted_at DESC
                LIMIT 100
              ) progress
            ),
            '[]'::jsonb
          ) AS progress
      `,
      [studentId],
    );

    return rows[0] ?? { bestQuiz: null, worstQuiz: null, progress: [] };
  }

  public async getStudentTopicHighlights(studentId: string): Promise<StudentTopicHighlightsRow> {
    const rows = await this.answersRepository.query<StudentTopicHighlightsRow[]>(
      `
        WITH topic_stats AS (
          SELECT
            question.topic,
            COUNT(*)::int AS answers,
            ROUND(AVG(answer.is_correct::int) * 100)::int AS percent
          FROM exam_attempt_answers answer
          INNER JOIN exam_attempts attempt ON attempt.id = answer.attempt_id
          INNER JOIN questions question ON question.id = answer.question_id
          WHERE attempt.student_id = $1
            AND answer.is_correct IS NOT NULL
            AND question.topic IS NOT NULL
          GROUP BY question.topic
        )
        SELECT
          COALESCE(
            (
              SELECT jsonb_agg(
                jsonb_build_object(
                  'topic', strong.topic,
                  'answers', strong.answers,
                  'percent', strong.percent
                )
                ORDER BY strong.percent DESC, strong.topic ASC
              )
              FROM (
                SELECT topic, answers, percent
                FROM topic_stats
                ORDER BY percent DESC, topic ASC
                LIMIT 5
              ) strong
            ),
            '[]'::jsonb
          ) AS "strongTopics",
          COALESCE(
            (
              SELECT jsonb_agg(
                jsonb_build_object(
                  'topic', weak.topic,
                  'answers', weak.answers,
                  'percent', weak.percent
                )
                ORDER BY weak.percent ASC, weak.topic ASC
              )
              FROM (
                SELECT topic, answers, percent
                FROM topic_stats
                ORDER BY percent ASC, topic ASC
                LIMIT 5
              ) weak
            ),
            '[]'::jsonb
          ) AS "weakTopics"
      `,
      [studentId],
    );

    return rows[0] ?? { strongTopics: [], weakTopics: [] };
  }

  /* ===================== Teacher ===================== */

  public async getTeacherAnalytics(teacherId: string): Promise<TeacherQuizAnalytics> {
    // The teacher id comes from the authenticated principal, never from a parameter,
    // so the owner scope cannot be chosen by the caller. TTL 30 s equals the frontend
    // staleTime for this view (cache-policy.ts `dashboard`).
    return await this.applicationCache.getOrCompute(
      {
        family: 'teacher_quiz_analytics',
        endpoint: 'analytics.quiz.teacher',
        scope: `owner:${teacherId}`,
        parts: [teacherId],
        ttlMs: 30_000,
      },
      async () => await this.computeTeacherAnalytics(teacherId),
    );
  }

  // The statements below stay sequential (no Promise.all): the DB pool is 10 (app.module.ts).
  private async computeTeacherAnalytics(teacherId: string): Promise<TeacherQuizAnalytics> {
    const teacherExams = {
      teacherId,
      analyticsAttemptStates: TEACHER_ANALYTICS_ATTEMPT_STATES,
    };

    const summary = await this.attemptsRepository
      .createQueryBuilder('a')
      .innerJoin('exams', 'e', 'e.id = a.exam_id')
      .select('COUNT(*)', 'total')
      .addSelect('COUNT(a.score_total)', 'scored')
      .addSelect('AVG(a.score_total::numeric / NULLIF(a.max_score, 0)) * 100', 'avgPercent')
      .addSelect('MAX(a.score_total::numeric / NULLIF(a.max_score, 0)) * 100', 'highestPercent')
      .addSelect('MIN(a.score_total::numeric / NULLIF(a.max_score, 0)) * 100', 'lowestPercent')
      .addSelect(
        'AVG(CASE WHEN a.score_total IS NULL THEN NULL WHEN a.passed THEN 1 ELSE 0 END) * 100',
        'passRate',
      )
      .where('e.teacher_id = :teacherId', teacherExams)
      .andWhere('e.deleted_at IS NULL')
      .andWhere('a.state IN (:...analyticsAttemptStates)', teacherExams)
      .getRawOne<{
        total: string;
        scored: string;
        avgPercent: string | null;
        passRate: string | null;
        highestPercent: string | null;
        lowestPercent: string | null;
      }>();

    const total = Number.parseInt(summary?.total ?? '0', 10);
    const scored = Number.parseInt(summary?.scored ?? '0', 10);

    const eligibility = await this.getTeacherEligibilitySummary(teacherId);

    const failed = await this.answersRepository
      .createQueryBuilder('aa')
      .innerJoin('exam_attempts', 'a', 'a.id = aa.attempt_id')
      .innerJoin('exams', 'e', 'e.id = a.exam_id')
      .leftJoin('questions', 'q', 'q.id = aa.question_id')
      .select('aa.question_id', 'questionId')
      .addSelect('MAX(q.topic)', 'topic')
      .addSelect('COUNT(*)', 'attempts')
      .addSelect('AVG(CASE WHEN aa.is_correct THEN 1 ELSE 0 END) * 100', 'correctRate')
      .where('e.teacher_id = :teacherId', teacherExams)
      .andWhere('e.deleted_at IS NULL')
      .andWhere('a.state IN (:...analyticsAttemptStates)', teacherExams)
      .andWhere('aa.is_correct IS NOT NULL')
      .groupBy('aa.question_id')
      .orderBy('"correctRate"', 'ASC')
      .limit(10)
      .getRawMany<{
        questionId: string;
        topic: string | null;
        attempts: string;
        correctRate: string | null;
      }>();

    const timeline = await this.attemptsRepository
      .createQueryBuilder('a')
      .innerJoin('exams', 'e', 'e.id = a.exam_id')
      .select("TO_CHAR(a.started_at, 'YYYY-MM-DD')", 'date')
      .addSelect('COUNT(*)', 'count')
      .addSelect('AVG(a.score_total::numeric / NULLIF(a.max_score, 0)) * 100', 'avgPercent')
      .where('e.teacher_id = :teacherId', teacherExams)
      .andWhere('e.deleted_at IS NULL')
      .andWhere('a.state IN (:...analyticsAttemptStates)', teacherExams)
      .andWhere("a.started_at >= NOW() - INTERVAL '30 days'")
      .groupBy('date')
      .orderBy('date', 'ASC')
      .getRawMany<{ date: string; count: string; avgPercent: string | null }>();

    const periodComparison = await this.attemptsRepository
      .createQueryBuilder('a')
      .innerJoin('exams', 'e', 'e.id = a.exam_id')
      .select(
        `COUNT(*) FILTER (
          WHERE COALESCE(a.graded_at, a.submitted_at) >= NOW() - INTERVAL '30 days'
        )`,
        'currentAttempts',
      )
      .addSelect(
        `AVG(a.score_total::numeric / NULLIF(a.max_score, 0)) FILTER (
          WHERE COALESCE(a.graded_at, a.submitted_at) >= NOW() - INTERVAL '30 days'
        ) * 100`,
        'currentAvg',
      )
      .addSelect(
        `COUNT(*) FILTER (
          WHERE COALESCE(a.graded_at, a.submitted_at) >= NOW() - INTERVAL '60 days'
            AND COALESCE(a.graded_at, a.submitted_at) < NOW() - INTERVAL '30 days'
        )`,
        'previousAttempts',
      )
      .addSelect(
        `AVG(a.score_total::numeric / NULLIF(a.max_score, 0)) FILTER (
          WHERE COALESCE(a.graded_at, a.submitted_at) >= NOW() - INTERVAL '60 days'
            AND COALESCE(a.graded_at, a.submitted_at) < NOW() - INTERVAL '30 days'
        ) * 100`,
        'previousAvg',
      )
      .where('e.teacher_id = :teacherId', teacherExams)
      .andWhere('e.deleted_at IS NULL')
      .andWhere('a.state IN (:...analyticsAttemptStates)', teacherExams)
      .andWhere('a.score_total IS NOT NULL')
      .getRawOne<{
        currentAttempts: string;
        currentAvg: string | null;
        previousAttempts: string;
        previousAvg: string | null;
      }>();

    const leaderboard = await this.attemptsRepository
      .createQueryBuilder('a')
      .innerJoin('exams', 'e', 'e.id = a.exam_id')
      .innerJoin('users', 'u', 'u.id = a.student_id')
      .select('u.name', 'studentName')
      .addSelect('COUNT(*)', 'attempts')
      .addSelect('AVG(a.score_total::numeric / NULLIF(a.max_score, 0)) * 100', 'avgPercent')
      .where('e.teacher_id = :teacherId', teacherExams)
      .andWhere('e.deleted_at IS NULL')
      .andWhere('a.state IN (:...analyticsAttemptStates)', teacherExams)
      .andWhere('a.score_total IS NOT NULL')
      .groupBy('u.id')
      .addGroupBy('u.name')
      .orderBy('"avgPercent"', 'DESC')
      .limit(10)
      .getRawMany<{ studentName: string; attempts: string; avgPercent: string | null }>();

    const weakLessons = await this.attemptsRepository
      .createQueryBuilder('a')
      .innerJoin('exams', 'e', 'e.id = a.exam_id')
      .innerJoin('lessons', 'l', 'l.id = e.lesson_id')
      .select('l.title', 'lessonTitle')
      .addSelect('AVG(a.score_total::numeric / NULLIF(a.max_score, 0)) * 100', 'avgPercent')
      .where('e.teacher_id = :teacherId', teacherExams)
      .andWhere('e.deleted_at IS NULL')
      .andWhere('a.state IN (:...analyticsAttemptStates)', teacherExams)
      .andWhere('a.score_total IS NOT NULL')
      .groupBy('l.id')
      .addGroupBy('l.title')
      .orderBy('"avgPercent"', 'ASC')
      .limit(5)
      .getRawMany<{ lessonTitle: string; avgPercent: string | null }>();

    const [distribution] = await this.attemptsRepository.query<
      {
        failing: number | string;
        passing: number | string;
        good: number | string;
        excellent: number | string;
      }[]
    >(
      `SELECT
        COUNT(*) FILTER (WHERE percent < 50)::int AS failing,
        COUNT(*) FILTER (WHERE percent >= 50 AND percent < 65)::int AS passing,
        COUNT(*) FILTER (WHERE percent >= 65 AND percent < 85)::int AS good,
        COUNT(*) FILTER (WHERE percent >= 85)::int AS excellent
       FROM (
         SELECT attempt.score_total::numeric / NULLIF(attempt.max_score, 0) * 100 AS percent
         FROM exam_attempts attempt
         INNER JOIN exams exam ON exam.id = attempt.exam_id
         WHERE exam.teacher_id = $1
           AND exam.deleted_at IS NULL
           AND attempt.state = ANY($2)
           AND attempt.score_total IS NOT NULL
       ) scored`,
      [teacherId, TEACHER_ANALYTICS_ATTEMPT_STATES],
    );

    const examComparisons = await this.attemptsRepository
      .createQueryBuilder('a')
      .innerJoin('exams', 'e', 'e.id = a.exam_id')
      .select('e.id', 'examId')
      .addSelect('e.title', 'title')
      .addSelect('COUNT(*)', 'attempts')
      .addSelect('AVG(a.score_total::numeric / NULLIF(a.max_score, 0)) * 100', 'avgPercent')
      .addSelect('AVG(CASE WHEN a.passed THEN 1 ELSE 0 END) * 100', 'passRate')
      .where('e.teacher_id = :teacherId', teacherExams)
      .andWhere('e.deleted_at IS NULL')
      .andWhere('a.state IN (:...analyticsAttemptStates)', teacherExams)
      .andWhere('a.score_total IS NOT NULL')
      .groupBy('e.id')
      .addGroupBy('e.title')
      .orderBy('MAX(a.graded_at)', 'DESC')
      .limit(20)
      .getRawMany<{
        examId: string;
        title: string;
        attempts: string;
        avgPercent: string | null;
        passRate: string | null;
      }>();

    const coursePerformance = await this.attemptsRepository
      .createQueryBuilder('a')
      .innerJoin('exams', 'e', 'e.id = a.exam_id')
      .innerJoin('lesson_packages', 'course', 'course.id = e.package_id')
      .select('course.id', 'courseId')
      .addSelect('course.title', 'title')
      .addSelect('COUNT(*)', 'attempts')
      .addSelect('AVG(a.score_total::numeric / NULLIF(a.max_score, 0)) * 100', 'avgPercent')
      .where('e.teacher_id = :teacherId', teacherExams)
      .andWhere('e.deleted_at IS NULL')
      .andWhere('a.state IN (:...analyticsAttemptStates)', teacherExams)
      .andWhere('a.score_total IS NOT NULL')
      .groupBy('course.id')
      .addGroupBy('course.title')
      .orderBy('"avgPercent"', 'ASC')
      .getRawMany<{
        courseId: string;
        title: string;
        attempts: string;
        avgPercent: string | null;
      }>();

    const passRate = Math.round(Number(summary?.passRate ?? 0));

    return {
      totalAttempts: total,
      averageScore: Math.round(Number(summary?.avgPercent ?? 0)),
      highestScore: Math.round(Number(summary?.highestPercent ?? 0)),
      lowestScore: Math.round(Number(summary?.lowestPercent ?? 0)),
      passRate,
      failRate: scored > 0 ? 100 - passRate : 0,
      completionRate:
        eligibility.eligibleStudents > 0
          ? Math.round((eligibility.completedStudents / eligibility.eligibleStudents) * 100)
          : 0,
      eligibleStudents: eligibility.eligibleStudents,
      completedStudents: eligibility.completedStudents,
      gradeDistribution:
        scored === 0
          ? []
          : [
              { range: '<50%', count: Number(distribution?.failing ?? 0) },
              { range: '50–64%', count: Number(distribution?.passing ?? 0) },
              { range: '65–84%', count: Number(distribution?.good ?? 0) },
              { range: '85–100%', count: Number(distribution?.excellent ?? 0) },
            ],
      mostFailedQuestions: failed.map((f) => ({
        questionId: f.questionId,
        topic: f.topic,
        correctRate: Math.round(Number(f.correctRate ?? 0)),
        attempts: Number.parseInt(f.attempts, 10),
      })),
      attemptTimeline: timeline.map((t) => ({
        date: t.date,
        count: Number.parseInt(t.count, 10),
        avgPercent: Math.round(Number(t.avgPercent ?? 0)),
      })),
      periodComparison: {
        current: {
          attempts: Number(periodComparison?.currentAttempts ?? 0),
          avgPercent: Math.round(Number(periodComparison?.currentAvg ?? 0)),
        },
        previous: {
          attempts: Number(periodComparison?.previousAttempts ?? 0),
          avgPercent: Math.round(Number(periodComparison?.previousAvg ?? 0)),
        },
      },
      leaderboard: leaderboard.map((l) => ({
        studentName: l.studentName,
        avgPercent: Math.round(Number(l.avgPercent ?? 0)),
        attempts: Number.parseInt(l.attempts, 10),
      })),
      weakLessons: weakLessons.map((w) => ({
        lessonTitle: w.lessonTitle,
        avgPercent: Math.round(Number(w.avgPercent ?? 0)),
      })),
      examComparisons: examComparisons.map((exam) => ({
        examId: exam.examId,
        title: exam.title,
        attempts: Number(exam.attempts),
        avgPercent: Math.round(Number(exam.avgPercent ?? 0)),
        passRate: Math.round(Number(exam.passRate ?? 0)),
      })),
      coursePerformance: coursePerformance.map((course) => ({
        courseId: course.courseId,
        title: course.title,
        attempts: Number(course.attempts),
        avgPercent: Math.round(Number(course.avgPercent ?? 0)),
      })),
    };
  }

  /**
   * Completion is based on unique eligible exam/student pairs, never raw
   * attempt rows. A student with three attempts can complete an exam once.
   * Eligibility mirrors ExamAccessService for public, course, lesson, and
   * legacy instructor-roster audiences and only counts exams whose start
   * window has opened.
   */
  private async getTeacherEligibilitySummary(
    teacherId: string,
  ): Promise<{ eligibleStudents: number; completedStudents: number }> {
    const rows = await this.attemptsRepository.query<
      { eligibleStudents: number | string; completedStudents: number | string }[]
    >(
      `
        WITH eligible AS (
          SELECT exam.id AS exam_id, student.id AS student_id
          FROM exams exam
          INNER JOIN users student
            ON student.role = 'student'
           AND student.is_active = true
           AND student.deleted_at IS NULL
          WHERE exam.teacher_id = $1
            AND exam.deleted_at IS NULL
            AND exam.status IN ('published', 'scheduled', 'archived')
            AND (
              NULLIF(exam.config ->> 'start_window_at', '') IS NULL
              OR (exam.config ->> 'start_window_at')::timestamptz <= NOW()
            )
            AND exam.is_public = true

          UNION

          SELECT exam.id, student.id
          FROM exams exam
          INNER JOIN package_purchases purchase
            ON purchase.package_id = exam.package_id
           AND purchase.revoked_at IS NULL
          INNER JOIN users student
            ON student.id = purchase.student_id
           AND student.is_active = true
           AND student.deleted_at IS NULL
          WHERE exam.teacher_id = $1
            AND exam.deleted_at IS NULL
            AND exam.status IN ('published', 'scheduled', 'archived')
            AND (
              NULLIF(exam.config ->> 'start_window_at', '') IS NULL
              OR (exam.config ->> 'start_window_at')::timestamptz <= NOW()
            )
            AND exam.is_public = false
            AND exam.package_id IS NOT NULL

          UNION

          SELECT exam.id, student.id
          FROM exams exam
          INNER JOIN lesson_purchases purchase
            ON purchase.lesson_id = exam.lesson_id
           AND purchase.revoked_at IS NULL
           AND purchase.access_expires_at > NOW()
          INNER JOIN users student
            ON student.id = purchase.student_id
           AND student.is_active = true
           AND student.deleted_at IS NULL
          WHERE exam.teacher_id = $1
            AND exam.deleted_at IS NULL
            AND exam.status IN ('published', 'scheduled', 'archived')
            AND (
              NULLIF(exam.config ->> 'start_window_at', '') IS NULL
              OR (exam.config ->> 'start_window_at')::timestamptz <= NOW()
            )
            AND exam.is_public = false
            AND exam.lesson_id IS NOT NULL

          UNION

          SELECT exam.id, student.id
          FROM exams exam
          INNER JOIN lesson_package_items item ON item.lesson_id = exam.lesson_id
          INNER JOIN package_purchases purchase
            ON purchase.package_id = item.package_id
           AND purchase.revoked_at IS NULL
          INNER JOIN users student
            ON student.id = purchase.student_id
           AND student.is_active = true
           AND student.deleted_at IS NULL
          WHERE exam.teacher_id = $1
            AND exam.deleted_at IS NULL
            AND exam.status IN ('published', 'scheduled', 'archived')
            AND (
              NULLIF(exam.config ->> 'start_window_at', '') IS NULL
              OR (exam.config ->> 'start_window_at')::timestamptz <= NOW()
            )
            AND exam.is_public = false
            AND exam.lesson_id IS NOT NULL

          UNION

          SELECT exam.id, student.id
          FROM exams exam
          INNER JOIN lessons roster_lesson ON roster_lesson.teacher_id = exam.teacher_id
          INNER JOIN lesson_purchases purchase
            ON purchase.lesson_id = roster_lesson.id
           AND purchase.revoked_at IS NULL
           AND purchase.access_expires_at > NOW()
          INNER JOIN users student
            ON student.id = purchase.student_id
           AND student.is_active = true
           AND student.deleted_at IS NULL
          WHERE exam.teacher_id = $1
            AND exam.deleted_at IS NULL
            AND exam.status IN ('published', 'scheduled', 'archived')
            AND (
              NULLIF(exam.config ->> 'start_window_at', '') IS NULL
              OR (exam.config ->> 'start_window_at')::timestamptz <= NOW()
            )
            AND exam.is_public = false
            AND exam.lesson_id IS NULL
            AND exam.package_id IS NULL

          UNION

          SELECT exam.id, student.id
          FROM exams exam
          INNER JOIN lesson_packages roster_course ON roster_course.teacher_id = exam.teacher_id
          INNER JOIN package_purchases purchase
            ON purchase.package_id = roster_course.id
           AND purchase.revoked_at IS NULL
          INNER JOIN users student
            ON student.id = purchase.student_id
           AND student.is_active = true
           AND student.deleted_at IS NULL
          WHERE exam.teacher_id = $1
            AND exam.deleted_at IS NULL
            AND exam.status IN ('published', 'scheduled', 'archived')
            AND (
              NULLIF(exam.config ->> 'start_window_at', '') IS NULL
              OR (exam.config ->> 'start_window_at')::timestamptz <= NOW()
            )
            AND exam.is_public = false
            AND exam.lesson_id IS NULL
            AND exam.package_id IS NULL
        ), completed AS (
          SELECT DISTINCT attempt.exam_id, attempt.student_id
          FROM exam_attempts attempt
          INNER JOIN exams exam ON exam.id = attempt.exam_id
          WHERE exam.teacher_id = $1
            AND exam.deleted_at IS NULL
            AND attempt.state = ANY($2)
            AND attempt.score_total IS NOT NULL
        )
        SELECT
          COUNT(*)::int AS "eligibleStudents",
          COUNT(completed.student_id)::int AS "completedStudents"
        FROM eligible
        LEFT JOIN completed
          ON completed.exam_id = eligible.exam_id
         AND completed.student_id = eligible.student_id
      `,
      [teacherId, TEACHER_ANALYTICS_ATTEMPT_STATES],
    );

    return {
      eligibleStudents: Number(rows[0]?.eligibleStudents ?? 0),
      completedStudents: Number(rows[0]?.completedStudents ?? 0),
    };
  }

  /**
   * Per-question analytics for one exam: difficulty (p-value) + a simple
   * discrimination index (top-third correct-rate minus bottom-third).
   */
  public async getExamQuestionAnalytics(
    examId: string,
    teacherId: string,
  ): Promise<
    {
      questionId: string;
      topic: string | null;
      difficulty: number;
      correctPercentage: number;
      incorrectPercentage: number;
      discrimination: number;
      attempts: number;
    }[]
  > {
    const exam = await this.examsRepository.findOne({
      where: { id: examId },
      select: { id: true, teacher_id: true },
    });
    if (!exam) {
      throw new NotFoundException(biBody('Exam not found', 'الاختبار غير موجود'));
    }
    if (exam.teacher_id !== teacherId) {
      throw new ForbiddenException(
        biBody('You can only analyse your own exams', 'يمكنك تحليل اختباراتك الخاصة فقط'),
      );
    }

    // Cached only AFTER the ownership check above: a non-owner is refused before any
    // cache read, so a warmed entry can never be served to another teacher. A hit still
    // costs the one ownership `findOne`, and the entry is scoped to the owning teacher.
    return await this.applicationCache.getOrCompute(
      {
        family: 'teacher_quiz_analytics',
        endpoint: 'analytics.quiz.teacher-exam',
        scope: `owner:${teacherId}`,
        parts: ['exam', examId],
        ttlMs: 30_000,
      },
      async () => {
        // PostgreSQL computes p-value and top/bottom-third discrimination without
        // materializing per-answer rows in the API process.
        const rows = await this.queryExamQuestionAggregates(examId);

        const result: {
          questionId: string;
          topic: string | null;
          difficulty: number;
          correctPercentage: number;
          incorrectPercentage: number;
          discrimination: number;
          attempts: number;
        }[] = [];

        for (const row of rows) {
          const correctPercentage = Number(row.difficulty);
          result.push({
            questionId: row.questionId,
            topic: row.topic,
            difficulty: correctPercentage,
            correctPercentage,
            incorrectPercentage: Math.max(0, 100 - correctPercentage),
            discrimination: Number(row.discrimination),
            attempts: Number(row.attempts),
          });
        }

        return result;
      },
    );
  }

  private async queryExamQuestionAggregates(examId: string): Promise<
    {
      questionId: string;
      topic: string | null;
      difficulty: number | string;
      discrimination: number | string;
      attempts: number | string;
    }[]
  > {
    return await this.answersRepository.query(
      `
        WITH ranked_answers AS (
          SELECT
            answer.question_id,
            question.topic,
            answer.is_correct,
            ROW_NUMBER() OVER (
              PARTITION BY answer.question_id
              ORDER BY
                attempt.score_total::numeric / NULLIF(attempt.max_score, 0) DESC,
                attempt.id
            ) AS top_rank,
            ROW_NUMBER() OVER (
              PARTITION BY answer.question_id
              ORDER BY
                attempt.score_total::numeric / NULLIF(attempt.max_score, 0) ASC,
                attempt.id
            ) AS bottom_rank,
            COUNT(*) OVER (PARTITION BY answer.question_id) AS answer_count
          FROM exam_attempt_answers answer
          INNER JOIN exam_attempts attempt ON attempt.id = answer.attempt_id
          LEFT JOIN questions question ON question.id = answer.question_id
          WHERE attempt.exam_id = $1
            AND answer.is_correct IS NOT NULL
            AND attempt.score_total IS NOT NULL
        )
        SELECT
          ranked.question_id AS "questionId",
          MAX(ranked.topic) AS topic,
          ROUND(AVG(ranked.is_correct::int) * 100)::int AS difficulty,
          ROUND((
            AVG(ranked.is_correct::int) FILTER (
              WHERE ranked.top_rank <= GREATEST(
                1,
                FLOOR(ranked.answer_count / 3.0)::int
              )
            )
            - AVG(ranked.is_correct::int) FILTER (
              WHERE ranked.bottom_rank <= GREATEST(
                1,
                FLOOR(ranked.answer_count / 3.0)::int
              )
            )
          ) * 100)::int AS discrimination,
          COUNT(*)::int AS attempts
        FROM ranked_answers ranked
        GROUP BY ranked.question_id
        ORDER BY difficulty ASC, ranked.question_id ASC
      `,
      [examId],
    );
  }

}
