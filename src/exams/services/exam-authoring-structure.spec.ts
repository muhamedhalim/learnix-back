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
  const manager = { update: jest.fn().mockResolvedValue(undefined) };
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
    {} as never,
    dataSource as never,
  );
  return { service, manager, questions };
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

    expect(manager.update).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      { id: 'section-2', exam_id: 'exam-1' },
      { order_index: 0 },
    );
    expect(manager.update).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      { id: 'section-1', exam_id: 'exam-1' },
      { order_index: 1 },
    );
  });
});
