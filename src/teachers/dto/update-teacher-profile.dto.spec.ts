import { BadRequestException, ValidationPipe } from '@nestjs/common';

import { UpdateTeacherProfileDto } from './update-teacher-profile.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});

function body(value: object): Promise<UpdateTeacherProfileDto> {
  return pipe.transform(value, { type: 'body', metatype: UpdateTeacherProfileDto });
}

describe('UpdateTeacherProfileDto qualifications validation', () => {
  it.each([
    ['empty text', '', ''],
    ['one character', 'A', 'A'],
    ['more than ten characters', 'Physics educator', 'Physics educator'],
    ['Arabic text', '  مدرس فيزياء  ', 'مدرس فيزياء'],
    ['whitespace-only text', '   ', ''],
  ])('accepts and trims %s', async (_label, value, expected) => {
    await expect(body({ qualifications: value })).resolves.toMatchObject({
      qualifications: expected,
    });
  });

  it('allows qualifications to be omitted', async () => {
    await expect(body({})).resolves.toMatchObject({ qualifications: undefined });
  });

  it('continues to reject text exceeding the database-aligned maximum', async () => {
    await expect(body({ qualifications: 'a'.repeat(2001) })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
