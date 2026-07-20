import { BadRequestException, ValidationPipe } from '@nestjs/common';

import { PublicTeacherFilterDto } from '../../teachers/dto';
import { Pagination20Dto, PaginationDto } from './pagination.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});

async function query<T extends object>(metatype: new () => T, value: object): Promise<T> {
  return pipe.transform(value, { type: 'query', metatype });
}

describe('strict pagination query validation', () => {
  it.each([
    { page: '0' },
    { page: '-1' },
    { page: '1.5' },
    { page: 'abc' },
    { page: "1' OR '1'='1" },
    { page: ' ' },
    { page: '1e2' },
    { page: 'Infinity' },
    { page: '9007199254740992' },
    { page: ['1', '2'] },
    { limit: '0' },
    { limit: '-1' },
    { limit: '1.5' },
    { limit: 'abc' },
    { limit: '101' },
    { limit: '999999' },
    { limit: ['10', '20'] },
  ])('rejects explicitly invalid input %#: %p', async (value) => {
    await expect(query(PaginationDto, value)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('uses documented defaults only when values are missing', async () => {
    await expect(query(PaginationDto, {})).resolves.toMatchObject({ page: 1, limit: 10 });
    await expect(query(Pagination20Dto, {})).resolves.toMatchObject({ page: 1, limit: 20 });
  });

  it('accepts the maximum limit and returns numeric validated metadata values', async () => {
    const result = await query(PaginationDto, { page: '101', limit: '100' });
    expect(result).toMatchObject({ page: 101, limit: 100 });
    expect(typeof result.page).toBe('number');
    expect(typeof result.limit).toBe('number');
  });

  it('retains runtime validation on the public teacher DTO', async () => {
    await expect(query(PublicTeacherFilterDto, { page: '0', limit: '20' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(query(PublicTeacherFilterDto, {})).resolves.toMatchObject({ page: 1, limit: 20 });
  });
});
