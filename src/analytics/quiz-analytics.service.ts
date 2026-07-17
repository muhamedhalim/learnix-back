import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { Exam } from '../exams/entities/exam.entity';
import { ExamAttempt } from '../exams/entities/exam-attempt.entity';
import { ExamAttemptAnswer } from '../exams/entities/exam-attempt-answer.entity';
import { Question } from '../exams/entities/question.entity';
import { biBody } from '../i18n/error-translator.util';

interface StudentAttemptHighlightsRow {
  bestQuiz: { title: string; percent: number } | null;
  worstQuiz: { title: string; percent: number } | null;
  progress: { date: string; percent: number }[];
}

interface StudentTopicHighlightsRow {
  strongTopics: { topic: string; percent: number; answers: number }[];
  weakTopics: { topic: string; percent: number; answers: number }[];
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
    @InjectRepository(Question)
    private readonly questionsRepository: Repository<Question>,
  ) {}

  /* ===================== Student ===================== */

  public async getStudentAnalytics(studentId: string): Promise<{
    totalAttempts: number;
    averageScore: number;
    passRate: number;
    totalTimeMinutes: number;
    bestQuiz: { title: string; percent: number } | null;
    worstQuiz: { title: string; percent: number } | null;
    progress: { date: string; percent: number }[];
    strongTopics: { topic: string; percent: number; answers: number }[];
    weakTopics: { topic: string; percent: number; answers: number }[];
  }> {
    const summary = await this.attemptsRepository
      .createQueryBuilder('a')
      .select('COUNT(*)', 'attempts')
      .addSelect('AVG(a.score_total::numeric / NULLIF(a.max_score, 0)) * 100', 'avgPercent')
      .addSelect(
        'AVG(CASE WHEN a.score_total IS NULL THEN NULL WHEN a.passed THEN 1 ELSE 0 END) * 100',
        'passRate',
      )
      .addSelect(
        'COALESCE(SUM(EXTRACT(EPOCH FROM (a.submitted_at - a.started_at))), 0)',
        'timeSeconds',
      )
      .where('a.student_id = :studentId', { studentId })
      .andWhere('a.score_total IS NOT NULL')
      .getRawOne<{
        attempts: string;
        avgPercent: string | null;
        passRate: string | null;
        timeSeconds: string | null;
      }>();

    const [attemptHighlights, topicHighlights] = await Promise.all([
      this.getStudentAttemptHighlights(studentId),
      this.getStudentTopicHighlights(studentId),
    ]);

    return {
      totalAttempts: Number.parseInt(summary?.attempts ?? '0', 10),
      averageScore: Math.round(Number(summary?.avgPercent ?? 0)),
      passRate: Math.round(Number(summary?.passRate ?? 0)),
      totalTimeMinutes: Math.round(Number(summary?.timeSeconds ?? 0) / 60),
      bestQuiz: attemptHighlights.bestQuiz,
      worstQuiz: attemptHighlights.worstQuiz,
      progress: attemptHighlights.progress,
      strongTopics: topicHighlights.strongTopics,
      weakTopics: topicHighlights.weakTopics,
    };
  }

  private async getStudentAttemptHighlights(
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

  private async getStudentTopicHighlights(studentId: string): Promise<StudentTopicHighlightsRow> {
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

  public async getTeacherAnalytics(teacherId: string): Promise<{
    totalAttempts: number;
    averageScore: number;
    highestScore: number;
    lowestScore: number;
    passRate: number;
    failRate: number;
    completionRate: number;
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
  }> {
    const teacherExams = { teacherId };

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
         WHERE exam.teacher_id = $1 AND attempt.score_total IS NOT NULL
       ) scored`,
      [teacherId],
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
      completionRate: total > 0 ? Math.round((scored / total) * 100) : 0,
      gradeDistribution: [
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

  /* ===================== Admin ===================== */

  public async getAdminAnalytics(): Promise<{
    totalAttempts: number;
    averageScore: number;
    passRate: number;
    completionRate: number;
    activeStudents30d: number;
    teacherComparisons: { teacherName: string; avgPercent: number; attempts: number }[];
    subjectComparisons: { subject: string; avgPercent: number; attempts: number }[];
    questionBankHealth: {
      totalQuestions: number;
      usedQuestions: number;
      unusedQuestions: number;
      tooHard: number;
      tooEasy: number;
    };
  }> {
    const summary = await this.attemptsRepository
      .createQueryBuilder('a')
      .select('COUNT(*)', 'total')
      .addSelect('COUNT(a.score_total)', 'scored')
      .addSelect('AVG(a.score_total::numeric / NULLIF(a.max_score, 0)) * 100', 'avgPercent')
      .addSelect('AVG(CASE WHEN a.passed THEN 1 ELSE 0 END) * 100', 'passRate')
      .getRawOne<{
        total: string;
        scored: string;
        avgPercent: string | null;
        passRate: string | null;
      }>();

    const total = Number.parseInt(summary?.total ?? '0', 10);
    const scored = Number.parseInt(summary?.scored ?? '0', 10);

    const active = await this.attemptsRepository
      .createQueryBuilder('a')
      .select('COUNT(DISTINCT a.student_id)', 'count')
      .where("a.started_at >= NOW() - INTERVAL '30 days'")
      .getRawOne<{ count: string }>();

    const teachers = await this.attemptsRepository
      .createQueryBuilder('a')
      .innerJoin('exams', 'e', 'e.id = a.exam_id')
      .innerJoin('users', 'u', 'u.id = e.teacher_id')
      .select('u.name', 'teacherName')
      .addSelect('COUNT(*)', 'attempts')
      .addSelect('AVG(a.score_total::numeric / NULLIF(a.max_score, 0)) * 100', 'avgPercent')
      .where('a.score_total IS NOT NULL')
      .groupBy('u.id')
      .addGroupBy('u.name')
      .orderBy('"avgPercent"', 'DESC')
      .limit(10)
      .getRawMany<{ teacherName: string; attempts: string; avgPercent: string | null }>();

    const subjects = await this.attemptsRepository
      .createQueryBuilder('a')
      .innerJoin('exams', 'e', 'e.id = a.exam_id')
      .innerJoin('subjects', 's', 's.id = e.subject_id')
      .select('s.name', 'subject')
      .addSelect('COUNT(*)', 'attempts')
      .addSelect('AVG(a.score_total::numeric / NULLIF(a.max_score, 0)) * 100', 'avgPercent')
      .where('a.score_total IS NOT NULL')
      .groupBy('s.id')
      .addGroupBy('s.name')
      .orderBy('"avgPercent"', 'DESC')
      .limit(10)
      .getRawMany<{ subject: string; attempts: string; avgPercent: string | null }>();

    const totalQuestions = await this.questionsRepository.count();
    const questionHealth = await this.answersRepository.query<
      {
        usedQuestions: number | string;
        tooHard: number | string;
        tooEasy: number | string;
      }[]
    >(`
      SELECT
        (
          SELECT COUNT(DISTINCT answer.question_id)::int
          FROM exam_attempt_answers answer
        ) AS "usedQuestions",
        COUNT(*) FILTER (WHERE difficulty.correct_rate < 0.3)::int AS "tooHard",
        COUNT(*) FILTER (WHERE difficulty.correct_rate > 0.9)::int AS "tooEasy"
      FROM (
        SELECT AVG(answer.is_correct::int) AS correct_rate
        FROM exam_attempt_answers answer
        WHERE answer.is_correct IS NOT NULL
        GROUP BY answer.question_id
        HAVING COUNT(*) >= 5
      ) difficulty
    `);
    const usedQuestions = Number(questionHealth[0]?.usedQuestions ?? 0);
    const tooHard = Number(questionHealth[0]?.tooHard ?? 0);
    const tooEasy = Number(questionHealth[0]?.tooEasy ?? 0);

    return {
      totalAttempts: total,
      averageScore: Math.round(Number(summary?.avgPercent ?? 0)),
      passRate: Math.round(Number(summary?.passRate ?? 0)),
      completionRate: total > 0 ? Math.round((scored / total) * 100) : 0,
      activeStudents30d: Number.parseInt(active?.count ?? '0', 10),
      teacherComparisons: teachers.map((t) => ({
        teacherName: t.teacherName,
        avgPercent: Math.round(Number(t.avgPercent ?? 0)),
        attempts: Number.parseInt(t.attempts, 10),
      })),
      subjectComparisons: subjects.map((s) => ({
        subject: s.subject,
        avgPercent: Math.round(Number(s.avgPercent ?? 0)),
        attempts: Number.parseInt(s.attempts, 10),
      })),
      questionBankHealth: {
        totalQuestions,
        usedQuestions,
        unusedQuestions: Math.max(0, totalQuestions - usedQuestions),
        tooHard,
        tooEasy,
      },
    };
  }
}
