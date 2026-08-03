import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Repository } from 'typeorm';

import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotificationsService } from '../notifications/services/notifications.service';
import { PackagePurchase } from '../payments/entities/package-purchase.entity';
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
  const packagePurchases = {};
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
      packagePurchases as unknown as Repository<PackagePurchase>,
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
});
