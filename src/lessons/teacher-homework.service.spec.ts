import { NotFoundException } from '@nestjs/common';
import type { Repository } from 'typeorm';

import type { User } from '../users/entities/user.entity';
import { HomeworkSubmission } from './entities/homework-submission.entity';
import { LessonHomework } from './entities/lesson-homework.entity';
import { LessonContentService } from './lesson-content.service';
import { TeacherHomeworkService } from './teacher-homework.service';

const teacherId = '11111111-1111-4111-8111-111111111111';
const otherTeacherId = '22222222-2222-4222-8222-222222222222';
const homeworkId = '33333333-3333-4333-8333-333333333333';
const lessonId = '44444444-4444-4444-8444-444444444444';
const submissionId = '55555555-5555-4555-8555-555555555555';

function chain(methods: string[]): Record<string, jest.Mock> {
  const builder: Record<string, jest.Mock> = {};
  for (const method of methods) builder[method] = jest.fn(() => builder);
  return builder;
}

function ownedHomework(): LessonHomework {
  return {
    id: homeworkId,
    lesson_id: lessonId,
    lesson: { id: lessonId, title: 'Algebra' },
    title: 'Practice set',
    title_ar: null,
    description: null,
    description_ar: null,
    type: 'text',
    resource_url: 'lesson-resources/teacher/private.pdf',
    resource_filename: 'practice.pdf',
    due_at: null,
    questions: [],
    max_score: 100,
    published_at: new Date('2026-07-01T00:00:00.000Z'),
    created_at: new Date('2026-07-01T00:00:00.000Z'),
    updated_at: new Date('2026-07-01T00:00:00.000Z'),
    deleted_at: null,
    submissions: [],
  } as unknown as LessonHomework;
}

