import { ForbiddenException } from '@nestjs/common';

import type { Repository } from 'typeorm';

import { Lesson } from '../../lessons/entities/lesson.entity';
import { Subject } from '../../subjects/entities/subject.entity';
import { Exam, ExamQuestion, ExamSection, Question } from '../entities';
import { ExamAuthoringService } from './exam-authoring.service';

describe('ExamAuthoringService audience ownership', () => {
  it("does not allow an instructor to target another instructor's lesson/group", async () => {
    const exams = { create: jest.fn(), save: jest.fn() } as unknown as Repository<Exam>;
    const subjects = {
      findOne: jest.fn().mockResolvedValue({ id: 'subject-1' }),
    } as unknown as Repository<Subject>;
    const lessons = {
      findOne: jest.fn().mockResolvedValue({
        id: 'lesson-1',
        teacher_id: 'other-teacher',
        subject_id: 'subject-1',
      }),
    } as unknown as Repository<Lesson>;
    const service = new ExamAuthoringService(
      exams,
      {} as Repository<ExamSection>,
      {} as Repository<ExamQuestion>,
      {} as Repository<Question>,
      subjects,
      lessons,
      {} as never,
    );

    await expect(
      service.createExam('teacher-1', {
        title: 'Private exam',
        title_ar: 'اختبار خاص',
        subject_id: 'subject-1',
        lesson_id: 'lesson-1',
        passing_marks: 5,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(exams.create).not.toHaveBeenCalled();
    expect(exams.save).not.toHaveBeenCalled();
  });
});
