import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CatalogQueryDto } from './catalog-query.dto';

async function parse(query: Record<string, string>) {
  const dto = plainToInstance(CatalogQueryDto, query);
  return { dto, errors: await validate(dto, { whitelist: true, forbidNonWhitelisted: true }) };
}

describe('CatalogQueryDto boolean flags (MP-22)', () => {
  it.each([
    ['true', true],
    ['1', true],
    ['false', false],
    ['0', false],
    ['FALSE', false],
  ])('freeOnly=%s parses to %s', async (raw, expected) => {
    const { dto, errors } = await parse({ freeOnly: raw });
    expect(errors).toHaveLength(0);
    expect(dto.freeOnly).toBe(expected);
  });

  it('certificateOnly=false is no longer read as true', async () => {
    const { dto, errors } = await parse({ certificateOnly: 'false' });
    expect(errors).toHaveLength(0);
    expect(dto.certificateOnly).toBe(false);
  });

  it('rejects a value that is not a boolean instead of guessing', async () => {
    const { errors } = await parse({ freeOnly: 'maybe' });
    expect(errors.map((e) => e.property)).toContain('freeOnly');
  });

  it('leaves absent flags undefined', async () => {
    const { dto, errors } = await parse({});
    expect(errors).toHaveLength(0);
    expect(dto.freeOnly).toBeUndefined();
  });
});
