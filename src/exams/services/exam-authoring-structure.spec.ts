import { BadRequestException } from '@nestjs/common';

import { ExamStatus } from '../entities';
import { ExamAuthoringService } from './exam-authoring.service';

function buildService() {
  const exams = {
    findOne: jest.fn().mockResolvedValue({
      id: 'exam-1',
      teacher_id: 'teacher-1',
      status: ExamStatus.DRAFT,
    }),
  };
  const sections = {
    find: jest.fn().mockResolvedValue([{ id: 'section-1' }, { id: 'section-2' }]),
    findOne: jest.fn().mockResolvedValue({ id: 'section-1', exam_id: 'exam-1' }),
  };
  const examQuestions = { find: jest.fn(), findOne: jest.fn() };
  const questions = {
    findOne: jest
      .fn()
      .mockResolvedValue({ id: 'question-1', teacher_id: 'teacher-1', is_public: true }),
  };
  const manager = {
    update: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue(undefined),
  };
  const dataSource = {
    transaction: jest.fn((work: (manager: typeof manager) => unknown) => work(manager)),
  };
  const service = new ExamAuthoringService(
    exams as never,
    sections as never,
    examQuestions as never,
    questions as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    dataSource as never,
  );
  return { service, manager, questions, examQuestions };
}

describe('ExamAuthoringService structure safeguards', () => {
  it('does not allow a public practice question to expose an exam answer key', async () => {
    const { service } = buildService();

    await expect(
      service.attachQuestion('exam-1', 'teacher-1', {
        question_id: 'question-1',
        section_id: 'section-1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('persists a complete teacher-provided section ordering atomically', async () => {
    const { service, manager } = buildService();

    await service.reorderSections('exam-1', 'teacher-1', {
      ids: ['section-2', 'section-1'],
    });

    // T072: one statement for the whole ordering, in the same transaction, scoped by the exam.
    expect(manager.update).not.toHaveBeenCalled();
    expect(manager.query).toHaveBeenCalledTimes(1);
    const [sql, params] = manager.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('UPDATE exam_sections');
    expect(sql).toContain('t.exam_id = $3');
    expect(params).toEqual([['section-2', 'section-1'], [0, 1], 'exam-1']);
  });

  it('orders questions the same way, in one statement scoped by the exam', async () => {
    const { service, manager, examQuestions } = buildService();
    examQuestions.find.mockResolvedValue([{ id: 'q-1' }, { id: 'q-2' }, { id: 'q-3' }]);

    await service.reorderQuestions('exam-1', 'teacher-1', { ids: ['q-3', 'q-1', 'q-2'] });

    expect(manager.query).toHaveBeenCalledTimes(1);
    const [sql, params] = manager.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('UPDATE exam_questions');
    expect(sql).toContain('t.exam_id = $3');
    expect(params).toEqual([['q-3', 'q-1', 'q-2'], [0, 1, 2], 'exam-1']);
  });

  it('a repeated id takes its last index, as the row-by-row updates did', async () => {
    const { service, manager } = buildService();

    await service.reorderSections('exam-1', 'teacher-1', { ids: ['section-1', 'section-1'] });

    const [, params] = manager.query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([['section-1'], [1], 'exam-1']);
  });

  it('refuses an ordering that omits or invents an item, and writes nothing', async () => {
    const { service, manager } = buildService();

    await expect(
      service.reorderSections('exam-1', 'teacher-1', { ids: ['section-1'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.reorderSections('exam-1', 'teacher-1', { ids: ['section-1', 'foreign-section'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(manager.query).not.toHaveBeenCalled();
  });
});
