import {
  ApplicationCacheService,
  type ApplicationCacheFamily,
} from '../../src/common/cache/application-cache.service';
import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  type AuthenticatedUser,
  type E2EContext,
} from './fixtures';
import { StatementCounter } from './helpers/statement-counter';

/**
 * Spec 004 Wave 1 (T032, T035, T039): exam attempts, autosave and grading against the owner-scoped
 * application cache.
 *
 * No existing e2e exercises exam attempts, autosave or grading (`baseline/source-drift.md` section 5,
 * item 3), so this suite builds its own exam fixtures with raw SQL (the same way `omr.e2e-spec.ts`
 * does) and drives every state change through the real HTTP routes:
 *
 *   POST   student/exams/:id/start                      -> creates an IN_PROGRESS attempt
 *   PATCH  student/exams/attempts/:attemptId/answers    -> autosave (`@SkipCacheInvalidation()`)
 *   POST   student/exams/attempts/:attemptId/submit     -> objective grade, essay left pending (GRADING)
 *   POST   teacher/exams/:id/answers/:answerId/grade    -> manual grade, attempt becomes GRADED
 *
 * "Freshness" assertions never wait for a TTL: every cached view is read (warmed) immediately before
 * the write and read again immediately after it, so a stale entry can only mean a missing invalidation.
 * "Isolation" and "cache hit" assertions use a write that BYPASSES the API (raw SQL): a cached read
 * that does not show it proves the entry was served from the cache, and the control step at the end of
 * each test bumps that same slice by hand to prove the bypass write was real.
 *
 * Background workers are disabled in this environment (`E2E_DISABLE_BACKGROUND_WORKERS`), so the
 * `exam-analytics` BullMQ worker never runs and cannot bump any scope behind a test's back; only the
 * HTTP-route and service-level invalidations that these tests are about are in play.
 */

/** Marks per question in the fixture exam: one auto-graded choice question and one manual essay. */
const QUESTION_MARKS = 5;
const EXAM_TOTAL_MARKS = 10;
const EXAM_PASSING_MARKS = 5;
/** Essay score the teacher awards; the attempt total becomes `QUESTION_MARKS + ESSAY_SCORE` = 8/10. */
const ESSAY_SCORE = 3;
const GRADED_TOTAL = QUESTION_MARKS + ESSAY_SCORE;
/** The same attempt as a rounded percentage of the exam's total marks (what quiz analytics report). */
const GRADED_PERCENT = Math.round((GRADED_TOTAL / EXAM_TOTAL_MARKS) * 100);

interface StudentDashboard {
  examsCompleted: number;
  examsInProgress: number;
  averageScore: number | null;
}

interface SubjectProgress {
  subjectId: string;
  averageScore: number | null;
}

interface StudentProgress {
  subjects: SubjectProgress[];
}

interface ExamAnalytics {
  total_submissions: number;
  in_progress_count: number;
  pending_grading_count: number;
  average_score: number | null;
  calculated_at: string;
}

interface QuizTeacherAnalytics {
  totalAttempts: number;
  averageScore: number;
  passRate: number;
  gradeDistribution: { range: string; count: number }[];
  leaderboard: { studentName: string; avgPercent: number; attempts: number }[];
  examComparisons: { examId: string; attempts: number; avgPercent: number }[];
}

interface QuizExamQuestion {
  questionId: string;
  correctPercentage: number;
  attempts: number;
}

interface ExamFixture {
  examId: string;
  choiceEqId: string;
  essayEqId: string;
}

interface CacheWatch {
  invalidateAll: jest.SpyInstance;
  invalidate: jest.SpyInstance;
  invalidateScopes: jest.SpyInstance;
}

