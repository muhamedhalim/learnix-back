import { ConflictException, NotFoundException } from '@nestjs/common';

import { FindOperator } from 'typeorm';

import { AttemptState, Exam, ExamAttempt, ExamStatus, ReviewPolicy } from '../entities';
import { AttemptService } from './attempt.service';

function buildService(options?: { attempt?: ExamAttempt }): {
  service: AttemptService;
  access: {
    findAccessiblePrivateExam: jest.Mock;
    assertCanAccessPrivateExam: jest.Mock;
    findAccessibleExam: jest.Mock;
    assertCanAccessExam: jest.Mock;
  };
  attempts: { findOne: jest.Mock; count: jest.Mock };
  dataSource: { transaction: jest.Mock };
} {
  const denied = new NotFoundException('Exam not found');
  const access = {
    findAccessiblePrivateExam: jest.fn().mockRejectedValue(denied),
    assertCanAccessPrivateExam: jest.fn().mockRejectedValue(denied),
    findAccessibleExam: jest.fn().mockRejectedValue(denied),
    assertCanAccessExam: jest.fn().mockRejectedValue(denied),
  };
  const attempts = {
    findOne: jest.fn().mockResolvedValue(options?.attempt ?? null),
    count: jest.fn(),
  };
  const dataSource = { transaction: jest.fn() };
  const service = new AttemptService(
    {} as never,
    {} as never,
    attempts as never,
    {} as never,
    dataSource as never,
    {} as never,
    {} as never,
    access as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, access, attempts, dataSource };
}

