import { ForbiddenException } from '@nestjs/common';

import { PaymentsService } from '../../payments/services/payments.service';
import { LessonsService } from '../lessons.service';
import { ProgressService } from '../progress.service';
import { StudentLessonsController } from './student-lessons.controller';

describe('StudentLessonsController progress access', () => {
  const lessons = {} as LessonsService;
  const progress = {
    getProgress: jest.fn(),
    getAllProgress: jest.fn(),
  } as unknown as ProgressService;
  const payments = {
    hasLessonPlaybackAccess: jest.fn(),
    getPlaybackAccessibleLessonIds: jest.fn(),
  } as unknown as PaymentsService;
  const request = { user: { userId: 'student-1' } } as never;
  let controller: StudentLessonsController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new StudentLessonsController(lessons, progress, payments);
  });

  it('does not reveal progress for an expired package lesson', async () => {
    (payments.hasLessonPlaybackAccess as jest.Mock).mockResolvedValue(false);

    await expect(controller.getProgress(request, 'lesson-expired')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(progress.getProgress).not.toHaveBeenCalled();
  });

  it('omits expired lessons while retaining progress for another active package lesson', async () => {
    (progress.getAllProgress as jest.Mock).mockResolvedValue([
      { lessonId: 'lesson-expired', progressPercent: 100 },
      { lessonId: 'lesson-active', progressPercent: 50 },
    ]);
    (payments.getPlaybackAccessibleLessonIds as jest.Mock).mockResolvedValue(
      new Set(['lesson-active']),
    );

    await expect(controller.getAllProgress(request, {})).resolves.toEqual({
      data: [{ lessonId: 'lesson-active', progressPercent: 50 }],
    });
  });

  it('T065: filters the ordered list by one batched access call and never probes per row', async () => {
    (progress.getAllProgress as jest.Mock).mockResolvedValue([
      { lessonId: 'c', progressPercent: 10 },
      { lessonId: 'a', progressPercent: 20 },
      { lessonId: 'b', progressPercent: 30 },
      { lessonId: 'd', progressPercent: 40 },
    ]);
    (payments.getPlaybackAccessibleLessonIds as jest.Mock).mockResolvedValue(
      new Set(['a', 'c', 'd']),
    );

    await expect(controller.getAllProgress(request, {})).resolves.toEqual({
      data: [
        { lessonId: 'c', progressPercent: 10 },
        { lessonId: 'a', progressPercent: 20 },
        { lessonId: 'd', progressPercent: 40 },
      ],
    });
    expect(payments.getPlaybackAccessibleLessonIds).toHaveBeenCalledTimes(1);
    expect(payments.getPlaybackAccessibleLessonIds).toHaveBeenCalledWith('student-1', [
      'c',
      'a',
      'b',
      'd',
    ]);
    expect(payments.hasLessonPlaybackAccess).not.toHaveBeenCalled();
  });

  it('T065: a student with no progress rows gets an empty list', async () => {
    (progress.getAllProgress as jest.Mock).mockResolvedValue([]);
    (payments.getPlaybackAccessibleLessonIds as jest.Mock).mockResolvedValue(new Set());

    await expect(controller.getAllProgress(request, {})).resolves.toEqual({ data: [] });
  });

  it('T089: passes the optional packageId to the progress query and still applies the access filter', async () => {
    (progress.getAllProgress as jest.Mock).mockResolvedValue([
      { lessonId: 'in-course-allowed', progressPercent: 10 },
      { lessonId: 'in-course-revoked', progressPercent: 90 },
    ]);
    (payments.getPlaybackAccessibleLessonIds as jest.Mock).mockResolvedValue(
      new Set(['in-course-allowed']),
    );

    await expect(
      controller.getAllProgress(request, { packageId: 'package-1' }),
    ).resolves.toEqual({ data: [{ lessonId: 'in-course-allowed', progressPercent: 10 }] });

    expect(progress.getAllProgress).toHaveBeenCalledWith(expect.any(String), 'package-1');
    expect(payments.getPlaybackAccessibleLessonIds).toHaveBeenCalledWith(expect.any(String), [
      'in-course-allowed',
      'in-course-revoked',
    ]);
  });

  it('T089: without packageId the progress query is unscoped', async () => {
    (progress.getAllProgress as jest.Mock).mockResolvedValue([]);
    (payments.getPlaybackAccessibleLessonIds as jest.Mock).mockResolvedValue(new Set());

    await controller.getAllProgress(request, {});

    expect(progress.getAllProgress).toHaveBeenCalledWith(expect.any(String), undefined);
  });
});
