import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { Exam } from '../exams/entities/exam.entity';
import { ExamAttempt } from '../exams/entities/exam-attempt.entity';
import { ExamAttemptAnswer } from '../exams/entities/exam-attempt-answer.entity';
import { Question } from '../exams/entities/question.entity';
import { biBody } from '../i18n/error-translator.util';

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
      .addSelect('AVG(CASE WHEN a.passed THEN 1 ELSE 0 END) * 100', 'passRate')
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

    const perExam = await this.attemptsRepository
      .createQueryBuilder('a')
      .innerJoin('exams', 'e', 'e.id = a.exam_id')
      .select('e.title', 'title')
      .addSelect('a.score_total::numeric / NULLIF(a.max_score, 0) * 100', 'percent')
      .addSelect('a.submitted_at', 'submittedAt')
      .where('a.student_id = :studentId', { studentId })
      .andWhere('a.score_total IS NOT NULL')
      .orderBy('a.submitted_at', 'ASC')
      .getRawMany<{ title: string; percent: string; submittedAt: Date }>();

    const scored = perExam
      .map((r) => ({ title: r.title, percent: Math.round(Number(r.percent)) }))
      .filter((r) => Number.isFinite(r.percent));

    let best: { title: string; percent: number } | null = null;
    let worst: { title: string; percent: number } | null = null;
    for (const row of scored) {
      if (!best || row.percent > best.percent) best = row;
      if (!worst || row.percent < worst.percent) worst = row;
    }

    const progress = perExam
      .filter((r) => r.submittedAt)
      .map((r) => ({
        date: new Date(r.submittedAt).toISOString().slice(0, 10),
        percent: Math.round(Number(r.percent)),
      }));

    const topics = await this.answersRepository
      .createQueryBuilder('aa')
      .innerJoin('exam_attempts', 'a', 'a.id = aa.attempt_id')
      .innerJoin('questions', 'q', 'q.id = aa.question_id')
      .select('q.topic', 'topic')
      .addSelect('COUNT(*)', 'answers')
      .addSelect('AVG(CASE WHEN aa.is_correct THEN 1 ELSE 0 END) * 100', 'percent')
      .where('a.student_id = :studentId', { studentId })
      .andWhere('aa.is_correct IS NOT NULL')
      .andWhere('q.topic IS NOT NULL')
      .groupBy('q.topic')
      .having('COUNT(*) >= 1')
      .getRawMany<{ topic: string; answers: string; percent: string | null }>();

    const topicRows = topics.map((t) => ({
      topic: t.topic,
      answers: Number.parseInt(t.answers, 10),
      percent: Math.round(Number(t.percent ?? 0)),
    }));
    const sortedDesc = [...topicRows].sort((a, b) => b.percent - a.percent);
    const sortedAsc = [...topicRows].sort((a, b) => a.percent - b.percent);

    return {
      totalAttempts: Number.parseInt(summary?.attempts ?? '0', 10),
      averageScore: Math.round(Number(summary?.avgPercent ?? 0)),
      passRate: Math.round(Number(summary?.passRate ?? 0)),
      totalTimeMinutes: Math.round(Number(summary?.timeSeconds ?? 0) / 60),
      bestQuiz: best,
      worstQuiz: worst,
      progress,
      strongTopics: sortedDesc.slice(0, 5),
      weakTopics: sortedAsc.slice(0, 5),
    };
  }

  /* ===================== Teacher ===================== */

  public async getTeacherAnalytics(teacherId: string): Promise<{
    totalAttempts: number;
    averageScore: number;
    passRate: number;
    completionRate: number;
    mostFailedQuestions: {
      questionId: string;
      topic: string | null;
      correctRate: number;
      attempts: number;
    }[];
    attemptTimeline: { date: string; count: number }[];
    leaderboard: { studentName: string; avgPercent: number; attempts: number }[];
    weakLessons: { lessonTitle: string; avgPercent: number }[];
  }> {
    const teacherExams = { teacherId };

    const summary = await this.attemptsRepository
      .createQueryBuilder('a')
      .innerJoin('exams', 'e', 'e.id = a.exam_id')
      .select('COUNT(*)', 'total')
      .addSelect('COUNT(a.score_total)', 'scored')
      .addSelect('AVG(a.score_total::numeric / NULLIF(a.max_score, 0)) * 100', 'avgPercent')
      .addSelect('AVG(CASE WHEN a.passed THEN 1 ELSE 0 END) * 100', 'passRate')
      .where('e.teacher_id = :teacherId', teacherExams)
      .getRawOne<{
        total: string;
        scored: string;
        avgPercent: string | null;
        passRate: string | null;
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
      .having('COUNT(*) >= 3')
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
      .where('e.teacher_id = :teacherId', teacherExams)
      .andWhere("a.started_at >= NOW() - INTERVAL '30 days'")
      .groupBy('date')
      .orderBy('date', 'ASC')
      .getRawMany<{ date: string; count: string }>();

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

    return {
      totalAttempts: total,
      averageScore: Math.round(Number(summary?.avgPercent ?? 0)),
      passRate: Math.round(Number(summary?.passRate ?? 0)),
      completionRate: total > 0 ? Math.round((scored / total) * 100) : 0,
      mostFailedQuestions: failed.map((f) => ({
        questionId: f.questionId,
        topic: f.topic,
        correctRate: Math.round(Number(f.correctRate ?? 0)),
        attempts: Number.parseInt(f.attempts, 10),
      })),
      attemptTimeline: timeline.map((t) => ({
        date: t.date,
        count: Number.parseInt(t.count, 10),
      })),
      leaderboard: leaderboard.map((l) => ({
        studentName: l.studentName,
        avgPercent: Math.round(Number(l.avgPercent ?? 0)),
        attempts: Number.parseInt(l.attempts, 10),
      })),
      weakLessons: weakLessons.map((w) => ({
        lessonTitle: w.lessonTitle,
        avgPercent: Math.round(Number(w.avgPercent ?? 0)),
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

    // Per-answer rows with the attempt's overall percentage — enough to compute
    // p-value and a top/bottom-third discrimination index in memory.
    const rows = await this.answersRepository
      .createQueryBuilder('aa')
      .innerJoin('exam_attempts', 'a', 'a.id = aa.attempt_id')
      .leftJoin('questions', 'q', 'q.id = aa.question_id')
      .select('aa.question_id', 'questionId')
      .addSelect('MAX(q.topic)', 'topic')
      .addSelect('aa.is_correct', 'isCorrect')
      .addSelect('a.score_total::numeric / NULLIF(a.max_score, 0)', 'attemptPct')
      .where('a.exam_id = :examId', { examId })
      .andWhere('aa.is_correct IS NOT NULL')
      .andWhere('a.score_total IS NOT NULL')
      .groupBy('aa.question_id')
      .addGroupBy('aa.is_correct')
      .addGroupBy('a.id')
      .getRawMany<{
        questionId: string;
        topic: string | null;
        isCorrect: boolean;
        attemptPct: string | null;
      }>();

    // Group rows by question.
    const byQuestion = new Map<
      string,
      { topic: string | null; items: { correct: boolean; pct: number }[] }
    >();
    for (const r of rows) {
      const entry = byQuestion.get(r.questionId) ?? { topic: r.topic, items: [] };
      entry.items.push({
        correct: r.isCorrect,
        pct: Number(r.attemptPct ?? 0),
      });
      byQuestion.set(r.questionId, entry);
    }

    const result: {
      questionId: string;
      topic: string | null;
      difficulty: number;
      discrimination: number;
      attempts: number;
    }[] = [];

    for (const [questionId, { topic, items }] of byQuestion) {
      const attempts = items.length;
      const correct = items.filter((i) => i.correct).length;
      const difficulty = attempts > 0 ? correct / attempts : 0;

      // Discrimination: correct-rate of the top third minus the bottom third,
      // ranked by overall attempt performance.
      const ranked = [...items].sort((a, b) => b.pct - a.pct);
      const groupSize = Math.max(1, Math.floor(attempts / 3));
      const top = ranked.slice(0, groupSize);
      const bottom = ranked.slice(-groupSize);
      const topRate = top.filter((i) => i.correct).length / top.length;
      const bottomRate = bottom.filter((i) => i.correct).length / bottom.length;

      result.push({
        questionId,
        topic,
        difficulty: Math.round(difficulty * 100),
        discrimination: Math.round((topRate - bottomRate) * 100),
        attempts,
      });
    }

    return result.sort((a, b) => a.difficulty - b.difficulty);
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
    const usedRow = await this.answersRepository
      .createQueryBuilder('aa')
      .select('COUNT(DISTINCT aa.question_id)', 'count')
      .getRawOne<{ count: string }>();
    const usedQuestions = Number.parseInt(usedRow?.count ?? '0', 10);

    const difficultyRows = await this.answersRepository
      .createQueryBuilder('aa')
      .select('aa.question_id', 'questionId')
      .addSelect('AVG(CASE WHEN aa.is_correct THEN 1 ELSE 0 END)', 'rate')
      .where('aa.is_correct IS NOT NULL')
      .groupBy('aa.question_id')
      .having('COUNT(*) >= 5')
      .getRawMany<{ questionId: string; rate: string }>();
    const tooHard = difficultyRows.filter((r) => Number(r.rate) < 0.3).length;
    const tooEasy = difficultyRows.filter((r) => Number(r.rate) > 0.9).length;

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