describe('AttemptService audience enforcement', () => {
  it('prevents an unaffiliated student from initiating an attempt by exam id', async () => {
    const { service, access, attempts } = buildService();

    await expect(service.startAttempt('other-student', 'private-exam')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(access.findAccessibleExam).toHaveBeenCalledWith('other-student', 'private-exam');
    expect(attempts.findOne).not.toHaveBeenCalled();
  });

  it('prevents an out-of-scope student from saving or submitting an owned attempt', async () => {
    const attempt = {
      id: 'attempt-1',
      exam_id: 'private-exam',
      student_id: 'student-1',
      state: AttemptState.IN_PROGRESS,
    } as ExamAttempt;
    const { service, access, dataSource } = buildService({ attempt });

    await expect(
      service.saveAnswers('student-1', attempt.id, { answers: [] }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.submit('student-1', attempt.id, { answers: [] })).rejects.toBeInstanceOf(
      NotFoundException,
    );

    // Both operations still run the audience-scoped check: autosave through the lookup whose
    // result it reuses (T072), submit through the plain check.
    expect(access.findAccessibleExam).toHaveBeenCalledTimes(1);
    expect(access.findAccessibleExam).toHaveBeenCalledWith('student-1', 'private-exam');
    expect(access.assertCanAccessExam).toHaveBeenCalledTimes(1);
    expect(access.assertCanAccessExam).toHaveBeenCalledWith('student-1', 'private-exam');
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('does not distinguish a foreign attempt from an unknown attempt', async () => {
    const attempt = { id: 'attempt-1', student_id: 'student-2' } as ExamAttempt;
    const { service, attempts, access } = buildService();

    await expect(service.getAttempt('student-1', attempt.id)).rejects.toBeInstanceOf(NotFoundException);
    expect(attempts.findOne).toHaveBeenCalledWith({
      where: { id: attempt.id, student_id: 'student-1' },
    });
    expect(access.assertCanAccessExam).not.toHaveBeenCalled();
  });
});

/**
 * T072: the duplicate exam/answer reads are gone, but nothing that guards the exam is: the
 * audience-scoped lookup still runs on every autosave/result/resume, the locked exam read inside
 * `finalize` stays, and a finalised attempt is still re-read after `finalize`.
 */
describe('AttemptService repeated-read removal', () => {
  const exam = {
    id: 'exam-1',
    teacher_id: 'teacher-1',
    total_marks: 10,
    passing_marks: 5,
    status: ExamStatus.PUBLISHED,
    config: {
      grace_seconds: 0,
      duration_seconds: 600,
      attempts_allowed: 2,
      review_policy: ReviewPolicy.AFTER_SUBMIT,
      shuffle_questions: false,
      shuffle_choices: false,
    },
  };
  const attemptRow = (over: Record<string, unknown> = {}): ExamAttempt =>
    ({
      id: 'attempt-1',
      exam_id: 'exam-1',
      student_id: 'student-1',
      state: AttemptState.IN_PROGRESS,
      started_at: new Date(Date.now() - 60_000),
      deadline_at: new Date(Date.now() + 600_000),
      shuffle_seed: 7,
      session_token: 'token',
      attempt_number: 1,
      ...over,
    }) as unknown as ExamAttempt;

  function rich() {
    const exams = { findOneOrFail: jest.fn().mockResolvedValue(exam) };
    const examQuestions = { find: jest.fn().mockResolvedValue([]) };
    const attempts = {
      findOne: jest.fn(),
      findOneOrFail: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    };
    const answers = { find: jest.fn().mockResolvedValue([]), save: jest.fn() };
    const manager = {
      findOne: jest.fn(),
      findOneOrFail: jest.fn().mockResolvedValue(exam),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn(async (_target: unknown, value: unknown) =>
        Array.isArray(value) ? value : { id: 'attempt-new', ...(value as object) },
      ),
      create: jest.fn((_target: unknown, value: unknown) => value),
    };
    const dataSource = {
      transaction: jest.fn(async (work: (m: typeof manager) => unknown) => work(manager)),
      getRepository: jest.fn().mockReturnValue({ find: jest.fn().mockResolvedValue([]) }),
    };
    const orchestrator = {
      applyObjectiveGrades: jest.fn(),
      recomputeAndPersist: jest.fn(async (_m: unknown, attempt: ExamAttempt) => ({
        ...attempt,
        state: AttemptState.GRADED,
      })),
    };
    const jobs = {
      scheduleAutoSubmit: jest.fn(),
      cancelAutoSubmit: jest.fn(),
      enqueueAnalytics: jest.fn(),
      enqueueAiGrade: jest.fn(),
    };
    const access = {
      findAccessibleExam: jest.fn().mockResolvedValue(exam),
      assertCanAccessExam: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AttemptService(
      exams as never,
      examQuestions as never,
      attempts as never,
      answers as never,
      dataSource as never,
      orchestrator as never,
      jobs as never,
      access as never,
      { publishIfGraded: jest.fn() } as never,
      { require: jest.fn(() => ({ validateResponse: jest.fn(() => []) })) } as never,
      { invalidateScopes: jest.fn() } as never,
    );
    return { service, exams, examQuestions, attempts, answers, manager, dataSource, access, orchestrator };
  }

  const NOT_FOUND = new NotFoundException('Exam not found');

  describe('autosave', () => {
    it('keeps the audience-scoped exam lookup on every save and reuses its result (no second exam read)', async () => {
      const { service, exams, attempts, access, answers } = rich();
      attempts.findOne.mockResolvedValue(attemptRow());
      answers.find.mockResolvedValue([]);

      await service.saveAnswers('student-1', 'attempt-1', { answers: [{ exam_question_id: 'eq-1' }] });

      expect(access.findAccessibleExam).toHaveBeenCalledTimes(1);
      expect(access.findAccessibleExam).toHaveBeenCalledWith('student-1', 'exam-1');
      expect(exams.findOneOrFail).not.toHaveBeenCalled();
    });

    it('a refund mid-exam (the scoped lookup now fails) stops the save before any answer is read or written', async () => {
      const { service, attempts, access, answers } = rich();
      attempts.findOne.mockResolvedValue(attemptRow());
      access.findAccessibleExam.mockRejectedValue(NOT_FOUND);

      await expect(
        service.saveAnswers('student-1', 'attempt-1', { answers: [{ exam_question_id: 'eq-1' }] }),
      ).rejects.toBe(NOT_FOUND);

      expect(answers.find).not.toHaveBeenCalled();
      expect(answers.save).not.toHaveBeenCalled();
    });

    it('loads only the answer rows the payload names, and only their questions', async () => {
      const { service, attempts, answers, examQuestions } = rich();
      attempts.findOne.mockResolvedValue(attemptRow());
      const row = { exam_question_id: 'eq-2', response: null, answered_at: null, time_spent_ms: 0 };
      answers.find.mockResolvedValue([row]);
      examQuestions.find.mockResolvedValue([{ id: 'eq-2', type_snapshot: 'essay' }]);

      const result = await service.saveAnswers('student-1', 'attempt-1', {
        answers: [{ exam_question_id: 'eq-2', response: { text: 'a' }, time_spent_ms: 5 }],
      });

      expect(result).toEqual({ saved: 1, state: AttemptState.IN_PROGRESS });
      const where = (answers.find.mock.calls[0] as [{ where: { attempt_id: string; exam_question_id: FindOperator<string> } }])[0].where;
      expect(where.attempt_id).toBe('attempt-1');
      expect(where.exam_question_id).toBeInstanceOf(FindOperator);
      expect(where.exam_question_id.value).toEqual(['eq-2']);
      const questionWhere = (examQuestions.find.mock.calls[0] as [{ where: { id: FindOperator<string> } }])[0].where;
      expect(questionWhere.id.value).toEqual(['eq-2']);
      expect(answers.save).toHaveBeenCalledWith([row]);
    });

    it('ignores items that are not part of this attempt, as before', async () => {
      const { service, attempts, answers, examQuestions } = rich();
      attempts.findOne.mockResolvedValue(attemptRow());
      answers.find.mockResolvedValue([]);

      const result = await service.saveAnswers('student-1', 'attempt-1', {
        answers: [{ exam_question_id: 'someone-elses' }],
      });

      expect(result).toEqual({ saved: 0, state: AttemptState.IN_PROGRESS });
      expect(examQuestions.find).not.toHaveBeenCalled();
      expect(answers.save).not.toHaveBeenCalled();
    });

    it('an empty payload reads no answers or questions', async () => {
      const { service, attempts, answers, examQuestions } = rich();
      attempts.findOne.mockResolvedValue(attemptRow());

      await expect(service.saveAnswers('student-1', 'attempt-1', { answers: [] })).resolves.toEqual({
        saved: 0,
        state: AttemptState.IN_PROGRESS,
      });
      expect(answers.find).not.toHaveBeenCalled();
      expect(examQuestions.find).not.toHaveBeenCalled();
    });

    it('a payload naming the same question twice behaves as before: one lookup, time added twice', async () => {
      const { service, attempts, answers, examQuestions } = rich();
      attempts.findOne.mockResolvedValue(attemptRow());
      const row = { exam_question_id: 'eq-1', response: null, answered_at: null, time_spent_ms: 0 };
      answers.find.mockResolvedValue([row]);
      examQuestions.find.mockResolvedValue([{ id: 'eq-1', type_snapshot: 'essay' }]);

      const result = await service.saveAnswers('student-1', 'attempt-1', {
        answers: [
          { exam_question_id: 'eq-1', response: { text: 'a' }, time_spent_ms: 10 },
          { exam_question_id: 'eq-1', response: { text: 'b' }, time_spent_ms: 20 },
        ],
      });

      expect(result.saved).toBe(2);
      expect(row.time_spent_ms).toBe(30);
      expect(row).toMatchObject({ response: { text: 'b' } });
      expect((answers.find.mock.calls[0] as [{ where: { exam_question_id: FindOperator<string> } }])[0].where.exam_question_id.value).toEqual(['eq-1']);
    });

    it('an expired attempt is finalised using the already-loaded exam and the save is refused', async () => {
      const { service, attempts, exams, answers } = rich();
      attempts.findOne.mockResolvedValue(attemptRow({ deadline_at: new Date(Date.now() - 10_000) }));
      const finalize = jest
        .spyOn(service as unknown as { finalize: (id: string, o: unknown) => Promise<unknown> }, 'finalize')
        .mockResolvedValue({});
      attempts.findOneOrFail.mockResolvedValue(attemptRow({ state: AttemptState.GRADED }));

      await expect(
        service.saveAnswers('student-1', 'attempt-1', { answers: [{ exam_question_id: 'eq-1' }] }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(exams.findOneOrFail).not.toHaveBeenCalled();
      expect(finalize).toHaveBeenCalledWith('attempt-1', { auto: true });
      expect(answers.find).not.toHaveBeenCalled();
    });
  });

  describe('result', () => {
    it('keeps the scoped lookup, reuses its exam, and reads no second exam', async () => {
      const { service, attempts, exams, access, answers } = rich();
      attempts.findOne.mockResolvedValue(attemptRow({ state: AttemptState.GRADED }));
      answers.find.mockResolvedValue([]);

      const result = (await service.getResult('student-1', 'exam-1')) as { available: boolean };

      expect(result.available).toBe(true);
      expect(access.findAccessibleExam).toHaveBeenCalledWith('student-1', 'exam-1');
      expect(exams.findOneOrFail).not.toHaveBeenCalled();
    });

    it('a revoked or deleted exam (scoped lookup fails) shows no result and reads no attempt', async () => {
      const { service, attempts, access } = rich();
      access.findAccessibleExam.mockRejectedValue(NOT_FOUND);

      await expect(service.getResult('student-1', 'exam-1')).rejects.toBe(NOT_FOUND);
      expect(attempts.findOne).not.toHaveBeenCalled();
    });
  });

  describe('start and resume', () => {
    it('a new attempt renders from the exam and questions it already loaded', async () => {
      const { service, attempts, exams, examQuestions } = rich();
      attempts.findOne.mockResolvedValue(null);
      examQuestions.find.mockResolvedValue([
        { id: 'eq-1', question_id: 'q-1', question_version: 1, marks: 1, order_index: 0, section_id: 's-1', type_snapshot: 'essay', content_snapshot: {} },
      ]);

      const rendered = await service.startAttempt('student-1', 'exam-1');

      expect(rendered.exam_id).toBe('exam-1');
      expect(Array.isArray(rendered.questions)).toBe(true);
      expect(exams.findOneOrFail).not.toHaveBeenCalled();
      expect(examQuestions.find).toHaveBeenCalledTimes(1);
    });

    it('resuming an expired attempt finalises under the lock, re-reads the attempt, and reads the exam once', async () => {
      const { service, attempts, exams, access, answers } = rich();
      const expired = attemptRow({ deadline_at: new Date(Date.now() - 10_000) });
      attempts.findOne.mockResolvedValue(expired);
      const finalize = jest
        .spyOn(service as unknown as { finalize: (id: string, o: unknown) => Promise<unknown> }, 'finalize')
        .mockResolvedValue({});
      const reread = attemptRow({ state: AttemptState.GRADED });
      attempts.findOneOrFail.mockResolvedValue(reread);
      answers.find.mockResolvedValue([]);

      const rendered = await service.startAttempt('student-1', 'exam-1');

      expect(access.findAccessibleExam).toHaveBeenCalledTimes(1);
      expect(exams.findOneOrFail).not.toHaveBeenCalled();
      // The pre-lock exam never reaches finalize, and the finalised attempt is re-read.
      expect(finalize).toHaveBeenCalledTimes(1);
      expect(finalize).toHaveBeenCalledWith('attempt-1', { auto: true });
      expect(attempts.findOneOrFail).toHaveBeenCalledTimes(1);
      expect(rendered.state).toBe(AttemptState.GRADED);
    });

    it('getAttempt keeps the scoped lookup and reads the exam only through it', async () => {
      const { service, attempts, exams, access, answers } = rich();
      attempts.findOne.mockResolvedValue(attemptRow());
      answers.find.mockResolvedValue([]);

      await service.getAttempt('student-1', 'attempt-1');

      expect(access.findAccessibleExam).toHaveBeenCalledWith('student-1', 'exam-1');
      expect(access.assertCanAccessExam).not.toHaveBeenCalled();
      expect(exams.findOneOrFail).not.toHaveBeenCalled();
    });
  });

  describe('submit', () => {
    it('keeps its scoped check and still reads the exam under the attempt lock inside finalize', async () => {
      const { service, attempts, exams, access, manager } = rich();
      attempts.findOne.mockResolvedValue(attemptRow());
      manager.findOne.mockResolvedValue(attemptRow());

      await service.submit('student-1', 'attempt-1', { answers: [] });

      expect(access.assertCanAccessExam).toHaveBeenCalledWith('student-1', 'exam-1');
      // submit reuses nothing: the only exam read is the one inside the transaction.
      expect(exams.findOneOrFail).not.toHaveBeenCalled();
      expect(manager.findOne).toHaveBeenCalledWith(
        ExamAttempt,
        expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
      );
      expect(manager.findOneOrFail).toHaveBeenCalledTimes(1);
      expect((manager.findOneOrFail.mock.calls[0] as [unknown, unknown])[0]).toBe(Exam);
    });
  });
});
