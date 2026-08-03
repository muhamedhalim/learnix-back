import { NotFoundException } from '@nestjs/common';

import { ExamAuthoringService } from './exam-authoring.service';
import { OmrSheetsService } from './omr-sheets.service';
import { TeacherGradingService } from './teacher-grading.service';

describe('exam ownership non-disclosure', () => {
  it('returns the same not-found status for a foreign authoring exam', async () => {
    const exams = { findOne: jest.fn().mockResolvedValue(null) };
    const service = new ExamAuthoringService(
      exams as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    );

    await expect(service.getExamForTeacher('exam-1', 'teacher-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(exams.findOne).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'exam-1', teacher_id: 'teacher-1' }),
    }));
  });

  it('returns the same not-found status for foreign grading and OMR exams', async () => {
    const exams = { findOne: jest.fn().mockResolvedValue(null) };
    const grading = new TeacherGradingService(
      exams as never, { findAndCount: jest.fn() } as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, {} as never,
    );
    const omr = new OmrSheetsService(
      exams as never, { findAndCount: jest.fn() } as never, {} as never, {} as never,
    );

    await expect(grading.getSubmissions('exam-1', 'teacher-1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(omr.findMany('exam-1', 'teacher-1', 1, 20)).rejects.toBeInstanceOf(NotFoundException);
    expect(exams.findOne).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'exam-1', teacher_id: 'teacher-1' }),
    }));
  });
});
