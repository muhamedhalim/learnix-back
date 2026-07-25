import { HttpStatus } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';

import { TeacherLessonsController } from './teacher-lessons.controller';
import type { LessonsService } from '../lessons.service';

describe('TeacherLessonsController.create', () => {
  const service = {
    create: jest.fn(),
  };
  const controller = new TeacherLessonsController(service as unknown as LessonsService);
  const user = { userId: 'teacher-1' };
  const payload = {
    title: 'Algebra basics',
    subject_id: '11111111-1111-4111-8111-111111111111',
    price: 0,
  };

  beforeEach(() => jest.clearAllMocks());

  it('uses the authenticated teacher and returns the created lesson response', async () => {
    const lesson = { id: 'lesson-1', ...payload };
    service.create.mockResolvedValue(lesson);

    await expect(controller.create(user as never, payload)).resolves.toEqual({
      message: 'Lesson created successfully',
      lesson,
    });
    expect(service.create).toHaveBeenCalledWith(user.userId, payload);
  });

  it('declares the HTTP 201 contract for successful creates', () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, controller.create)).toBe(HttpStatus.CREATED);
  });
});
