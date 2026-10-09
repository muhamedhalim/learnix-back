import { NotFoundException } from '@nestjs/common';

import { TeacherGradingService } from './teacher-grading.service';

describe('TeacherGradingService.getSubmissions (T083)', () => {
  function build(ownedExam: unknown) {
    const exams = { findOne: jest.fn().mockResolvedValue(ownedExam) };
    const attempts = { findAndCount: jest.fn().mockResolvedValue([[], 0]) };
    const service = Object.create(TeacherGradingService.prototype) as TeacherGradingService;
    Object.assign(service, { exams, attempts });
    return { service, exams, attempts };
  }

  it('checks ownership first and answers 404 for a foreign teacher without touching attempts', async () => {
    const { service, exams, attempts } = build(null);

    await expect(service.getSubmissions('exam-1', 'teacher-2')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(exams.findOne).toHaveBeenCalledWith({ where: { id: 'exam-1', teacher_id: 'teacher-2' } });
    expect(attempts.findAndCount).not.toHaveBeenCalled();
  });

  it('selects only the mapped attempt columns and the student {id, name, email}; ownership stays out of the where', async () => {
    const { service, attempts } = build({ id: 'exam-1' });

    await service.getSubmissions('exam-1', 'teacher-1', 2, 10);

    const options = attempts.findAndCount.mock.calls[0]![0] as Record<string, any>;
    expect(options.where).toEqual({ exam_id: 'exam-1' });
    expect(options.relations).toEqual(['student']);
    expect(options.select).toEqual({
      id: true,
      exam_id: true,
      student_id: true,
      attempt_number: true,
      state: true,
      score_auto: true,
      score_manual: true,
      score_total: true,
      max_score: true,
      passed: true,
      submitted_at: true,
      created_at: true,
      student: { id: true, name: true, email: true },
    });
    expect(options.order).toEqual({ submitted_at: 'DESC', created_at: 'DESC' });
    expect(options.skip).toBe(10);
    expect(options.take).toBe(10);
  });
});