describe('TeacherHomeworkService', () => {
  const homeworkRepository = { createQueryBuilder: jest.fn(), query: jest.fn() };
  const submissionsRepository = {
    createQueryBuilder: jest.fn(),
    findOne: jest.fn(),
    query: jest.fn(),
  };
  const usersRepository = { createQueryBuilder: jest.fn() };
  const lessonContent = {
    gradeHomework: jest.fn(),
    getHomeworkResourceForTeacher: jest.fn(),
    getSubmissionFileForTeacher: jest.fn(),
  };
  let service: TeacherHomeworkService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new TeacherHomeworkService(
      homeworkRepository as unknown as Repository<LessonHomework>,
      submissionsRepository as unknown as Repository<HomeworkSubmission>,
      usersRepository as unknown as Repository<User>,
      lessonContent as unknown as LessonContentService,
    );
  });

  it('builds homework audiences from unexpired lesson purchases, not package ownership', () => {
    const sql = (service as unknown as { audienceSql: (lessonId: string) => string }).audienceSql(
      'homework.lesson_id',
    );

    expect(sql).toContain('lesson_purchases');
    expect(sql).toContain('purchase.access_expires_at > :accessNow');
    expect(sql).not.toContain('package_purchases');
  });

  it('returns 404 when the homework is not owned by the authenticated teacher', async () => {
    const qb = chain(['innerJoinAndSelect', 'where', 'andWhere']);
    qb.getOne = jest.fn().mockResolvedValue(null);
    homeworkRepository.createQueryBuilder.mockReturnValue(qb);

    await expect(service.detail(otherTeacherId, homeworkId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(qb.where).toHaveBeenCalledWith('lesson.teacher_id = :teacherId', {
      teacherId: otherTeacherId,
    });
    expect(qb.andWhere).toHaveBeenCalledWith('homework.id = :homeworkId', { homeworkId });
  });

  it('grades only a submission in the owned homework audience and delegates the existing grade workflow', async () => {
    const homeworkQuery = chain(['innerJoinAndSelect', 'where', 'andWhere']);
    homeworkQuery.getOne = jest.fn().mockResolvedValue(ownedHomework());
    homeworkRepository.createQueryBuilder.mockReturnValue(homeworkQuery);
    const audienceQuery = chain(['where', 'andWhere', 'setParameters', 'select']);
    audienceQuery.getOne = jest.fn().mockResolvedValue({ id: submissionId });
    submissionsRepository.createQueryBuilder.mockReturnValue(audienceQuery);
    lessonContent.gradeHomework.mockResolvedValue({
      id: submissionId,
      status: 'graded',
      score: 92,
      feedback: 'Good work',
      graded_at: new Date(),
    });

    await expect(
      service.grade(teacherId, homeworkId, submissionId, { score: 92, feedback: 'Good work' }),
    ).resolves.toMatchObject({ score: 92, max_score: 100, grading_status: 'graded' });

    expect(lessonContent.gradeHomework).toHaveBeenCalledWith(
      lessonId,
      homeworkId,
      submissionId,
      teacherId,
      { score: 92, feedback: 'Good work' },
    );
    expect(audienceQuery.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('submission.student_id IN'),
    );
  });

  it('refuses grading when the homework belongs to a different teacher', async () => {
    const homeworkQuery = chain(['innerJoinAndSelect', 'where', 'andWhere']);
    homeworkQuery.getOne = jest.fn().mockResolvedValue(null);
    homeworkRepository.createQueryBuilder.mockReturnValue(homeworkQuery);

    await expect(
      service.grade(otherTeacherId, homeworkId, submissionId, { score: 92 }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(lessonContent.gradeHomework).not.toHaveBeenCalled();
    expect(homeworkQuery.where).toHaveBeenCalledWith('lesson.teacher_id = :teacherId', {
      teacherId: otherTeacherId,
    });
  });

  it('does not expose a private storage key in the teacher homework response', async () => {
    const homeworkQuery = chain(['innerJoinAndSelect', 'where', 'andWhere']);
    homeworkQuery.getOne = jest.fn().mockResolvedValue(ownedHomework());
    homeworkRepository.createQueryBuilder.mockReturnValue(homeworkQuery);
    homeworkRepository.query
      .mockResolvedValueOnce([
        {
          homework_id: homeworkId,
          targeted_students: 2,
          submission_count: 1,
          late_submission_count: 0,
          ungraded_submission_count: 1,
          graded_submission_count: 0,
          average_score: null,
          highest_score: null,
          lowest_score: null,
        },
      ])
      .mockResolvedValueOnce([]);

    const response = await service.detail(teacherId, homeworkId);

    expect(response).not.toHaveProperty('resource_url');
    expect(response).toMatchObject({
      resource_download_url: `/api/v1/teacher/homework/${homeworkId}/resource`,
      resource_filename: 'practice.pdf',
      missing_submission_count: 1,
    });
  });

  describe('medianAndBelowPass (T059)', () => {
    const call = (ids: string[], student: string | undefined, threshold: number) =>
      (
        service as unknown as {
          medianAndBelowPass: (
            ids: string[],
            student: string | undefined,
            threshold: number,
          ) => Promise<{ medianScore: number | null; belowPass: number }>;
        }
      ).medianAndBelowPass(ids, student, threshold);

    it('is one statement; with no student the threshold is $2', async () => {
      submissionsRepository.query.mockResolvedValue([{ median_score: '62.5', below_pass: 2 }]);

      await expect(call([homeworkId], undefined, 60)).resolves.toEqual({
        medianScore: 62.5,
        belowPass: 2,
      });

      expect(submissionsRepository.query).toHaveBeenCalledTimes(1);
      const [sql, params] = submissionsRepository.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('< $2');
      expect(sql).not.toContain('student_id');
      expect(params).toEqual([[homeworkId], 60]);
    });

    it('with a student: student is $2, threshold is $3, both aggregates keep the graded-only rule', async () => {
      submissionsRepository.query.mockResolvedValue([{ median_score: null, below_pass: 0 }]);

      await expect(call([homeworkId], 'student-1', 50)).resolves.toEqual({
        medianScore: null,
        belowPass: 0,
      });

      const [sql, params] = submissionsRepository.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('submission.student_id = $2::uuid');
      expect(sql).toContain('< $3');
      expect(sql.match(/submission\.status = 'graded'/g)).toHaveLength(2);
      expect(params).toEqual([[homeworkId], 'student-1', 50]);
    });

    it('an empty homework list issues no statement', async () => {
      submissionsRepository.query.mockClear();
      await expect(call([], undefined, 60)).resolves.toEqual({ medianScore: null, belowPass: 0 });
      expect(submissionsRepository.query).not.toHaveBeenCalled();
    });
  });

  it('aggregates dashboard values on the backend from one stats query', async () => {
    const homeworkQuery = chain(['innerJoinAndSelect', 'where', 'andWhere']);
    homeworkQuery.getMany = jest.fn().mockResolvedValue([ownedHomework()]);
    homeworkRepository.createQueryBuilder.mockReturnValue(homeworkQuery);
    homeworkRepository.query.mockResolvedValueOnce([
      {
        homework_id: homeworkId,
        targeted_students: 4,
        submission_count: 3,
        late_submission_count: 1,
        ungraded_submission_count: 2,
        graded_submission_count: 1,
        average_score: '80',
        highest_score: '80',
        lowest_score: '80',
      },
    ]);

    await expect(service.dashboard(teacherId)).resolves.toMatchObject({
      total_published: 1,
      submissions_awaiting_grading: 2,
      students_not_submitted: 1,
      late_submissions: 1,
      average_homework_score: 80,
    });
    expect(homeworkRepository.query).toHaveBeenCalledTimes(1);
  });
});
