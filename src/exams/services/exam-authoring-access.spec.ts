import { BadRequestException, ForbiddenException } from '@nestjs/common';

import type { Repository } from 'typeorm';

import { Lesson } from '../../lessons/entities/lesson.entity';
import { LessonPackage } from '../../packages/entities/lesson-package.entity';
import { Subject } from '../../subjects/entities/subject.entity';
import { Exam, ExamQuestion, ExamSection, Question } from '../entities';
import { ExamAuthoringService } from './exam-authoring.service';

describe('ExamAuthoringService audience ownership', () => {
  function buildService(options?: {
    lesson?: Partial<Lesson> | null;
    course?: Partial<LessonPackage> | null;
  }) {
    const exams = {
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => value),
    } as unknown as Repository<Exam>;
    const subjects = {
      findOne: jest.fn().mockResolvedValue({ id: 'subject-1' }),
    } as unknown as Repository<Subject>;
    const lessons = {
      findOne: jest.fn().mockResolvedValue(options?.lesson ?? null),
    } as unknown as Repository<Lesson>;
    const packages = {
      findOne: jest.fn().mockResolvedValue(options?.course ?? null),
    } as unknown as Repository<LessonPackage>;
    const service = new ExamAuthoringService(
      exams,
      {} as Repository<ExamSection>,
      {} as Repository<ExamQuestion>,
      {} as Repository<Question>,
      subjects,
      lessons,
      packages,
      {} as never,
    );
    return { service, exams };
  }

  it('allows a public exam only when it has no private target', async () => {
    const { service, exams } = buildService();

    await expect(
      service.createExam('teacher-1', {
        title: 'Public exam',
        title_ar: 'اختبار عام',
        subject_id: 'subject-1',
        passing_marks: 5,
        is_public: true,
      }),
    ).resolves.toMatchObject({ is_public: true, lesson_id: null, package_id: null });
    expect(exams.save).toHaveBeenCalledTimes(1);
  });

  it('rejects a new private exam without a course or lesson target', async () => {
    const { service, exams } = buildService();

    await expect(
      service.createExam('teacher-1', {
        title: 'Untargeted private exam',
        title_ar: 'اختبار خاص بلا جمهور',
        subject_id: 'subject-1',
        passing_marks: 5,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(exams.save).not.toHaveBeenCalled();
  });

  it("does not allow an instructor to target another instructor's course", async () => {
    const { service, exams } = buildService({
      course: { id: 'course-1', teacher_id: 'other-teacher' },
    });

    await expect(
      service.createExam('teacher-1', {
        title: 'Private course exam',
        title_ar: 'اختبار دورة خاص',
        subject_id: 'subject-1',
        package_id: 'course-1',
        passing_marks: 5,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(exams.save).not.toHaveBeenCalled();
  });

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
