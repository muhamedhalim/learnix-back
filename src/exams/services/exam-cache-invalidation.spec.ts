import { AttemptState, ExamAttempt } from '../entities';
import { AttemptService } from './attempt.service';
import {
  studentExamCacheScopes,
  teacherExamCacheScopes,
  teacherQuizCacheScopes,
} from './exam-cache-scopes';
import { TeacherGradingService } from './teacher-grading.service';

const STUDENT = 'student-a';
const TEACHER = 'teacher-a';

/** Slices invalidated when an attempt is started (IN_PROGRESS: quiz analytics ignore it). */
function scopes(studentId: string, teacherId: string) {
  return [...studentExamCacheScopes(studentId), ...teacherExamCacheScopes(teacherId)];
}

/** Slices invalidated when an attempt reaches submission/grading. */
function finalizedScopes(studentId: string, teacherId: string) {
  return [...scopes(studentId, teacherId), ...teacherQuizCacheScopes(teacherId)];
}

describe('exam cache scopes', () => {
  it('scopes the student families to the student and the teacher families to the exam owner', () => {
    expect(scopes(STUDENT, TEACHER)).toEqual([
      { family: 'student_dashboard', scope: 'owner:student-a' },
      { family: 'student_profile', scope: 'owner:student-a' },
      { family: 'student_report', scope: 'owner:student-a' },
      { family: 'teacher_report', scope: 'owner:teacher-a' },
      { family: 'exam_analytics', scope: 'owner:teacher-a' },
    ]);
  });
});

describe('AttemptService cache invalidation', () => {
  function build(options: { state?: AttemptState; invalidateScopes?: jest.Mock } = {}) {
    const attempt = {
      id: 'attempt-1',
      exam_id: 'exam-1',
      student_id: STUDENT,
      state: options.state ?? AttemptState.IN_PROGRESS,
      score_auto: 0,
      score_total: 0,
      max_score: 10,
      passed: false,
      auto_submitted: false,
      submitted_at: null,
    } as unknown as ExamAttempt;
    const exam = {
      id: 'exam-1',
      teacher_id: TEACHER,
      passing_marks: 5,
      config: { negative_marking: false },
    };
    const manager = {
      findOne: jest.fn().mockResolvedValue(attempt),
      findOneOrFail: jest.fn().mockResolvedValue(exam),
      find: jest.fn().mockResolvedValue([]),
    };
    const dataSource = {
      transaction: jest.fn(async (fn: (m: unknown) => unknown) => await fn(manager)),
    };
    const order: string[] = [];
    const jobs = {
      cancelAutoSubmit: jest.fn(async () => order.push('cancelAutoSubmit')),
      enqueueAnalytics: jest.fn(async () => order.push('enqueueAnalytics')),
      enqueueAiGrade: jest.fn(),
    };
    const invalidateScopes =
      options.invalidateScopes ?? jest.fn(async () => order.push('invalidateScopes'));
    const grading = {
      applyObjectiveGrades: jest.fn(),
      recomputeAndPersist: jest.fn().mockResolvedValue(attempt),
    };
    const service = new AttemptService(
      {} as never,
      {} as never,
      { findOne: jest.fn().mockResolvedValue(attempt) } as never,
      {} as never,
      dataSource as never,
      grading as never,
      jobs as never,
      {} as never,
      { publishIfGraded: jest.fn() } as never,
      {} as never,
      { invalidateScopes } as never,
    );
    return { service, invalidateScopes, jobs, order, manager };
  }

  it('invalidates exactly the student and the exam owner after a finalization commits', async () => {
    const { service, invalidateScopes } = build();

    await service.finalizeExpired('attempt-1');

    expect(invalidateScopes).toHaveBeenCalledTimes(1);
    expect(invalidateScopes).toHaveBeenCalledWith(finalizedScopes(STUDENT, TEACHER));
    expect(invalidateScopes.mock.calls[0]?.[0]).toContainEqual({
      family: 'teacher_quiz_analytics',
      scope: 'owner:teacher-a',
    });
  });

  it('invalidates before any queue call so a queue failure cannot leave caches stale', async () => {
    const { service, order } = build();

    await service.finalizeExpired('attempt-1');

    expect(order[0]).toBe('invalidateScopes');
    expect(order).toEqual(['invalidateScopes', 'cancelAutoSubmit', 'enqueueAnalytics']);
  });

  it('does not invalidate when the attempt was already finalised (no write happened)', async () => {
    const { service, invalidateScopes, manager } = build();
    manager.findOne.mockResolvedValue({
      id: 'attempt-1',
      exam_id: 'exam-1',
      student_id: STUDENT,
      state: AttemptState.GRADED,
      score_auto: 1,
      score_total: 1,
      max_score: 10,
      passed: false,
      auto_submitted: false,
      submitted_at: new Date(),
    });

    // submit() on a finalised attempt goes through the same idempotent branch.
    await (
      service as unknown as { finalize: (id: string, o: { auto: boolean }) => Promise<unknown> }
    ).finalize('attempt-1', { auto: false });

    expect(invalidateScopes).not.toHaveBeenCalled();
  });

  it('still completes the finalization when cache invalidation fails', async () => {
    const failing = jest.fn().mockRejectedValue(new Error('redis down'));
    const { service, jobs } = build({ invalidateScopes: failing });

    await expect(service.finalizeExpired('attempt-1')).resolves.toEqual(
      expect.objectContaining({ attempt_id: 'attempt-1' }),
    );

    expect(failing).toHaveBeenCalledTimes(1);
    expect(jobs.cancelAutoSubmit).toHaveBeenCalledTimes(1);
    expect(jobs.enqueueAnalytics).toHaveBeenCalledTimes(1);
  });
});

