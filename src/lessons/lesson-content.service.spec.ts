import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Repository } from 'typeorm';

import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotificationsService } from '../notifications/services/notifications.service';
import { LessonPurchase } from '../payments/entities/lesson-purchase.entity';
import { StorageService } from '../storage/storage.service';
import { User } from '../users/entities/user.entity';
import { HomeworkSubmission } from './entities/homework-submission.entity';
import { Lesson } from './entities/lesson.entity';
import { LessonAttachment } from './entities/lesson-attachment.entity';
import { LessonHomework } from './entities/lesson-homework.entity';
import { LessonNote } from './entities/lesson-note.entity';
import { LessonContentService } from './lesson-content.service';

describe('LessonContentService attachment and submission access', () => {
  const lessons = { findOne: jest.fn() };
  const attachments = { create: jest.fn(), findOne: jest.fn(), save: jest.fn(), remove: jest.fn() };
  const homework = { findOne: jest.fn(), createQueryBuilder: jest.fn() };
  const submissions = { findOne: jest.fn() };
  const notes = {};
  const lessonPurchases = {};
  const users = {};
  const storage = { toKey: jest.fn(), tryDelete: jest.fn(), getObject: jest.fn() };
  const config = { get: jest.fn() };
  let service: LessonContentService;

  beforeEach(() => {
    jest.clearAllMocks();
    config.get.mockReturnValue('http://localhost:3001');
    service = new LessonContentService(
      lessons as unknown as Repository<Lesson>,
      attachments as unknown as Repository<LessonAttachment>,
      homework as unknown as Repository<LessonHomework>,
      submissions as unknown as Repository<HomeworkSubmission>,
      notes as unknown as Repository<LessonNote>,
      lessonPurchases as unknown as Repository<LessonPurchase>,
      users as unknown as Repository<User>,
      {} as NotificationsService,
      {} as EventEmitter2,
      storage as unknown as StorageService,
      config as unknown as ConfigService,
    );
  });

  it('rejects an attachment reference outside the owning teacher private prefix', async () => {
    lessons.findOne.mockResolvedValue({ id: 'lesson-1', teacher_id: 'teacher-1' });

    await expect(
      service.addAttachment('lesson-1', 'teacher-1', {
        name: 'worksheet.pdf',
        url: 'lesson-resources/teacher-2/worksheet.pdf',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(attachments.create).not.toHaveBeenCalled();
  });

  it('denies a foreign teacher before deleting the attachment object', async () => {
    lessons.findOne.mockResolvedValue({ id: 'lesson-1', teacher_id: 'teacher-2' });

    await expect(
      service.deleteAttachment('lesson-1', 'attachment-1', 'teacher-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(attachments.findOne).not.toHaveBeenCalled();
    expect(storage.tryDelete).not.toHaveBeenCalled();
  });

  it('looks up a submission file with the authenticated student id only', async () => {
    jest.spyOn(service, 'assertStudentCanAccessHomework').mockResolvedValue({} as LessonHomework);
    submissions.findOne.mockResolvedValue({
      resource_url: 'homework-submissions/student-1/work.pdf',
    });
    storage.toKey.mockReturnValue('homework-submissions/student-1/work.pdf');
    storage.getObject.mockResolvedValue({ body: Buffer.from('submission') });

    await service.getSubmissionFileForStudent('student-1', 'homework-1');

    expect(submissions.findOne).toHaveBeenCalledWith({
      where: { homework_id: 'homework-1', student_id: 'student-1' },
    });
  });

  it('uses only an unexpired lesson purchase for student homework access', async () => {
    const chain: Record<string, jest.Mock> = {};
    for (const method of ['where', 'andWhere', 'leftJoinAndSelect'] as const) {
      chain[method] = jest.fn(() => chain);
    }
    chain['getOne'] = jest.fn().mockResolvedValue(null);
    homework.createQueryBuilder.mockReturnValue(chain);

    (service as unknown as {
      applyStudentHomeworkAccess: (query: typeof chain, studentId: string) => void;
    }).applyStudentHomeworkAccess(chain, 'student-1');

    const sql = chain.andWhere.mock.calls.map(([value]) => String(value)).join(' ');
    expect(sql).toContain('lesson_purchases');
    expect(sql).toContain('access_expires_at > :accessNow');
    expect(sql).not.toContain('package_purchases');
  });
});

describe('LessonContentService homework notification fan-out (T069)', () => {
  const order: string[] = [];
  const lessons = { findOne: jest.fn() };
  const notifications = { createMany: jest.fn() };
  const events = { emit: jest.fn() };
  let purchaseQuery: jest.Mock;
  let userQb: Record<string, jest.Mock>;
  let service: LessonContentService;

  const homework = {
    id: 'hw-1',
    lesson_id: 'lesson-1',
    title: 'Fractions',
    title_ar: null,
    description: 'Do all of them',
    description_ar: null,
    due_at: new Date('2026-03-01T10:00:00.000Z'),
  } as unknown as LessonHomework;

  const student = (id: string, preferred_language: string) => ({
    id,
    name: `Name ${id}`,
    preferred_language,
  });

  const dispatch = async (action: 'assigned' | 'updated'): Promise<void> =>
    (
      service as unknown as {
        dispatchHomeworkNotifications: (h: LessonHomework, a: string) => Promise<void>;
      }
    ).dispatchHomeworkNotifications(homework, action);

  beforeEach(() => {
    jest.clearAllMocks();
    order.length = 0;
    lessons.findOne.mockResolvedValue({ id: 'lesson-1', title: 'Math' });
    // The homework audience now comes from the shared audience builder (a parameterised query).
    purchaseQuery = jest.fn().mockResolvedValue([{ student_id: 's1' }, { student_id: 's2' }, { student_id: 's3' }]);
    userQb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getMany: jest
        .fn()
        .mockResolvedValue([student('s1', 'ar'), student('s2', 'en'), student('s3', 'ar')]),
    };
    notifications.createMany.mockImplementation(async () => {
      order.push('createMany');
      return [
        { ok: true, id: 'n1' },
        { ok: false, error: new Error('x') },
        { ok: true, id: 'n3' },
      ];
    });
    events.emit.mockImplementation((_channel: string, event: { studentId?: string }) => {
      order.push(`event:${String(event.studentId)}`);
    });
    service = new LessonContentService(
      lessons as unknown as Repository<Lesson>,
      {} as unknown as Repository<LessonAttachment>,
      {} as unknown as Repository<LessonHomework>,
      {} as unknown as Repository<HomeworkSubmission>,
      {} as unknown as Repository<LessonNote>,
      { manager: { query: purchaseQuery } } as unknown as Repository<LessonPurchase>,
      { createQueryBuilder: jest.fn().mockReturnValue(userQb) } as unknown as Repository<User>,
      notifications as unknown as NotificationsService,
      events as unknown as EventEmitter2,
      {} as unknown as StorageService,
      { get: jest.fn().mockReturnValue('http://localhost:3001') } as unknown as ConfigService,
    );
  });

  it('creates every notification in one createMany call with localized rows and no SMS', async () => {
    await dispatch('assigned');

    expect(userQb['where']).toHaveBeenCalledWith('u.id = ANY(:studentIds)', {
      studentIds: ['s1', 's2', 's3'],
    });
    expect(notifications.createMany).toHaveBeenCalledTimes(1);
    const rows = notifications.createMany.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
    expect(rows.map((row) => row['user_id'])).toEqual(['s1', 's2', 's3']);
    expect(rows.every((row) => row['send_sms'] === false && row['type'] === 'homework')).toBe(true);
    expect(rows.map((row) => row['title'])).toEqual(['واجب جديد', 'New homework', 'واجب جديد']);
    expect(rows[1]).toMatchObject({
      message: expect.stringContaining('Fractions — Do all of them — due '),
      data: {
        homework_id: 'hw-1',
        lesson_id: 'lesson-1',
        due_at: '2026-03-01T10:00:00.000Z',
        href: '/student/homework',
      },
    });
  });

  it('emits HomeworkAssignedEvent only for inserted rows, in order, after the insert returned', async () => {
    await dispatch('assigned');

    expect(order).toEqual(['createMany', 'event:s1', 'event:s3']);
    expect(events.emit).toHaveBeenCalledTimes(2);
    const first = events.emit.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(first).toMatchObject({
      studentId: 's1',
      subjectId: 'hw-1',
      variables: {
        studentName: 'Name s1',
        lessonName: 'Math',
        homeworkTitle: 'Fractions',
        dueAt: '2026-03-01T10:00:00.000Z',
      },
    });
  });

  it('emits no event when the homework was only updated', async () => {
    await dispatch('updated');

    expect(notifications.createMany).toHaveBeenCalledTimes(1);
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('does nothing without an audience', async () => {
    purchaseQuery.mockResolvedValue([]);

    await dispatch('assigned');

    expect(notifications.createMany).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('does nothing for a lesson that no longer exists', async () => {
    lessons.findOne.mockResolvedValue(null);

    await dispatch('assigned');

    expect(notifications.createMany).not.toHaveBeenCalled();
  });
});
