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
    (payments.hasLessonPlaybackAccess as jest.Mock).mockImplementation(
      async (_studentId: string, lessonId: string) => lessonId === 'lesson-active',
    );

    await expect(controller.getAllProgress(request)).resolves.toEqual({
      data: [{ lessonId: 'lesson-active', progressPercent: 50 }],
    });
  });
});
