import { BadRequestException, ValidationPipe } from '@nestjs/common';

import { CreateLessonDto } from './create-lesson.dto';
import { UpdateLessonDto } from './update-lesson.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});

function body<T extends object>(metatype: new () => T, value: object): Promise<T> {
  return pipe.transform(value, { type: 'body', metatype });
}

const validLesson = {
  title: 'Algebra lesson',
  subject_id: '11111111-1111-4111-8111-111111111111',
  price: 0,
};

describe('lesson duration validation', () => {
  it('allows creation before a video duration is known', async () => {
    await expect(body(CreateLessonDto, validLesson)).resolves.toMatchObject({
      ...validLesson,
      duration: undefined,
    });
  });

  it.each([{ duration: -1 }, { duration: 1.5 }, { duration: 'not-a-duration' }])(
    'rejects an invalid duration on create: %p',
    async (value) => {
      await expect(body(CreateLessonDto, { ...validLesson, ...value })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    },
  );

  it.each([{ duration: -1 }, { duration: 1.5 }, { duration: 'not-a-duration' }])(
    'applies the same duration validation on update: %p',
    async (value) => {
      await expect(body(UpdateLessonDto, value)).rejects.toBeInstanceOf(BadRequestException);
    },
  );
});