describe('AttemptService.startAttempt cache invalidation', () => {
  function build(options: { inProgress?: unknown; invalidateScopes?: jest.Mock } = {}) {
    const exam = {
      id: 'exam-1',
      teacher_id: TEACHER,
      total_marks: 10,
      config: { duration_seconds: 600, grace_seconds: 30, attempts_allowed: 3 },
    };
    const created = { id: 'attempt-9' };
    const manager = {
      create: jest.fn((_entity: unknown, value: object) => ({ ...value })),
      save: jest.fn(async (_entity: unknown, value: object) =>
        Array.isArray(value) ? value : { ...value, ...created },
      ),
    };
    const order: string[] = [];
    const jobs = { scheduleAutoSubmit: jest.fn(async () => order.push('scheduleAutoSubmit')) };
    const invalidateScopes =
      options.invalidateScopes ?? jest.fn(async () => order.push('invalidateScopes'));
    const service = new AttemptService(
      {} as never,
      {
        find: jest
          .fn()
          .mockResolvedValue([{ id: 'eq-1', question_id: 'q-1', question_version: 1, marks: 5 }]),
      } as never,
      {
        findOne: jest.fn().mockResolvedValue(options.inProgress ?? null),
        count: jest.fn().mockResolvedValue(0),
      } as never,
      {} as never,
      { transaction: jest.fn(async (fn: (m: unknown) => unknown) => await fn(manager)) } as never,
      {} as never,
      jobs as never,
      { findAccessibleExam: jest.fn().mockResolvedValue(exam) } as never,
      {} as never,
      {} as never,
      { invalidateScopes } as never,
    );
    jest
      .spyOn(service as never, 'assertOpen' as never)
      .mockImplementation(() => undefined as never);
    jest
      .spyOn(service as never, 'renderAttempt' as never)
      .mockResolvedValue({ attempt_id: 'attempt-9' } as never);
    return { service, invalidateScopes, jobs, order };
  }

  it("invalidates the student's and the exam owner's slices when a new attempt is created", async () => {
    const { service, invalidateScopes } = build();

    await service.startAttempt(STUDENT, 'exam-1');

    expect(invalidateScopes).toHaveBeenCalledTimes(1);
    expect(invalidateScopes).toHaveBeenCalledWith(scopes(STUDENT, TEACHER));
    // A new attempt is IN_PROGRESS; teacher quiz analytics ignore it, so it is not invalidated.
    expect(invalidateScopes.mock.calls[0]?.[0]).not.toContainEqual(
      expect.objectContaining({ family: 'teacher_quiz_analytics' }),
    );
  });

  it('invalidates before scheduling the auto-submit job, which can fail the request', async () => {
    const { service, order } = build();

    await service.startAttempt(STUDENT, 'exam-1');

    expect(order).toEqual(['invalidateScopes', 'scheduleAutoSubmit']);
  });

  it('does not invalidate when it only resumes an unexpired attempt (nothing was written)', async () => {
    const inProgress = { id: 'attempt-1', state: AttemptState.IN_PROGRESS };
    const { service, invalidateScopes } = build({ inProgress });
    jest
      .spyOn(service as never, 'finalizeIfExpired' as never)
      .mockResolvedValue(inProgress as never);

    await service.startAttempt(STUDENT, 'exam-1');

    expect(invalidateScopes).not.toHaveBeenCalled();
  });

  it('still starts the attempt when cache invalidation fails', async () => {
    const failing = jest.fn().mockRejectedValue(new Error('redis down'));
    const { service, jobs } = build({ invalidateScopes: failing });

    await expect(service.startAttempt(STUDENT, 'exam-1')).resolves.toEqual({
      attempt_id: 'attempt-9',
    });

    expect(jobs.scheduleAutoSubmit).toHaveBeenCalledTimes(1);
  });
});

