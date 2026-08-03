import { EventEmitter2 } from '@nestjs/event-emitter';

import { PARENT_EVENT_CHANNEL } from '../notifications/events/parent-events';
import { ProgressService, LESSON_COMPLETED_EVENT } from './progress.service';

describe('ProgressService completion events', () => {
  const progress = { findOne: jest.fn(), create: jest.fn(), save: jest.fn() };
  const lessons = { findOne: jest.fn() };
  const users = { findOne: jest.fn() };
  const events = { emit: jest.fn() };

  beforeEach(() => jest.clearAllMocks());

  it('emits certificate and guardian completion events once when progress first reaches 100%', async () => {
    const service = new ProgressService(
      progress as never,
      lessons as never,
      users as never,
      events as unknown as EventEmitter2,
    );
    lessons.findOne.mockResolvedValue({ id: 'lesson-1', title: 'Algebra', duration: 60 });
    users.findOne.mockResolvedValue({ id: 'student-1', name: 'Amina' });
    progress.findOne.mockResolvedValue(null);
    progress.create.mockImplementation((value: unknown) => ({ id: 'progress-1', ...value }));
    progress.save.mockImplementation((value: unknown) => Promise.resolve(value));

    await service.updateProgress('student-1', 'lesson-1', 60);

    expect(events.emit).toHaveBeenCalledWith(LESSON_COMPLETED_EVENT, {
      studentId: 'student-1',
      lessonId: 'lesson-1',
    });
    expect(events.emit).toHaveBeenCalledWith(
      PARENT_EVENT_CHANNEL,
      expect.objectContaining({
        studentId: 'student-1',
        subjectId: 'lesson-1',
        variables: { studentName: 'Amina', lessonName: 'Algebra' },
      }),
    );
  });

  it('does not emit completion events for a previously completed lesson', async () => {
    const service = new ProgressService(
      progress as never,
      lessons as never,
      users as never,
      events as unknown as EventEmitter2,
    );
    lessons.findOne.mockResolvedValue({ id: 'lesson-1', title: 'Algebra', duration: 60 });
    progress.findOne.mockResolvedValue({
      id: 'progress-1',
      completed: true,
      watched_duration: 60,
    });
    progress.save.mockImplementation((value: unknown) => Promise.resolve(value));

    await service.updateProgress('student-1', 'lesson-1', 60);

    expect(events.emit).not.toHaveBeenCalled();
  });
});
