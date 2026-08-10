import { BadRequestException, NotFoundException } from '@nestjs/common';

import { Exam, ExamQuestion, OmrTemplate } from '../entities';
import { QuestionType } from '../entities/question-type.enum';
import { OmrTemplatesService } from './omr-templates.service';

function question(overrides: Partial<ExamQuestion>): ExamQuestion {
  return {
    id: 'q1',
    order_index: 0,
    type_snapshot: QuestionType.SINGLE_CHOICE,
    content_snapshot: { options: [{ id: 'a', text: { en: 'A' } }, { id: 'b', text: { en: 'B' } }] },
    ...overrides,
  } as unknown as ExamQuestion;
}

function buildService(opts: {
  exam?: Exam | null;
  examQuestions?: ExamQuestion[];
  latestTemplate?: OmrTemplate | null;
}): {
  service: OmrTemplatesService;
  exams: { findOne: jest.Mock };
  examQuestions: { find: jest.Mock };
  templates: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock };
} {
  const exams = {
    findOne: jest.fn().mockResolvedValue(opts.exam === undefined ? { id: 'exam-1', teacher_id: 'teacher-1' } : opts.exam),
  };
  const examQuestions = { find: jest.fn().mockResolvedValue(opts.examQuestions ?? [question({})]) };
  const templates = {
    findOne: jest.fn().mockResolvedValue(opts.latestTemplate ?? null),
    create: jest.fn().mockImplementation((v: unknown) => v),
    save: jest.fn().mockImplementation((v: unknown) => Promise.resolve({ ...(v as object), id: 'template-1' })),
  };
  const service = new OmrTemplatesService(exams as never, examQuestions as never, templates as never);
  return { service, exams, examQuestions, templates };
}

describe('OmrTemplatesService.getOrCreateForExam', () => {
  it('creates version 1 when no template exists yet', async () => {
    const { service, templates } = buildService({});
    const result = await service.getOrCreateForExam('exam-1', 'teacher-1');
    expect(result.version).toBe(1);
    expect(templates.save).toHaveBeenCalled();
  });

  it('reuses the latest template when the content hash is unchanged', async () => {
    const questions = [question({})];
    const { service, templates } = buildService({ examQuestions: questions });
    const first = await service.getOrCreateForExam('exam-1', 'teacher-1');

    templates.findOne.mockResolvedValue(first);
    templates.save.mockClear();
    const second = await service.getOrCreateForExam('exam-1', 'teacher-1');

    expect(second).toBe(first);
    expect(templates.save).not.toHaveBeenCalled();
  });

  it('generates a new version when the question set changes', async () => {
    const { service, templates, examQuestions } = buildService({ examQuestions: [question({ id: 'q1' })] });
    const first = await service.getOrCreateForExam('exam-1', 'teacher-1');

    templates.findOne.mockResolvedValue({ ...first, version: 1 });
    examQuestions.find.mockResolvedValue([question({ id: 'q1' }), question({ id: 'q2', order_index: 1 })]);

    const second = await service.getOrCreateForExam('exam-1', 'teacher-1');
    expect(second.version).toBe(2);
  });

  it('translates a layout error (e.g. numeric/fill_blank questions present) into a BadRequestException', async () => {
    const { service } = buildService({
      examQuestions: [question({ type_snapshot: QuestionType.NUMERIC, content_snapshot: { prompt: { en: 'n' } } })],
    });
    await expect(service.getOrCreateForExam('exam-1', 'teacher-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a foreign exam with the standard not-found (no ownership disclosure)', async () => {
    const { service } = buildService({ exam: null });
    await expect(service.getOrCreateForExam('exam-1', 'someone-else')).rejects.toBeInstanceOf(NotFoundException);
  });
});