describe('TeacherGradingService cache invalidation', () => {
  function build(invalidateScopes: jest.Mock) {
    const attempt = { id: 'attempt-1', exam_id: 'exam-1', student_id: STUDENT };
    const exams = {
      findOne: jest.fn().mockResolvedValue({ id: 'exam-1', teacher_id: TEACHER, passing_marks: 5 }),
    };
    const answers = {
      findOne: jest.fn().mockResolvedValue({
        id: 'answer-1',
        attempt_id: 'attempt-1',
        exam_question_id: 'eq-1',
        max_score: 10,
      }),
    };
    const attempts = { findOne: jest.fn().mockResolvedValue(attempt) };
    const examQuestions = {
      findOne: jest.fn().mockResolvedValue({ id: 'eq-1', type_snapshot: 'essay' }),
    };
    const manager = {
      findOneOrFail: jest.fn(async () => ({ id: 'attempt-1' })),
      save: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
    };
    const dataSource = {
      transaction: jest.fn(async (fn: (m: unknown) => unknown) => await fn(manager)),
    };
    const orchestrator = {
      recomputeAndPersist: jest
        .fn()
        .mockResolvedValue({ state: AttemptState.GRADED, score_total: 8 }),
    };
    const order: string[] = [];
    const jobs = { enqueueAnalytics: jest.fn(async () => order.push('enqueueAnalytics')) };
    const service = new TeacherGradingService(
      exams as never,
      attempts as never,
      answers as never,
      examQuestions as never,
      dataSource as never,
      orchestrator as never,
      jobs as never,
      { publishIfGraded: jest.fn() } as never,
      { invalidateScopes } as never,
    );
    return { service, order, jobs };
  }

  it("invalidates only the graded student's slice; the teacher's own slice is the route's `self`", async () => {
    const invalidateScopes = jest.fn().mockResolvedValue(undefined);
    const { service } = build(invalidateScopes);

    await service.gradeAnswer('exam-1', 'answer-1', TEACHER, { score: 8 } as never);

    expect(invalidateScopes).toHaveBeenCalledTimes(1);
    expect(invalidateScopes).toHaveBeenCalledWith(studentExamCacheScopes(STUDENT));
  });

  it('never fails a committed grade because the cache is unavailable', async () => {
    const invalidateScopes = jest.fn().mockRejectedValue(new Error('redis down'));
    const { service, jobs } = build(invalidateScopes);

    await expect(
      service.gradeAnswer('exam-1', 'answer-1', TEACHER, { score: 8 } as never),
    ).resolves.toEqual(
      expect.objectContaining({ attempt_id: 'attempt-1', state: AttemptState.GRADED }),
    );

    expect(jobs.enqueueAnalytics).toHaveBeenCalledTimes(1);
  });
});