describe('exam cache freshness, owner isolation and teacher quiz analytics (spec 004 T032/T035/T039)', () => {
  let ctx: E2EContext;
  let cache: ApplicationCacheService;
  let subjectId: string;

  beforeAll(async () => {
    ctx = await createE2EApp();
    cache = ctx.app.get(ApplicationCacheService);
  });

  afterAll(async () => ctx.app.close());

  beforeEach(async () => {
    // A finalised attempt fires an async EventEmitter2 event (parent notifications) that is not awaited
    // by the request; give it a beat to finish before truncating everything out from under it.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await resetDatabase(ctx.dataSource);
    const [{ id }] = (await ctx.dataSource.query(
      `INSERT INTO subjects (id, name) VALUES (gen_random_uuid(), 'Cache Freshness Subject') RETURNING id`,
    )) as [{ id: string }];
    subjectId = id;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------------------------
  // People and exam fixtures (raw SQL, bypassing the authoring flows)
  // ---------------------------------------------------------------------------------------------

  /**
   * Users are created up front, before anything is cached: registration and login are undeclared
   * mutations that would legitimately bump the global generation and evict every warmed entry.
   */
  async function createTeacher(): Promise<AuthenticatedUser> {
    return createAuthenticatedUser(ctx.app, ctx.dataSource, {
      role: 'teacher',
      overrides: { requestedRole: 'teacher' },
    });
  }

  async function createStudent(): Promise<AuthenticatedUser> {
    return createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'student' });
  }

  async function attachQuestion(
    teacherId: string,
    examId: string,
    sectionId: string,
    spec: {
      type: 'single_choice' | 'essay';
      content: Record<string, unknown>;
      answerKey: Record<string, unknown>;
      orderIndex: number;
    },
  ): Promise<string> {
    const [{ id: questionId }] = (await ctx.dataSource.query(
      `INSERT INTO questions (id, teacher_id, subject_id, type, content, answer_key, default_marks)
       VALUES (gen_random_uuid(), $1, $2, '${spec.type}', $3, $4, ${String(QUESTION_MARKS)}) RETURNING id`,
      [teacherId, subjectId, JSON.stringify(spec.content), JSON.stringify(spec.answerKey)],
    )) as [{ id: string }];
    const [{ id: examQuestionId }] = (await ctx.dataSource.query(
      `INSERT INTO exam_questions (id, exam_id, section_id, question_id, question_version, type_snapshot, content_snapshot, answer_key_snapshot, order_index, marks, weight, is_bonus, required)
       VALUES (gen_random_uuid(), $1, $2, $3, 1, '${spec.type}', $4, $5, $6, ${String(QUESTION_MARKS)}, 1, false, true) RETURNING id`,
      [
        examId,
        sectionId,
        questionId,
        JSON.stringify(spec.content),
        JSON.stringify(spec.answerKey),
        spec.orderIndex,
      ],
    )) as [{ id: string }];
    return examQuestionId;
  }

  /**
   * A published, PUBLIC exam owned by `teacherId` (so any student may start it without a purchase)
   * with one auto-graded single-choice question (correct option `opt_1`) and one manual essay.
   * Submitting the correct choice answer therefore leaves the attempt in GRADING until the teacher
   * grades the essay through the API.
   */
  async function seedExam(teacherId: string): Promise<ExamFixture> {
    const config = {
      duration_seconds: 3600,
      attempts_allowed: 3,
      start_window_at: null,
      end_window_at: null,
      shuffle_questions: false,
      shuffle_choices: false,
      review_policy: 'after_graded',
      negative_marking: false,
      show_score_immediately: true,
      grace_seconds: 30,
    };
    const [{ id: examId }] = (await ctx.dataSource.query(
      `INSERT INTO exams (id, teacher_id, subject_id, title, title_ar, status, is_public, config, total_marks, passing_marks)
       VALUES (gen_random_uuid(), $1, $2, 'Cache Freshness Exam', 'اختبار', 'published', true, $3, ${String(EXAM_TOTAL_MARKS)}, ${String(EXAM_PASSING_MARKS)}) RETURNING id`,
      [teacherId, subjectId, JSON.stringify(config)],
    )) as [{ id: string }];
    const [{ id: sectionId }] = (await ctx.dataSource.query(
      `INSERT INTO exam_sections (id, exam_id, order_index) VALUES (gen_random_uuid(), $1, 0) RETURNING id`,
      [examId],
    )) as [{ id: string }];

    const choiceEqId = await attachQuestion(teacherId, examId, sectionId, {
      type: 'single_choice',
      content: {
        prompt: { en: 'Pick B' },
        options: [
          { id: 'opt_0', text: { en: 'A' } },
          { id: 'opt_1', text: { en: 'B' } },
          { id: 'opt_2', text: { en: 'C' } },
        ],
      },
      answerKey: { correctOptionId: 'opt_1' },
      orderIndex: 0,
    });
    const essayEqId = await attachQuestion(teacherId, examId, sectionId, {
      type: 'essay',
      content: { prompt: { en: 'Explain your answer' } },
      answerKey: {},
      orderIndex: 1,
    });
    return { examId, choiceEqId, essayEqId };
  }

  // ---------------------------------------------------------------------------------------------
  // Real HTTP flow helpers
  // ---------------------------------------------------------------------------------------------

  async function startAttempt(student: AuthenticatedUser, examId: string): Promise<string> {
    const res = await student.agent.post(`${API_PREFIX}/student/exams/${examId}/start`).expect(201);
    return (res.body as { attempt_id: string }).attempt_id;
  }

  async function saveAnswers(
    student: AuthenticatedUser,
    attemptId: string,
    fx: ExamFixture,
  ): Promise<void> {
    const res = await student.agent
      .patch(`${API_PREFIX}/student/exams/attempts/${attemptId}/answers`)
      .send({
        answers: [
          { exam_question_id: fx.choiceEqId, response: { optionId: 'opt_1' } },
          { exam_question_id: fx.essayEqId, response: { text: 'A written explanation.' } },
        ],
      })
      .expect(200);
    expect((res.body as { saved: number }).saved).toBe(2);
  }

  /** Submits an attempt whose essay is still unmarked: the attempt lands in GRADING with 1 pending answer. */
  async function submitAttempt(student: AuthenticatedUser, attemptId: string): Promise<void> {
    const res = await student.agent
      .post(`${API_PREFIX}/student/exams/attempts/${attemptId}/submit`)
      .send({})
      .expect(201);
    const summary = res.body as { state: string; pending_manual: number };
    expect(summary.state).toBe('grading');
    expect(summary.pending_manual).toBe(1);
  }

  async function essayAnswerId(attemptId: string, fx: ExamFixture): Promise<string> {
    const [{ id }] = (await ctx.dataSource.query(
      `SELECT id FROM exam_attempt_answers WHERE attempt_id = $1 AND exam_question_id = $2`,
      [attemptId, fx.essayEqId],
    )) as [{ id: string }];
    return id;
  }

  async function gradeEssay(
    teacher: AuthenticatedUser,
    fx: ExamFixture,
    attemptId: string,
    score = ESSAY_SCORE,
  ): Promise<void> {
    const answerId = await essayAnswerId(attemptId, fx);
    const res = await teacher.agent
      .post(`${API_PREFIX}/teacher/exams/${fx.examId}/answers/${answerId}/grade`)
      .send({ score, feedback: 'Reviewed' })
      .expect(201);
    expect((res.body as { state: string }).state).toBe('graded');
  }

  /** start -> autosave -> submit -> teacher grades the essay: a fully GRADED attempt (8/10). */
  async function completeGradedAttempt(
    student: AuthenticatedUser,
    teacher: AuthenticatedUser,
    fx: ExamFixture,
  ): Promise<string> {
    const attemptId = await startAttempt(student, fx.examId);
    await saveAnswers(student, attemptId, fx);
    await submitAttempt(student, attemptId);
    await gradeEssay(teacher, fx, attemptId);
    return attemptId;
  }

  /**
   * A write that goes around the API (and therefore around every invalidation): inserts a GRADED
   * attempt straight into the table. A cached view that does not show it was served from the cache.
   */
  async function insertGradedAttemptBypassingApi(
    examId: string,
    studentId: string,
    scoreTotal: number,
  ): Promise<string> {
    const [{ id }] = (await ctx.dataSource.query(
      `INSERT INTO exam_attempts (id, exam_id, student_id, attempt_number, state, shuffle_seed, started_at, deadline_at, submitted_at, graded_at, score_auto, score_manual, score_total, max_score, passed, session_token)
       VALUES (gen_random_uuid(), $1, $2, 1, 'graded', 0, now(), now(), now(), now(), $3, 0, $3, ${String(EXAM_TOTAL_MARKS)}, $4, gen_random_uuid()) RETURNING id`,
      [examId, studentId, scoreTotal, scoreTotal >= EXAM_PASSING_MARKS],
    )) as [{ id: string }];
    return id;
  }

  // ---------------------------------------------------------------------------------------------
  // Cached read helpers (every one is a GET, so none of them invalidates anything)
  // ---------------------------------------------------------------------------------------------

  async function getData<T>(user: AuthenticatedUser, path: string): Promise<T> {
    const res = await user.agent.get(`${API_PREFIX}${path}`).expect(200);
    return (res.body as { data: T }).data;
  }

  const studentDashboard = (student: AuthenticatedUser) =>
    getData<StudentDashboard>(student, '/analytics/student/dashboard');
  const studentProgress = (student: AuthenticatedUser) =>
    getData<StudentProgress>(student, '/reports/student/progress');
  // NOTE: `GET /reports/teacher/summary` (the only reader of the `teacher_report` family) cannot be
  // used as a probe: at bef7e10 it returns 500 (`QueryFailedError: syntax error at or near "order"` in
  // `ReportsService.getTeacherRevenueStats`, a defect independent of caching that no existing test
  // exercises). `teacher_report` invalidation is therefore asserted through the exact-call spies below
  // instead of through reads; `exam_analytics` and `teacher_quiz_analytics` are read directly.
  const examAnalytics = (teacher: AuthenticatedUser, examId: string) =>
    getData<ExamAnalytics>(teacher, `/analytics/exams/${examId}`);
  const quizTeacher = (teacher: AuthenticatedUser) =>
    getData<QuizTeacherAnalytics>(teacher, '/analytics/quiz/teacher');
  const quizExam = (teacher: AuthenticatedUser, examId: string) =>
    getData<QuizExamQuestion[]>(teacher, `/analytics/quiz/teacher/exams/${examId}`);

  function subjectAverage(progress: StudentProgress): number | null | undefined {
    return progress.subjects.find((s) => s.subjectId === subjectId)?.averageScore;
  }

  /** Reads (and so warms) every view an attempt write can affect, for one student and one exam. */
  async function readAllViews(
    student: AuthenticatedUser,
    teacher: AuthenticatedUser,
    examId: string,
  ) {
    return {
      dashboard: await studentDashboard(student),
      progress: await studentProgress(student),
      exam: await examAnalytics(teacher, examId),
      quiz: await quizTeacher(teacher),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Invalidation spies (call-through: the real invalidation still runs)
  // ---------------------------------------------------------------------------------------------

  function watchInvalidation(): CacheWatch {
    return {
      invalidateAll: jest.spyOn(cache, 'invalidateAll'),
      invalidate: jest.spyOn(cache, 'invalidate'),
      invalidateScopes: jest.spyOn(cache, 'invalidateScopes'),
    };
  }

  /** Union of every `{family, scope}` slice passed to `invalidateScopes`, de-duplicated and sorted. */
  function scopedSlices(watch: CacheWatch): string[] {
    const calls = watch.invalidateScopes.mock.calls as [
      readonly { family: string; scope: string }[],
    ][];
    const slices = calls.flatMap(([scopes]) =>
      scopes.map(({ family, scope }) => `${family}@${scope}`),
    );
    return [...new Set(slices)].sort();
  }

  /** Every family passed to a family-level `invalidate`; a call with no argument means "all families". */
  function familyLevelFamilies(watch: CacheWatch): string[] {
    const calls = watch.invalidate.mock.calls as [readonly string[] | undefined][];
    return calls.flatMap(([families]) => families ?? ['<all-families>']).sort();
  }

  function slicesOf(families: readonly string[], ...owners: readonly string[]): string[] {
    return owners.flatMap((owner) => families.map((family) => `${family}@owner:${owner}`));
  }

  // ===============================================================================================
  // T032: freshness on the very next request (no TTL wait)
  // ===============================================================================================

  describe('T032 - freshness without waiting for a TTL', () => {
    it('start, submit and manual grade are each reflected on the next request in the student dashboard/report, teacher report, exam analytics and quiz analytics', async () => {
      const teacher = await createTeacher();
      const student = await createStudent();
      const fx = await seedExam(teacher.userId);

      // Baseline: every view read once, so each is cached before the first write.
      const before = await readAllViews(student, teacher, fx.examId);
      expect(before.dashboard).toMatchObject({
        examsCompleted: 0,
        examsInProgress: 0,
        averageScore: null,
      });
      expect(subjectAverage(before.progress)).toBeNull();
      expect(before.exam).toMatchObject({
        in_progress_count: 0,
        pending_grading_count: 0,
        total_submissions: 0,
      });
      expect(before.quiz.totalAttempts).toBe(0);

      // --- POST student/exams/:id/start ---
      const attemptId = await startAttempt(student, fx.examId);
      const afterStart = await readAllViews(student, teacher, fx.examId);
      expect(afterStart.exam.in_progress_count).toBe(1); // exam_analytics
      expect(afterStart.quiz.totalAttempts).toBe(0); // teacher_quiz_analytics ignores IN_PROGRESS
      expect(afterStart.dashboard).toMatchObject({ examsCompleted: 0, examsInProgress: 0 });

      // --- PATCH autosave (no reflection expected, only that it does not break anything) ---
      await saveAnswers(student, attemptId, fx);

      // --- POST student/exams/attempts/:attemptId/submit ---
      await submitAttempt(student, attemptId);
      const afterSubmit = await readAllViews(student, teacher, fx.examId);
      expect(afterSubmit.dashboard).toMatchObject({ examsInProgress: 1, examsCompleted: 0 }); // student_dashboard
      expect(afterSubmit.exam).toMatchObject({
        in_progress_count: 0,
        pending_grading_count: 1,
        total_submissions: 0,
      }); // exam_analytics
      expect(afterSubmit.quiz.totalAttempts).toBe(1); // teacher_quiz_analytics
      expect(afterSubmit.quiz.averageScore).toBe(0); // submitted, not scored yet
      expect(subjectAverage(afterSubmit.progress)).toBeNull(); // not GRADED yet

      // --- POST teacher/exams/:id/answers/:answerId/grade ---
      await gradeEssay(teacher, fx, attemptId);
      const afterGrade = await readAllViews(student, teacher, fx.examId);
      expect(afterGrade.dashboard).toMatchObject({
        examsCompleted: 1,
        examsInProgress: 0,
        averageScore: GRADED_TOTAL,
      }); // student_dashboard
      expect(subjectAverage(afterGrade.progress)).toBe(GRADED_TOTAL); // student_report
      expect(afterGrade.exam).toMatchObject({
        total_submissions: 1,
        pending_grading_count: 0,
        average_score: GRADED_TOTAL,
      }); // exam_analytics
      expect(afterGrade.quiz.averageScore).toBe(GRADED_PERCENT); // teacher_quiz_analytics
    });
  });

  // ===============================================================================================
  // T035: owner isolation
  // ===============================================================================================

  describe("T035 - one owner's write does not evict another owner's cached entries", () => {
    it("student A starting and submitting leaves student B's cached dashboard and progress report untouched", async () => {
      const teacher = await createTeacher();
      const studentA = await createStudent();
      const studentB = await createStudent();
      const fx = await seedExam(teacher.userId);

      const warmA = {
        dashboard: await studentDashboard(studentA),
        progress: await studentProgress(studentA),
      };
      const warmB = {
        dashboard: await studentDashboard(studentB),
        progress: await studentProgress(studentB),
      };
      expect(warmB.dashboard.examsCompleted).toBe(0);
      expect(subjectAverage(warmB.progress)).toBeNull();

      // Change B's underlying data behind the cache's back: B now has a graded attempt in the database.
      await insertGradedAttemptBypassingApi(fx.examId, studentB.userId, 7);

      // A's writes, through the real routes.
      const attemptId = await startAttempt(studentA, fx.examId);
      expect(await studentDashboard(studentB)).toEqual(warmB.dashboard);
      expect(await studentProgress(studentB)).toEqual(warmB.progress);

      await saveAnswers(studentA, attemptId, fx);
      await submitAttempt(studentA, attemptId);

      // A's next read is fresh (their submitted attempt is now awaiting grading)...
      const freshA = await studentDashboard(studentA);
      expect(freshA).not.toEqual(warmA.dashboard);
      expect(freshA.examsInProgress).toBe(1);

      // ...and B's cached entries are exactly what was cached before, still ignoring the bypass write.
      expect(await studentDashboard(studentB)).toEqual(warmB.dashboard);
      expect(await studentProgress(studentB)).toEqual(warmB.progress);

      // Control: the bypass write is real. Bumping only B's own slices reveals it.
      await cache.invalidateScopes([
        { family: 'student_dashboard', scope: `owner:${studentB.userId}` },
        { family: 'student_report', scope: `owner:${studentB.userId}` },
      ]);
      expect(await studentDashboard(studentB)).toMatchObject({
        examsCompleted: 1,
        averageScore: 7,
      });
      expect(subjectAverage(await studentProgress(studentB))).toBe(7);
    });

    it("teacher grading student A's answer refreshes A but leaves student B's cached dashboard and progress report untouched", async () => {
      const teacher = await createTeacher();
      const studentA = await createStudent();
      const studentB = await createStudent();
      const fx = await seedExam(teacher.userId);

      // A already submitted; the essay is waiting for the teacher.
      const attemptId = await startAttempt(studentA, fx.examId);
      await saveAnswers(studentA, attemptId, fx);
      await submitAttempt(studentA, attemptId);

      const warmA = {
        dashboard: await studentDashboard(studentA),
        progress: await studentProgress(studentA),
      };
      const warmB = {
        dashboard: await studentDashboard(studentB),
        progress: await studentProgress(studentB),
      };
      expect(warmA.dashboard).toMatchObject({ examsInProgress: 1, examsCompleted: 0 });
      expect(subjectAverage(warmA.progress)).toBeNull();

      await insertGradedAttemptBypassingApi(fx.examId, studentB.userId, 7);

      await gradeEssay(teacher, fx, attemptId);

      // A's report and dashboard are fresh on the very next request.
      expect(await studentDashboard(studentA)).toMatchObject({
        examsCompleted: 1,
        examsInProgress: 0,
        averageScore: GRADED_TOTAL,
      });
      expect(subjectAverage(await studentProgress(studentA))).toBe(GRADED_TOTAL);

      // B's cached entries are intact (the bypass write is still invisible to B).
      expect(await studentDashboard(studentB)).toEqual(warmB.dashboard);
      expect(await studentProgress(studentB)).toEqual(warmB.progress);

      // Control: bumping only B's own slices reveals the bypass write.
      await cache.invalidateScopes([
        { family: 'student_dashboard', scope: `owner:${studentB.userId}` },
        { family: 'student_report', scope: `owner:${studentB.userId}` },
      ]);
      expect(await studentDashboard(studentB)).toMatchObject({
        examsCompleted: 1,
        averageScore: 7,
      });
      expect(subjectAverage(await studentProgress(studentB))).toBe(7);
    });

    it("a submit and a grade on teacher 1's exam leave teacher 2's cached report, exam analytics and quiz analytics untouched", async () => {
      const teacher1 = await createTeacher();
      const teacher2 = await createTeacher();
      const studentA = await createStudent();
      const studentB = await createStudent();
      const fx1 = await seedExam(teacher1.userId);
      const fx2 = await seedExam(teacher2.userId);

      const warm1 = await readAllViews(studentA, teacher1, fx1.examId);
      const warm2 = {
        exam: await examAnalytics(teacher2, fx2.examId),
        quiz: await quizTeacher(teacher2),
      };
      expect(warm2.exam.total_submissions).toBe(0);
      expect(warm2.quiz.totalAttempts).toBe(0);

      // Change teacher 2's underlying data behind the cache's back.
      await insertGradedAttemptBypassingApi(fx2.examId, studentB.userId, 7);

      const readTeacher2 = async () => ({
        exam: await examAnalytics(teacher2, fx2.examId),
        quiz: await quizTeacher(teacher2),
      });

      // Student A starts and submits teacher 1's exam.
      const attemptId = await startAttempt(studentA, fx1.examId);
      expect(await readTeacher2()).toEqual(warm2);
      await saveAnswers(studentA, attemptId, fx1);
      await submitAttempt(studentA, attemptId);

      // Teacher 1 sees the submission immediately...
      const fresh1 = await readAllViews(studentA, teacher1, fx1.examId);
      expect(fresh1.exam.pending_grading_count).toBe(1);
      expect(fresh1.quiz.totalAttempts).toBe(1);
      expect(fresh1.exam).not.toEqual(warm1.exam);

      // ...while teacher 2's three cached entries are exactly what was cached before.
      expect(await readTeacher2()).toEqual(warm2);

      // Grading on teacher 1's exam is equally invisible to teacher 2.
      await gradeEssay(teacher1, fx1, attemptId);
      expect((await examAnalytics(teacher1, fx1.examId)).total_submissions).toBe(1);
      expect(await readTeacher2()).toEqual(warm2);

      // Control: bumping only teacher 2's own slices reveals the bypass write.
      const teacher2Families: ApplicationCacheFamily[] = [
        'teacher_report',
        'exam_analytics',
        'teacher_quiz_analytics',
      ];
      await cache.invalidateScopes(
        teacher2Families.map((family) => ({ family, scope: `owner:${teacher2.userId}` })),
      );
      const revealed = await readTeacher2();
      expect(revealed.exam.total_submissions).toBe(1);
      expect(revealed.quiz.totalAttempts).toBe(1);
    });
  });

  // ===============================================================================================
  // T039: teacher quiz analytics
  // ===============================================================================================

  describe('T039 - teacher quiz analytics cache', () => {
    it('reflects a submit and a teacher grade on the next /analytics/quiz/teacher request', async () => {
      const teacher = await createTeacher();
      const student = await createStudent();
      const fx = await seedExam(teacher.userId);

      const empty = await quizTeacher(teacher);
      expect(empty.totalAttempts).toBe(0);

      const attemptId = await startAttempt(student, fx.examId);
      await saveAnswers(student, attemptId, fx);
      expect((await quizTeacher(teacher)).totalAttempts).toBe(0); // IN_PROGRESS is not analytics

      await submitAttempt(student, attemptId);
      const submitted = await quizTeacher(teacher);
      expect(submitted.totalAttempts).toBe(1);
      expect(submitted.averageScore).toBe(0); // no score yet: essay pending

      await gradeEssay(teacher, fx, attemptId);
      const graded = await quizTeacher(teacher);
      expect(graded.totalAttempts).toBe(1);
      expect(graded.averageScore).toBe(GRADED_PERCENT);
      expect(graded.passRate).toBe(100);
      expect(graded.gradeDistribution).toContainEqual({ range: '65–84%', count: 1 });
      expect(graded.examComparisons).toEqual([
        expect.objectContaining({ examId: fx.examId, attempts: 1, avgPercent: GRADED_PERCENT }),
      ]);
      expect(graded.leaderboard).toHaveLength(1);
      expect(graded.leaderboard[0]).toMatchObject({ avgPercent: GRADED_PERCENT, attempts: 1 });
    });

    it('serves a repeat /analytics/quiz/teacher from the cache (a DB-bypass write is hidden) until the next attempt write invalidates it', async () => {
      const teacher = await createTeacher();
      const studentA = await createStudent();
      const studentB = await createStudent();
      const fx = await seedExam(teacher.userId);

      const attemptId = await completeGradedAttempt(studentA, teacher, fx);
      const warm = await quizTeacher(teacher);
      expect(warm.averageScore).toBe(GRADED_PERCENT);
      expect(warm.totalAttempts).toBe(1);

      // The database now says 20%, but no invalidation ran: a cache hit must still say 80%.
      await ctx.dataSource.query(`UPDATE exam_attempts SET score_total = 2 WHERE id = $1`, [
        attemptId,
      ]);
      expect(await quizTeacher(teacher)).toEqual(warm);
      expect((await quizTeacher(teacher)).averageScore).toBe(GRADED_PERCENT);

      // Student B submitting is a real attempt write on the teacher's exam: the next read is fresh
      // and now shows the bypass write too (proving it was real, not that the query ignores it).
      const attemptB = await startAttempt(studentB, fx.examId);
      await saveAnswers(studentB, attemptB, fx);
      await submitAttempt(studentB, attemptB);

      const fresh = await quizTeacher(teacher);
      expect(fresh.totalAttempts).toBe(2);
      expect(fresh.averageScore).toBe(20); // only A's (now 2/10) attempt is scored
    });

    it('per-exam analytics: another teacher gets 403 even after the owner warmed that exact entry, and the owner keeps getting the cached entry', async () => {
      const owner = await createTeacher();
      const otherTeacher = await createTeacher();
      const student = await createStudent();
      const studentB = await createStudent();
      const fx = await seedExam(owner.userId);

      const attemptId = await completeGradedAttempt(student, owner, fx);

      // The owner warms the per-exam entry.
      const warm = await quizExam(owner, fx.examId);
      expect(warm).toEqual([expect.objectContaining({ correctPercentage: 100, attempts: 1 })]);
      expect(await quizExam(owner, fx.examId)).toEqual(warm);

      // Bypass write: the choice answer is now wrong in the database.
      await ctx.dataSource.query(
        `UPDATE exam_attempt_answers SET is_correct = false WHERE attempt_id = $1 AND exam_question_id = $2`,
        [attemptId, fx.choiceEqId],
      );

      // A non-owner is refused before any cache read, whether or not the entry is warm.
      const refused = await otherTeacher.agent
        .get(`${API_PREFIX}/analytics/quiz/teacher/exams/${fx.examId}`)
        .expect(403);
      expect((refused.body as { data?: unknown }).data).toBeUndefined();
      expect(JSON.stringify(refused.body)).not.toContain(warm[0]!.questionId);

      // The owner still gets the cached entry (the bypass write is hidden)...
      expect(await quizExam(owner, fx.examId)).toEqual(warm);

      // ...until a real attempt write on the exam invalidates the owner's slice.
      const attemptB = await startAttempt(studentB, fx.examId);
      await saveAnswers(studentB, attemptB, fx);
      await submitAttempt(studentB, attemptB);
      expect(await quizExam(owner, fx.examId)).toEqual([
        expect.objectContaining({ correctPercentage: 0, attempts: 1 }),
      ]);

      // And the non-owner is still refused afterwards.
      await otherTeacher.agent
        .get(`${API_PREFIX}/analytics/quiz/teacher/exams/${fx.examId}`)
        .expect(403);
    });

    it('statement counts: a /analytics/quiz/teacher hit issues no exam statements and a per-exam hit issues only the ownership lookup', async () => {
      const teacher = await createTeacher();
      const student = await createStudent();
      const fx = await seedExam(teacher.userId);
      await completeGradedAttempt(student, teacher, fx);

      const probe = async (
        user: AuthenticatedUser,
        path: string,
        requestId: string,
      ): Promise<StatementCounter> => {
        const counter = new StatementCounter(ctx.dataSource);
        counter.start();
        await user.agent.get(`${API_PREFIX}${path}`).set('X-Request-Id', requestId).expect(200);
        counter.stop();
        return counter;
      };

      // /analytics/quiz/teacher: the first read computes (must touch exam_attempts, else the counter is blind)...
      const teacherMiss = await probe(teacher, '/analytics/quiz/teacher', 't039-teacher-miss');
      expect(
        teacherMiss.count({ requestId: 't039-teacher-miss', table: 'exam_attempts' }),
      ).toBeGreaterThan(0);
      // ...and the repeat is a hit: no statement reads the exam tables at all.
      const teacherHit = await probe(teacher, '/analytics/quiz/teacher', 't039-teacher-hit');
      expect(teacherHit.count({ requestId: 't039-teacher-hit', table: 'exam_attempts' })).toBe(0);
      expect(
        teacherHit.count({ requestId: 't039-teacher-hit', table: 'exam_attempt_answers' }),
      ).toBe(0);
      expect(teacherHit.count({ requestId: 't039-teacher-hit', table: 'exams' })).toBe(0);

      // /analytics/quiz/teacher/exams/:examId: miss = ownership lookup + aggregate; hit = ownership lookup only.
      const examPath = `/analytics/quiz/teacher/exams/${fx.examId}`;
      const examMiss = await probe(teacher, examPath, 't039-exam-miss');
      expect(examMiss.count({ requestId: 't039-exam-miss', table: 'exams' })).toBe(1);
      expect(
        examMiss.count({ requestId: 't039-exam-miss', table: 'exam_attempt_answers' }),
      ).toBeGreaterThan(0);
      const examHit = await probe(teacher, examPath, 't039-exam-hit');
      expect(examHit.count({ requestId: 't039-exam-hit', table: 'exams' })).toBe(1);
      expect(examHit.count({ requestId: 't039-exam-hit', table: 'exam_attempts' })).toBe(0);
      expect(examHit.count({ requestId: 't039-exam-hit', table: 'exam_attempt_answers' })).toBe(0);
    });
  });

  // ===============================================================================================
  // Invalidation contract: exact calls per route, unrelated families untouched
  // ===============================================================================================

  describe('invalidation contract - exact cache calls per exam route', () => {
    const studentFamilies = ['student_dashboard', 'student_profile', 'student_report'] as const;
    const teacherFamilies = ['teacher_report', 'exam_analytics'] as const;

    it("POST student/exams/:id/start invalidates the student's and the exam owner's slices plus the two role families, never teacher_quiz_analytics or the global generation", async () => {
      const teacher = await createTeacher();
      const student = await createStudent();
      const fx = await seedExam(teacher.userId);
      const watch = watchInvalidation();

      await startAttempt(student, fx.examId);

      expect(watch.invalidateAll).not.toHaveBeenCalled();
      expect(familyLevelFamilies(watch)).toEqual(['admin_dashboard', 'platform_report']);
      expect(scopedSlices(watch)).toEqual(
        [
          ...slicesOf(studentFamilies, student.userId),
          ...slicesOf(teacherFamilies, teacher.userId),
        ].sort(),
      );
      expect(scopedSlices(watch)).not.toContain(`teacher_quiz_analytics@owner:${teacher.userId}`);
    });

    it('PATCH student/exams/attempts/:attemptId/answers (autosave) invalidates nothing and leaves a warmed exam analytics entry cached', async () => {
      const teacher = await createTeacher();
      const student = await createStudent();
      const fx = await seedExam(teacher.userId);
      const attemptId = await startAttempt(student, fx.examId);

      const warmExam = await examAnalytics(teacher, fx.examId);
      const warmQuiz = await quizTeacher(teacher);
      const watch = watchInvalidation();

      await saveAnswers(student, attemptId, fx);

      expect(watch.invalidateAll).not.toHaveBeenCalled();
      expect(watch.invalidate).not.toHaveBeenCalled();
      expect(watch.invalidateScopes).not.toHaveBeenCalled();
      // `calculated_at` is stamped on every recompute, so an identical value means a cache hit.
      expect(await examAnalytics(teacher, fx.examId)).toEqual(warmExam);
      expect(await quizTeacher(teacher)).toEqual(warmQuiz);
    });

    it("POST student/exams/attempts/:attemptId/submit additionally invalidates the owner's teacher_quiz_analytics, but not admin_dashboard, and never the global generation", async () => {
      const teacher = await createTeacher();
      const student = await createStudent();
      const fx = await seedExam(teacher.userId);
      const attemptId = await startAttempt(student, fx.examId);
      await saveAnswers(student, attemptId, fx);
      const watch = watchInvalidation();

      await submitAttempt(student, attemptId);

      expect(watch.invalidateAll).not.toHaveBeenCalled();
      expect(familyLevelFamilies(watch)).toEqual(['platform_report']);
      expect(scopedSlices(watch)).toEqual(
        [
          ...slicesOf(studentFamilies, student.userId),
          ...slicesOf([...teacherFamilies, 'teacher_quiz_analytics'], teacher.userId),
        ].sort(),
      );
    });

    it("POST teacher/exams/:id/answers/:answerId/grade invalidates the teacher's own slices and the graded student's slices only, with no family-level or global bump", async () => {
      const teacher = await createTeacher();
      const student = await createStudent();
      const fx = await seedExam(teacher.userId);
      const attemptId = await startAttempt(student, fx.examId);
      await saveAnswers(student, attemptId, fx);
      await submitAttempt(student, attemptId);
      const watch = watchInvalidation();

      await gradeEssay(teacher, fx, attemptId);

      expect(watch.invalidateAll).not.toHaveBeenCalled();
      expect(watch.invalidate).not.toHaveBeenCalled();
      expect(scopedSlices(watch)).toEqual(
        [
          ...slicesOf(studentFamilies, student.userId),
          ...slicesOf([...teacherFamilies, 'teacher_quiz_analytics'], teacher.userId),
        ].sort(),
      );
      // The grader's own id is never used as the student's scope (and vice versa).
      expect(scopedSlices(watch)).not.toContain(`student_report@owner:${teacher.userId}`);
      expect(scopedSlices(watch)).not.toContain(`teacher_report@owner:${student.userId}`);
    });
  });
});
