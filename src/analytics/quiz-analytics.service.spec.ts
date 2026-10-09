import { ForbiddenException } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { Exam } from '../exams/entities/exam.entity';
import { ExamAttempt } from '../exams/entities/exam-attempt.entity';
import { ExamAttemptAnswer } from '../exams/entities/exam-attempt-answer.entity';
import { Question } from '../exams/entities/question.entity';
import { QuestionSolve } from '../gamification/entities/question-solve.entity';
import { AttendanceRecord } from '../attendance/entities/attendance-record.entity';
import { HomeworkSubmission } from '../lessons/entities/homework-submission.entity';
import { LessonProgress } from '../lessons/entities/lesson-progress.entity';
import { Subject } from '../subjects/entities/subject.entity';
import { ApplicationCacheService } from '../common/cache/application-cache.service';
import { QuizAnalyticsService } from './quiz-analytics.service';

describe('QuizAnalyticsService.getExamQuestionAnalytics', () => {
  let service: QuizAnalyticsService;
  const attempts = { createQueryBuilder: jest.fn(), query: jest.fn() };
  const answers = { createQueryBuilder: jest.fn(), query: jest.fn() };
  const exams = { findOne: jest.fn() };
  const questions = { count: jest.fn() };
  // T058: history loaders use query builders / grouped SQL, not `find` over whole tables.
  const questionSolves = { createQueryBuilder: jest.fn() };
  const homeworkSubmissions = { createQueryBuilder: jest.fn() };
  const lessonProgress = { query: jest.fn() };
  const attendance = { query: jest.fn() };
  const subjects = { find: jest.fn() };
  // Pass-through by default so every pre-existing assertion still exercises the real queries.
  const applicationCache = { getOrCompute: jest.fn() };

  /** Chainable query builder whose `getMany` resolves the given entities. */
  function manyBuilder(rows: unknown[]) {
    const builder: Record<string, jest.Mock> = {};
    for (const method of ['innerJoin', 'leftJoin', 'select', 'where', 'andWhere', 'orderBy']) {
      builder[method] = jest.fn(() => builder);
    }
    builder.getMany = jest.fn().mockResolvedValue(rows);
    return builder;
  }

  function rawBuilder(one: unknown = null, many: unknown[] = []) {
    const builder: Record<string, jest.Mock> = {};
    for (const method of [
      'innerJoin',
      'leftJoin',
      'select',
      'addSelect',
      'where',
      'andWhere',
      'groupBy',
      'addGroupBy',
      'orderBy',
      'limit',
    ]) {
      builder[method] = jest.fn(() => builder);
    }
    builder.getRawOne = jest.fn().mockResolvedValue(one);
    builder.getRawMany = jest.fn().mockResolvedValue(many);
    return builder;
  }

  function mockTeacherAnalytics(
    summary: Record<string, string | null>,
    eligibility = { eligibleStudents: 0, completedStudents: 0 },
  ) {
    const builders = [
      rawBuilder(summary),
      rawBuilder(null, []),
      rawBuilder({
        currentAttempts: '0',
        currentAvg: null,
        previousAttempts: '0',
        previousAvg: null,
      }),
      rawBuilder(null, []),
      rawBuilder(null, []),
      rawBuilder(null, []),
      rawBuilder(null, []),
    ];
    builders.forEach((builder) => attempts.createQueryBuilder.mockReturnValueOnce(builder));
    answers.createQueryBuilder.mockReturnValue(rawBuilder(null, []));
    attempts.query
      .mockResolvedValueOnce([eligibility])
      .mockResolvedValueOnce([{ failing: 0, passing: 0, good: 0, excellent: 0 }]);
    return builders;
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    questionSolves.createQueryBuilder.mockReturnValue(manyBuilder([]));
    homeworkSubmissions.createQueryBuilder.mockReturnValue(manyBuilder([]));
    lessonProgress.query.mockResolvedValue([]);
    attendance.query.mockResolvedValue([]);
    subjects.find.mockResolvedValue([]);
    applicationCache.getOrCompute.mockImplementation(
      async (_descriptor: unknown, compute: () => Promise<unknown>) => await compute(),
    );
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QuizAnalyticsService,
        { provide: getRepositoryToken(ExamAttempt), useValue: attempts },
        { provide: getRepositoryToken(ExamAttemptAnswer), useValue: answers },
        { provide: getRepositoryToken(Exam), useValue: exams },
        { provide: getRepositoryToken(Question), useValue: questions },
        { provide: getRepositoryToken(QuestionSolve), useValue: questionSolves },
        { provide: getRepositoryToken(HomeworkSubmission), useValue: homeworkSubmissions },
        { provide: getRepositoryToken(LessonProgress), useValue: lessonProgress },
        { provide: getRepositoryToken(AttendanceRecord), useValue: attendance },
        { provide: getRepositoryToken(Subject), useValue: subjects },
        { provide: ApplicationCacheService, useValue: applicationCache },
      ],
    }).compile();
    service = module.get(QuizAnalyticsService);
  });

  it('rejects analysing an exam owned by another teacher', async () => {
    exams.findOne.mockResolvedValue({ id: 'E1', teacher_id: 'other' });
    await expect(service.getExamQuestionAnalytics('E1', 'me')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('returns difficulty and discrimination aggregated by PostgreSQL', async () => {
    exams.findOne.mockResolvedValue({ id: 'E1', teacher_id: 'me' });
    answers.query.mockResolvedValue([
      {
        questionId: 'Q1',
        topic: 'Algebra',
        difficulty: 67,
        discrimination: 100,
        attempts: 3,
      },
    ]);

    const result = await service.getExamQuestionAnalytics('E1', 'me');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      questionId: 'Q1',
      topic: 'Algebra',
      attempts: 3,
      difficulty: 67,
      discrimination: 100,
    });
    expect(answers.query).toHaveBeenCalledTimes(1);
    const sql = answers.query.mock.calls[0]?.[0] as string;
    expect(sql).toContain('ROW_NUMBER() OVER');
    expect(sql).toContain('AVG(ranked.is_correct::int) FILTER');
    expect(answers.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('returns only finalized, student-visible attempts and includes manual marks and feedback', async () => {
    const summaryBuilder: Record<string, jest.Mock> = {};
    for (const method of ['innerJoin', 'leftJoin', 'select', 'where', 'andWhere', 'orderBy']) {
      summaryBuilder[method] = jest.fn(() => summaryBuilder);
    }
    summaryBuilder.getMany = jest.fn().mockResolvedValue([
      {
        id: 'attempt-1',
        state: 'graded',
        score_auto: 6,
        score_manual: 3,
        score_total: 9,
        max_score: 10,
        passed: true,
        started_at: new Date('2026-07-14T09:00:00Z'),
        submitted_at: new Date('2026-07-14T09:30:00Z'),
        graded_at: new Date('2026-07-14T10:00:00Z'),
        updated_at: new Date('2026-07-14T10:00:00Z'),
        exam: {
          title: 'Essay exam',
          config: { review_policy: 'after_graded' },
          teacher: { name: 'Teacher' },
          subject: { name: 'Math' },
          package: null,
        },
      },
      {
        id: 'attempt-2',
        state: 'graded',
        score_auto: 10,
        score_manual: 0,
        score_total: 10,
        max_score: 10,
        passed: true,
        started_at: new Date(),
        submitted_at: new Date(),
        graded_at: new Date(),
        updated_at: new Date(),
        exam: {
          title: 'Private result',
          config: { review_policy: 'never' },
          teacher: { name: 'Teacher' },
          subject: { name: 'Math' },
          package: null,
        },
      },
    ]);
    attempts.createQueryBuilder.mockReturnValue(summaryBuilder);
    answers.createQueryBuilder.mockReturnValue(
      manyBuilder([
        {
          attempt_id: 'attempt-1',
          score: 3,
          max_score: 4,
          feedback: 'Strong explanation',
          exam_question: { type_snapshot: 'essay', question: { topic: 'Algebra' } },
        },
      ]),
    );

    const result = await service.getStudentAnalytics('student-1');

    expect(result).toMatchObject({
      totalAttempts: 1,
      bestQuiz: { title: 'Essay exam', percent: 90 },
      attempts: [
        expect.objectContaining({
          scoreManual: 3,
          scoreTotal: 9,
          feedback: ['Strong explanation'],
        }),
      ],
    });
    expect(result.attempts).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ examName: 'Private result' })]),
    );
  });

  it('derives a subject strength from reviewed marks, public practice, and engagement evidence', async () => {
    questionSolves.createQueryBuilder.mockReturnValue(
      manyBuilder([
        { subject_id: 'math', is_correct: false, created_at: new Date('2026-07-01') },
        { subject_id: 'math', is_correct: true, created_at: new Date('2026-07-02') },
        { subject_id: 'math', is_correct: true, created_at: new Date('2026-07-03') },
      ]),
    );
    homeworkSubmissions.createQueryBuilder.mockReturnValue(
      manyBuilder([
        {
          score: 9,
          graded_at: new Date('2026-07-04'),
          homework: { max_score: 10, lesson: { subject_id: 'math' } },
        },
      ]),
    );
    // Two progress rows (100 % completed, 50 % not) and two present/late attendance
    // records, as the grouped per-subject statements return them.
    lessonProgress.query.mockResolvedValue([
      { subject_id: 'math', lessons: '2', completed: '1', progress: '150' },
    ]);
    attendance.query.mockResolvedValue([{ subject_id: 'math', records: '2', attended: '2' }]);
    subjects.find.mockResolvedValue([{ id: 'math', name: 'Mathematics' }]);

    const insights = await (
      service as unknown as {
        getStudentPerformanceInsights: (
          id: string,
          answers: unknown[],
          filter: object,
        ) => Promise<unknown[]>;
      }
    ).getStudentPerformanceInsights(
      'student-1',
      [
        {
          score: 4,
          max_score: 4,
          updated_at: new Date('2026-07-05'),
          exam_question: { question: { subject_id: 'math' } },
        },
      ],
      {},
    );

    expect(insights).toEqual([
      expect.objectContaining({
        topic: 'Mathematics',
        percent: 88,
        answers: 5,
        sources: { exams: 1, practice: 3, homework: 1 },
        trend: 'improving',
        lessonProgressPercent: 75,
        lessonCompletionPercent: 50,
        attendancePercent: 100,
      }),
    ]);
  });

  it('T058: a teacher filter issues none of the four history statements', async () => {
    const insights = await (
      service as unknown as {
        getStudentPerformanceInsights: (id: string, answers: unknown[], filter: object) => Promise<unknown[]>;
      }
    ).getStudentPerformanceInsights('student-1', [], { teacherId: 'teacher-1' });

    expect(insights).toEqual([]);
    expect(questionSolves.createQueryBuilder).not.toHaveBeenCalled();
    expect(homeworkSubmissions.createQueryBuilder).not.toHaveBeenCalled();
    expect(lessonProgress.query).not.toHaveBeenCalled();
    expect(attendance.query).not.toHaveBeenCalled();
  });

  it('T058: without a teacher filter all four history statements run once', async () => {
    await (
      service as unknown as {
        getStudentPerformanceInsights: (id: string, answers: unknown[], filter: object) => Promise<unknown[]>;
      }
    ).getStudentPerformanceInsights('student-1', [], {});

    expect(questionSolves.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(homeworkSubmissions.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(lessonProgress.query).toHaveBeenCalledTimes(1);
    expect(attendance.query).toHaveBeenCalledTimes(1);
  });

  it('does not classify a subject with fewer than five valid scored observations', async () => {
    questionSolves.createQueryBuilder.mockReturnValue(
      manyBuilder([
        { subject_id: 'math', is_correct: true, created_at: new Date('2026-07-01') },
        { subject_id: 'math', is_correct: false, created_at: new Date('2026-07-02') },
        { subject_id: 'math', is_correct: true, created_at: new Date('2026-07-03') },
        { subject_id: 'math', is_correct: true, created_at: new Date('2026-07-04') },
      ]),
    );
    subjects.find.mockResolvedValue([{ id: 'math', name: 'Mathematics' }]);

    const insights = await (
      service as unknown as {
        getStudentPerformanceInsights: (
          id: string,
          answers: unknown[],
          filter: object,
        ) => Promise<unknown[]>;
      }
    ).getStudentPerformanceInsights('student-1', [], {});

    expect(insights).toEqual([]);
  });

  it('computes public and private exam eligibility from eligible exam-student pairs, not attempts', async () => {
    attempts.query.mockResolvedValue([{ eligibleStudents: 25, completedStudents: 10 }]);

    const result = await (
      service as unknown as {
        getTeacherEligibilitySummary: (
          teacherId: string,
        ) => Promise<{ eligibleStudents: number; completedStudents: number }>;
      }
    ).getTeacherEligibilitySummary('teacher-1');

    expect(result).toEqual({ eligibleStudents: 25, completedStudents: 10 });
    const sql = attempts.query.mock.calls[0]?.[0] as string;
    expect(sql).toContain('exam.is_public = true');
    expect(sql).toContain('exam.is_public = false');
    expect(sql).toContain('purchase.package_id = exam.package_id');
    expect(sql).toContain('purchase.lesson_id = exam.lesson_id');
    expect(sql).toContain('lesson_package_items');
    expect(sql).toContain('SELECT DISTINCT attempt.exam_id, attempt.student_id');
    expect(sql).toContain('COUNT(completed.student_id)');
    expect(sql).toContain('attempt.state = ANY($2)');
    expect(sql).toContain('exam.deleted_at IS NULL');
  });

  it('returns populated analytics only for the authenticated teacher’s finalized attempts', async () => {
    const builders = mockTeacherAnalytics(
      {
        total: '2',
        scored: '1',
        avgPercent: '80',
        highestPercent: '80',
        lowestPercent: '80',
        passRate: '100',
      },
      { eligibleStudents: 2, completedStudents: 1 },
    );

    const result = await service.getTeacherAnalytics('teacher-a');

    expect(result).toMatchObject({
      totalAttempts: 2,
      averageScore: 80,
      passRate: 100,
      completionRate: 50,
      eligibleStudents: 2,
      completedStudents: 1,
    });
    expect(result.gradeDistribution).toHaveLength(4);
    for (const builder of builders) {
      expect(builder.where).toHaveBeenCalledWith('e.teacher_id = :teacherId', {
        teacherId: 'teacher-a',
        analyticsAttemptStates: ['submitted', 'grading', 'graded'],
      });
      expect(builder.andWhere).toHaveBeenCalledWith('e.deleted_at IS NULL');
      expect(builder.andWhere).toHaveBeenCalledWith(
        'a.state IN (:...analyticsAttemptStates)',
        expect.objectContaining({ analyticsAttemptStates: ['submitted', 'grading', 'graded'] }),
      );
    }
    expect(builders[0]?.innerJoin).toHaveBeenCalledWith('exams', 'e', 'e.id = a.exam_id');
    expect(builders[0]?.innerJoin).not.toHaveBeenCalledWith(
      'lessons',
      expect.anything(),
      expect.anything(),
    );
  });

  it('returns a complete zero-and-empty response for teachers with exams but no attempts', async () => {
    mockTeacherAnalytics({
      total: '0',
      scored: '0',
      avgPercent: null,
      highestPercent: null,
      lowestPercent: null,
      passRate: null,
    });

    const result = await service.getTeacherAnalytics('teacher-with-exams');

    expect(result).toEqual({
      totalAttempts: 0,
      averageScore: 0,
      highestScore: 0,
      lowestScore: 0,
      passRate: 0,
      failRate: 0,
      completionRate: 0,
      eligibleStudents: 0,
      completedStudents: 0,
      gradeDistribution: [],
      mostFailedQuestions: [],
      attemptTimeline: [],
      periodComparison: {
        current: { attempts: 0, avgPercent: 0 },
        previous: { attempts: 0, avgPercent: 0 },
      },
      leaderboard: [],
      weakLessons: [],
      examComparisons: [],
      coursePerformance: [],
    });
  });

  it('returns the same valid empty contract when a teacher owns no exams', async () => {
    mockTeacherAnalytics({
      total: '0',
      scored: '0',
      avgPercent: null,
      highestPercent: null,
      lowestPercent: null,
      passRate: null,
    });

    await expect(service.getTeacherAnalytics('teacher-without-exams')).resolves.toMatchObject({
      totalAttempts: 0,
      averageScore: 0,
      attemptTimeline: [],
      gradeDistribution: [],
      mostFailedQuestions: [],
      leaderboard: [],
      weakLessons: [],
      examComparisons: [],
      coursePerformance: [],
      periodComparison: {
        current: { attempts: 0, avgPercent: 0 },
        previous: { attempts: 0, avgPercent: 0 },
      },
    });
  });

  describe('caching (T039)', () => {
    it('caches the per-exam analytics for the owning teacher only, keyed by teacher and exam', async () => {
      exams.findOne.mockResolvedValue({ id: 'E1', teacher_id: 'me' });
      answers.query.mockResolvedValue([]);

      await service.getExamQuestionAnalytics('E1', 'me');

      expect(applicationCache.getOrCompute).toHaveBeenCalledTimes(1);
      expect(applicationCache.getOrCompute).toHaveBeenCalledWith(
        {
          family: 'teacher_quiz_analytics',
          endpoint: 'analytics.quiz.teacher-exam',
          scope: 'owner:me',
          parts: ['exam', 'E1'],
          ttlMs: 30_000,
        },
        expect.any(Function),
      );
    });

    it('checks ownership BEFORE the cache, so a non-owner never reads a warmed entry', async () => {
      exams.findOne.mockResolvedValue({ id: 'E1', teacher_id: 'owner' });

      await expect(service.getExamQuestionAnalytics('E1', 'intruder')).rejects.toBeInstanceOf(
        ForbiddenException,
      );

      expect(applicationCache.getOrCompute).not.toHaveBeenCalled();
    });

    it('answers a missing exam with not-found before touching the cache', async () => {
      exams.findOne.mockResolvedValue(null);

      await expect(service.getExamQuestionAnalytics('nope', 'me')).rejects.toThrow();

      expect(applicationCache.getOrCompute).not.toHaveBeenCalled();
    });

    it('a per-exam cache hit still issues the ownership query but no aggregate SQL', async () => {
      exams.findOne.mockResolvedValue({ id: 'E1', teacher_id: 'me' });
      const cached = [{ questionId: 'Q1', topic: null, difficulty: 50 }];
      applicationCache.getOrCompute.mockResolvedValue(cached);

      const result = await service.getExamQuestionAnalytics('E1', 'me');

      expect(result).toBe(cached);
      expect(exams.findOne).toHaveBeenCalledTimes(1);
      expect(answers.query).not.toHaveBeenCalled();
    });

    it('caches teacher-wide analytics under the principal teacher scope with a 30 s TTL', async () => {
      const cached = { totalAttempts: 3 };
      applicationCache.getOrCompute.mockResolvedValue(cached);

      const result = await service.getTeacherAnalytics('teacher-1');

      expect(result).toBe(cached);
      expect(applicationCache.getOrCompute).toHaveBeenCalledWith(
        {
          family: 'teacher_quiz_analytics',
          endpoint: 'analytics.quiz.teacher',
          scope: 'owner:teacher-1',
          parts: ['teacher-1'],
          ttlMs: 30_000,
        },
        expect.any(Function),
      );
      // A hit runs no SQL at all.
      expect(attempts.createQueryBuilder).not.toHaveBeenCalled();
      expect(attempts.query).not.toHaveBeenCalled();
    });

    it('never mixes two teachers: different teachers get different scopes and keys', async () => {
      applicationCache.getOrCompute.mockResolvedValue({});

      await service.getTeacherAnalytics('teacher-1');
      await service.getTeacherAnalytics('teacher-2');

      const descriptors = applicationCache.getOrCompute.mock.calls.map(
        (call) => call[0] as { scope: string; parts: unknown[] },
      );
      expect(descriptors[0]?.scope).toBe('owner:teacher-1');
      expect(descriptors[1]?.scope).toBe('owner:teacher-2');
      expect(descriptors[0]?.parts).not.toEqual(descriptors[1]?.parts);
    });
  });

  describe('caching (T040)', () => {
    beforeEach(() => {
      const emptyBuilder: Record<string, jest.Mock> = {};
      for (const method of ['innerJoin', 'leftJoin', 'select', 'where', 'andWhere', 'orderBy']) {
        emptyBuilder[method] = jest.fn(() => emptyBuilder);
      }
      emptyBuilder.getMany = jest.fn().mockResolvedValue([]);
      attempts.createQueryBuilder.mockReturnValue(emptyBuilder);
    });

    it('caches student analytics under the owner scope with a 30 s TTL, keyed by normalized filter and view', async () => {
      await service.getStudentAnalytics('student-1', { subjectId: 'math' });

      expect(applicationCache.getOrCompute).toHaveBeenCalledWith(
        {
          family: 'student_quiz_analytics',
          endpoint: 'analytics.quiz.student',
          scope: 'owner:student-1',
          parts: ['student', { subject_id: 'math', teacher_id: null, from: null, to: null }, 'full'],
          ttlMs: 30_000,
        },
        expect.any(Function),
      );
    });

    it('T062: a summary request never shares a cache key with a full request for the same filters', async () => {
      const keys = new ApplicationCacheService({} as never, {} as never);
      await service.getStudentAnalytics('student-1', { subjectId: 'math' });
      await service.getStudentAnalytics('student-1', { subjectId: 'math' }, 'summary');

      const [full, summary] = applicationCache.getOrCompute.mock.calls.map(
        (call) => call[0] as Parameters<ApplicationCacheService['buildKey']>[0],
      );
      expect((summary as { parts: unknown[] }).parts.at(-1)).toBe('summary');
      expect((full as { parts: unknown[] }).parts.at(-1)).toBe('full');
      expect(keys.buildKey(full as never)).not.toEqual(keys.buildKey(summary as never));
    });

    it('T062: the summary view runs the attempts statement only (no answers, histories or subjects)', async () => {
      await service.getStudentAnalytics('student-1', {}, 'summary');

      expect(attempts.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(answers.createQueryBuilder).not.toHaveBeenCalled();
      expect(questionSolves.createQueryBuilder).not.toHaveBeenCalled();
      expect(homeworkSubmissions.createQueryBuilder).not.toHaveBeenCalled();
      expect(lessonProgress.query).not.toHaveBeenCalled();
      expect(attendance.query).not.toHaveBeenCalled();
      expect(subjects.find).not.toHaveBeenCalled();
    });

    it('never mixes two students: different students get different scopes', async () => {
      await service.getStudentAnalytics('student-1');
      await service.getStudentAnalytics('student-2');

      const descriptors = applicationCache.getOrCompute.mock.calls.map(
        (call) => call[0] as { scope: string },
      );
      expect(descriptors[0]?.scope).toBe('owner:student-1');
      expect(descriptors[1]?.scope).toBe('owner:student-2');
    });

    it('absent filter fields normalize to explicit null, and equivalent date inputs collapse to the same key', async () => {
      await service.getStudentAnalytics('student-1', {});
      await service.getStudentAnalytics('student-1', {
        from: '2026-01-01T00:00:00.000Z',
      });
      await service.getStudentAnalytics('student-1', {
        from: '2026-01-01T00:00:00Z',
      });

      const parts = applicationCache.getOrCompute.mock.calls.map(
        (call) => (call[0] as { parts: unknown[] }).parts[1],
      );
      expect(parts[0]).toEqual({ subject_id: null, teacher_id: null, from: null, to: null });
      // Both spellings of the same instant normalize to the identical ISO string.
      expect(parts[1]).toEqual(parts[2]);
    });

    it('a different subject_id/teacher_id/from/to filter produces a different key', async () => {
      await service.getStudentAnalytics('student-1', { subjectId: 'math' });
      await service.getStudentAnalytics('student-1', { subjectId: 'science' });
      await service.getStudentAnalytics('student-1', { teacherId: 'T1' });
      await service.getStudentAnalytics('student-1', { from: '2026-01-01' });
      await service.getStudentAnalytics('student-1', { to: '2026-01-01' });

      const parts = applicationCache.getOrCompute.mock.calls.map(
        (call) => (call[0] as { parts: unknown[] }).parts[1],
      );
      const unique = new Set(parts.map((part) => JSON.stringify(part)));
      expect(unique.size).toBe(parts.length);
    });

    it('a cache hit runs no SQL at all', async () => {
      const cached = { totalAttempts: 5 };
      applicationCache.getOrCompute.mockResolvedValue(cached);

      const result = await service.getStudentAnalytics('student-1');

      expect(result).toBe(cached);
      expect(attempts.createQueryBuilder).not.toHaveBeenCalled();
    });
  });
});
