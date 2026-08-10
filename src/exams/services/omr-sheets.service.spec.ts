import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';

import { AttemptState, Exam, ExamStatus, OmrSheet, OmrSheetStatus } from '../entities';
import { OmrSheetsService } from './omr-sheets.service';

function exam(overrides: Partial<Exam> = {}): Exam {
  return { id: 'exam-1', teacher_id: 'teacher-1', status: ExamStatus.PUBLISHED, ...overrides } as unknown as Exam;
}

function sheet(overrides: Partial<OmrSheet> = {}): OmrSheet {
  return {
    id: 'sheet-1',
    exam_id: 'exam-1',
    student_id: 'student-1',
    teacher_id: 'teacher-1',
    template_id: 'template-1',
    image_key: 'omr-sheets/x.jpg',
    detected_answers: [{ exam_question_id: 'q1', response: { optionId: 'a' } }],
    recognized_answers: [
      { exam_question_id: 'q1', status: 'confident', confidence: 1, detected: { optionId: 'a' }, raw: { fillRatios: [], threshold: 0, margin: null } },
    ],
    resolved_question_ids: [],
    recognition_provider: 'fiducial-marker-v1',
    status: OmrSheetStatus.READY,
    error_message: null,
    attempt_id: null,
    confirmed_at: null,
    reviewed_by: null,
    processed_at: new Date(),
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as unknown as OmrSheet;
}

interface Mocks {
  exams: { findOne: jest.Mock };
  sheets: {
    findOne: jest.Mock;
    findAndCount: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  templates: { findOne: jest.Mock };
  examQuestions: { find: jest.Mock; findOne: jest.Mock };
  users: { findOneOrFail: jest.Mock };
  dataSource: { transaction: jest.Mock };
  storage: { upload: jest.Mock; getObject: jest.Mock; toKey: jest.Mock };
  jobs: { enqueueOmrProcessing: jest.Mock };
  access: { assertCanAccessPrivateExam: jest.Mock };
  templatesService: { getOrCreateForExam: jest.Mock };
  attemptService: {
    createOmrAttempt: jest.Mock;
    saveAnswers: jest.Mock;
    submit: jest.Mock;
    getSummary: jest.Mock;
  };
  questionTypes: { require: jest.Mock };
  pdfService: { render: jest.Mock };
}

function buildService(overrides: Partial<Mocks> = {}): { service: OmrSheetsService; mocks: Mocks } {
  const defaultMocks: Mocks = {
    exams: { findOne: jest.fn().mockResolvedValue(exam()) },
    sheets: {
      findOne: jest.fn().mockResolvedValue(null),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
      create: jest.fn().mockImplementation((v: unknown) => v),
      save: jest.fn().mockImplementation((v: unknown) => Promise.resolve(v)),
    },
    templates: { findOne: jest.fn().mockResolvedValue({ id: 'template-1', layout: { questions: [] } }) },
    examQuestions: { find: jest.fn().mockResolvedValue([]), findOne: jest.fn().mockResolvedValue(null) },
    users: { findOneOrFail: jest.fn() },
    dataSource: { transaction: jest.fn() },
    storage: {
      upload: jest.fn().mockResolvedValue({ path: 'omr-sheets/new.jpg' }),
      getObject: jest.fn(),
      toKey: jest.fn((k: string) => k),
    },
    jobs: { enqueueOmrProcessing: jest.fn().mockResolvedValue(undefined) },
    access: { assertCanAccessPrivateExam: jest.fn().mockResolvedValue(undefined) },
    templatesService: { getOrCreateForExam: jest.fn().mockResolvedValue({ id: 'template-1' }) },
    attemptService: {
      createOmrAttempt: jest.fn(),
      saveAnswers: jest.fn().mockResolvedValue({ saved: 1, state: AttemptState.IN_PROGRESS }),
      submit: jest.fn(),
      getSummary: jest.fn().mockResolvedValue(null),
    },
    questionTypes: { require: jest.fn().mockReturnValue({ validateResponse: jest.fn().mockReturnValue([]) }) },
    pdfService: { render: jest.fn().mockResolvedValue(Buffer.from('pdf')) },
  };
  const mocks: Mocks = { ...defaultMocks, ...overrides };

  const service = new OmrSheetsService(
    mocks.exams as never,
    mocks.sheets as never,
    mocks.templates as never,
    mocks.examQuestions as never,
    mocks.users as never,
    mocks.dataSource as never,
    mocks.storage as never,
    mocks.jobs as never,
    mocks.access as never,
    mocks.templatesService as never,
    mocks.attemptService as never,
    mocks.questionTypes as never,
    mocks.pdfService as never,
  );
  return { service, mocks };
}

describe('OmrSheetsService.generate', () => {
  it('creates one PENDING sheet per requested student and checks each one’s exam access', async () => {
    const { service, mocks } = buildService();
    const result = await service.generate('exam-1', 'teacher-1', { student_ids: ['s1', 's2'] });

    expect(result).toHaveLength(2);
    expect(result.every((r) => r.status === OmrSheetStatus.PENDING)).toBe(true);
    expect(mocks.access.assertCanAccessPrivateExam).toHaveBeenCalledWith('s1', 'exam-1');
    expect(mocks.access.assertCanAccessPrivateExam).toHaveBeenCalledWith('s2', 'exam-1');
    expect(mocks.templatesService.getOrCreateForExam).toHaveBeenCalledTimes(1);
  });

  it('reuses an existing active sheet instead of creating a duplicate (idempotent)', async () => {
    const existing = sheet({ status: OmrSheetStatus.PROCESSING });
    const { service, mocks } = buildService({
      sheets: {
        findOne: jest.fn().mockResolvedValue(existing),
        findAndCount: jest.fn(),
        create: jest.fn(),
        save: jest.fn(),
      },
    });

    const result = await service.generate('exam-1', 'teacher-1', { student_ids: ['student-1'] });
    expect(result[0]!.id).toBe(existing.id);
    expect(mocks.sheets.create).not.toHaveBeenCalled();
  });

  it('rejects generation for an exam the teacher does not own', async () => {
    const { service } = buildService({ exams: { findOne: jest.fn().mockResolvedValue(null) } });
    await expect(service.generate('exam-1', 'someone-else', { student_ids: ['s1'] })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('OmrSheetsService.scan', () => {
  const validFile = {
    originalname: 'sheet.jpg',
    mimetype: 'image/jpeg',
    size: 1000,
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  };

  it('binds an upload to an explicit sheet_id and resets prior recognition state', async () => {
    const existing = sheet({ status: OmrSheetStatus.FAILED, error_message: 'previous failure' });
    const { service, mocks } = buildService({
      sheets: {
        findOne: jest.fn().mockResolvedValue(existing),
        findAndCount: jest.fn(),
        create: jest.fn(),
        save: jest.fn().mockImplementation((v: unknown) => Promise.resolve(v)),
      },
    });

    const result = await service.scan('exam-1', 'teacher-1', { sheet_id: existing.id }, validFile);

    expect(result.status).toBe(OmrSheetStatus.PENDING);
    expect(result.error_message).toBeNull();
    expect(mocks.storage.upload).toHaveBeenCalled();
    expect(mocks.jobs.enqueueOmrProcessing).toHaveBeenCalledWith(existing.id);
  });

  it('rejects uploading to a sheet that is already confirmed', async () => {
    const confirmed = sheet({ status: OmrSheetStatus.CONFIRMED });
    const { service } = buildService({
      sheets: { findOne: jest.fn().mockResolvedValue(confirmed), findAndCount: jest.fn(), create: jest.fn(), save: jest.fn() },
    });
    await expect(service.scan('exam-1', 'teacher-1', { sheet_id: confirmed.id }, validFile)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('falls back to student_id and creates a sheet when no sheet_id/QR resolves one', async () => {
    const { service, mocks } = buildService({
      sheets: {
        findOne: jest.fn().mockResolvedValue(null), // no existing active sheet, and QR decode finds nothing on a non-QR jpeg
        findAndCount: jest.fn(),
        create: jest.fn().mockImplementation((v: unknown) => v),
        save: jest.fn().mockImplementation((v: unknown) => Promise.resolve(v)),
      },
    });

    const result = await service.scan('exam-1', 'teacher-1', { student_id: 'student-9' }, validFile);
    expect(mocks.access.assertCanAccessPrivateExam).toHaveBeenCalledWith('student-9', 'exam-1');
    expect(result.student_id).toBe('student-9');
  });

  it('rejects when neither sheet_id nor student_id is given and the image carries no identifiable QR', async () => {
    const { service } = buildService({
      sheets: { findOne: jest.fn().mockResolvedValue(null), findAndCount: jest.fn(), create: jest.fn(), save: jest.fn() },
    });
    await expect(service.scan('exam-1', 'teacher-1', {}, validFile)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a missing file', async () => {
    const { service } = buildService();
    await expect(service.scan('exam-1', 'teacher-1', { student_id: 's1' }, undefined)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects an unsupported mimetype', async () => {
    const { service } = buildService();
    await expect(
      service.scan('exam-1', 'teacher-1', { student_id: 's1' }, { ...validFile, mimetype: 'application/pdf' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('OmrSheetsService.patchAnswer', () => {
  it('rejects editing a sheet that has already been confirmed', async () => {
    const confirmed = sheet({ status: OmrSheetStatus.CONFIRMED });
    const { service } = buildService({
      sheets: { findOne: jest.fn().mockResolvedValue(confirmed), findAndCount: jest.fn(), create: jest.fn(), save: jest.fn() },
    });
    await expect(
      service.patchAnswer('exam-1', 'teacher-1', confirmed.id, 'q1', { response: null }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects a question id that is not part of the sheet’s template', async () => {
    const target = sheet({ status: OmrSheetStatus.REVIEW_REQUIRED });
    const { service } = buildService({
      sheets: { findOne: jest.fn().mockResolvedValue(target), findAndCount: jest.fn(), create: jest.fn(), save: jest.fn() },
      templates: { findOne: jest.fn().mockResolvedValue({ id: 'template-1', layout: { questions: [{ examQuestionId: 'q1' }] } }) },
    });
    await expect(
      service.patchAnswer('exam-1', 'teacher-1', target.id, 'not-in-template', { response: null }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('validates a non-null response through the question-type registry and marks the question resolved', async () => {
    const target = sheet({ status: OmrSheetStatus.REVIEW_REQUIRED, resolved_question_ids: [] });
    const validateResponse = jest.fn().mockReturnValue([]);
    const { service } = buildService({
      sheets: {
        findOne: jest.fn().mockResolvedValue(target),
        findAndCount: jest.fn(),
        create: jest.fn(),
        save: jest.fn().mockImplementation((v: unknown) => Promise.resolve(v)),
      },
      templates: { findOne: jest.fn().mockResolvedValue({ id: 'template-1', layout: { questions: [{ examQuestionId: 'q1' }] } }) },
      examQuestions: { find: jest.fn(), findOne: jest.fn().mockResolvedValue({ id: 'q1', type_snapshot: 'single_choice' }) },
      questionTypes: { require: jest.fn().mockReturnValue({ validateResponse }) },
    });

    const result = await service.patchAnswer('exam-1', 'teacher-1', target.id, 'q1', { response: { optionId: 'b' } });

    expect(validateResponse).toHaveBeenCalledWith({ optionId: 'b' });
    expect(result.resolved_question_ids).toContain('q1');
  });

  it('marking a question explicitly blank (response: null) skips response-shape validation and still resolves it', async () => {
    const target = sheet({ status: OmrSheetStatus.REVIEW_REQUIRED, resolved_question_ids: [] });
    const { service, mocks } = buildService({
      sheets: {
        findOne: jest.fn().mockResolvedValue(target),
        findAndCount: jest.fn(),
        create: jest.fn(),
        save: jest.fn().mockImplementation((v: unknown) => Promise.resolve(v)),
      },
      templates: { findOne: jest.fn().mockResolvedValue({ id: 'template-1', layout: { questions: [{ examQuestionId: 'q1' }] } }) },
    });

    const result = await service.patchAnswer('exam-1', 'teacher-1', target.id, 'q1', { response: null });
    expect(mocks.examQuestions.findOne).not.toHaveBeenCalled();
    expect(result.resolved_question_ids).toContain('q1');
  });
});

describe('OmrSheetsService.confirm', () => {
  it('is idempotent: replaying confirm on an already-COMPLETED sheet does not re-grade', async () => {
    const completed = sheet({ status: OmrSheetStatus.COMPLETED, attempt_id: 'attempt-1' });
    const manager = { findOne: jest.fn().mockResolvedValue(completed), save: jest.fn() };
    const { service, mocks } = buildService({
      dataSource: { transaction: jest.fn().mockImplementation((fn: (m: unknown) => unknown) => fn(manager)) },
      attemptService: {
        createOmrAttempt: jest.fn(),
        saveAnswers: jest.fn(),
        submit: jest.fn(),
        getSummary: jest.fn().mockResolvedValue({
          attempt_id: 'attempt-1',
          state: AttemptState.GRADED,
          score_total: 8,
          max_score: 10,
          passed: true,
          auto_submitted: false,
          score_auto: 8,
          // Deliberately non-zero: proves the replay path re-derives the real
          // pending-manual count (e.g. essay questions on a mixed exam)
          // instead of a hardcoded 0.
          pending_manual: 2,
          submitted_at: new Date(),
        }),
      },
    });

    const result = await service.confirm('exam-1', 'teacher-1', completed.id);

    expect(result.attempt?.attempt_id).toBe('attempt-1');
    expect(result.attempt?.pending_manual).toBe(2);
    expect(mocks.attemptService.createOmrAttempt).not.toHaveBeenCalled();
  });

  it('blocks confirmation while any flagged question is still unresolved', async () => {
    const needsReview = sheet({
      status: OmrSheetStatus.REVIEW_REQUIRED,
      resolved_question_ids: [],
      recognized_answers: [
        { exam_question_id: 'q1', status: 'multiple_marks', confidence: 0.2, detected: null, raw: { fillRatios: [], threshold: 0, margin: null } },
      ],
    });
    const manager = { findOne: jest.fn().mockResolvedValue(needsReview), save: jest.fn() };
    const { service } = buildService({
      dataSource: { transaction: jest.fn().mockImplementation((fn: (m: unknown) => unknown) => fn(manager)) },
    });

    await expect(service.confirm('exam-1', 'teacher-1', needsReview.id)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects confirming a DRAFT exam even if the sheet itself is fully reviewed', async () => {
    const ready = sheet({ status: OmrSheetStatus.READY });
    const manager = {
      findOne: jest.fn().mockResolvedValue(ready),
      save: jest.fn().mockImplementation((_e: unknown, v: unknown) => Promise.resolve(v)),
    };
    const { service } = buildService({
      exams: { findOne: jest.fn().mockResolvedValue(exam({ status: ExamStatus.DRAFT })) },
      dataSource: { transaction: jest.fn().mockImplementation((fn: (m: unknown) => unknown) => fn(manager)) },
    });

    await expect(service.confirm('exam-1', 'teacher-1', ready.id)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('creates/grades the attempt from a fully-reviewed sheet and marks it COMPLETED', async () => {
    const ready = sheet({ status: OmrSheetStatus.READY, resolved_question_ids: [] });
    const manager = {
      findOne: jest.fn().mockResolvedValue(ready),
      save: jest.fn().mockImplementation((_e: unknown, v: unknown) => Promise.resolve(v)),
    };
    const attempt = { id: 'attempt-new', state: AttemptState.IN_PROGRESS };
    const { service, mocks } = buildService({
      dataSource: { transaction: jest.fn().mockImplementation((fn: (m: unknown) => unknown) => fn(manager)) },
      attemptService: {
        createOmrAttempt: jest.fn().mockResolvedValue(attempt),
        saveAnswers: jest.fn().mockResolvedValue({ saved: 1, state: AttemptState.IN_PROGRESS }),
        submit: jest.fn().mockResolvedValue({
          attempt_id: 'attempt-new',
          state: AttemptState.GRADED,
          score_total: 10,
          max_score: 10,
          passed: true,
          auto_submitted: false,
          score_auto: 10,
          pending_manual: 0,
          submitted_at: new Date(),
        }),
      },
    });

    const result = await service.confirm('exam-1', 'teacher-1', ready.id);

    expect(mocks.attemptService.createOmrAttempt).toHaveBeenCalledWith('exam-1', ready.student_id);
    expect(mocks.attemptService.saveAnswers).toHaveBeenCalledWith(
      ready.student_id,
      'attempt-new',
      expect.objectContaining({ answers: expect.any(Array) }),
    );
    expect(mocks.attemptService.submit).toHaveBeenCalled();
    expect(result.sheet.status).toBe(OmrSheetStatus.COMPLETED);
    expect(result.sheet.attempt_id).toBe('attempt-new');
    expect(result.attempt?.state).toBe(AttemptState.GRADED);
  });

  it('propagates the AttemptService origin conflict as-is (surfaces synchronously to the teacher)', async () => {
    const ready = sheet({ status: OmrSheetStatus.READY, resolved_question_ids: [] });
    const manager = {
      findOne: jest.fn().mockResolvedValue(ready),
      save: jest.fn().mockImplementation((_e: unknown, v: unknown) => Promise.resolve(v)),
    };
    const { service } = buildService({
      dataSource: { transaction: jest.fn().mockImplementation((fn: (m: unknown) => unknown) => fn(manager)) },
      attemptService: {
        createOmrAttempt: jest.fn().mockRejectedValue(new ConflictException('conflict')),
        saveAnswers: jest.fn(),
        submit: jest.fn(),
      },
    });

    await expect(service.confirm('exam-1', 'teacher-1', ready.id)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('OmrSheetsService.reprocess', () => {
  it('rejects reprocessing an already-confirmed sheet', async () => {
    const confirmed = sheet({ status: OmrSheetStatus.CONFIRMED });
    const { service } = buildService({
      sheets: { findOne: jest.fn().mockResolvedValue(confirmed), findAndCount: jest.fn(), create: jest.fn(), save: jest.fn() },
    });
    await expect(service.reprocess('exam-1', 'teacher-1', confirmed.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects reprocessing a sheet with no uploaded image', async () => {
    const noImage = sheet({ status: OmrSheetStatus.PENDING, image_key: null });
    const { service } = buildService({
      sheets: { findOne: jest.fn().mockResolvedValue(noImage), findAndCount: jest.fn(), create: jest.fn(), save: jest.fn() },
    });
    await expect(service.reprocess('exam-1', 'teacher-1', noImage.id)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('resets recognition state and re-enqueues processing', async () => {
    const failed = sheet({ status: OmrSheetStatus.FAILED, error_message: 'bad scan', resolved_question_ids: ['q1'] });
    const { service, mocks } = buildService({
      sheets: {
        findOne: jest.fn().mockResolvedValue(failed),
        findAndCount: jest.fn(),
        create: jest.fn(),
        save: jest.fn().mockImplementation((v: unknown) => Promise.resolve(v)),
      },
    });

    const result = await service.reprocess('exam-1', 'teacher-1', failed.id);

    expect(result.status).toBe(OmrSheetStatus.PENDING);
    expect(result.error_message).toBeNull();
    expect(result.resolved_question_ids).toEqual([]);
    expect(mocks.jobs.enqueueOmrProcessing).toHaveBeenCalledWith(failed.id);
  });
});
