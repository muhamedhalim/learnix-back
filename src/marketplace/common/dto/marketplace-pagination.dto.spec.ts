import { BadRequestException, ValidationPipe } from '@nestjs/common';

import { MarketplaceListQueryDto } from './marketplace-pagination.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});

async function query<T extends object>(metatype: new () => T, value: object): Promise<T> {
  return pipe.transform(value, { type: 'query', metatype });
}

describe('MarketplaceListQueryDto (FR-077, FR-281)', () => {
  it('defaults to page 1, limit 20 when unset', async () => {
    const result = await query(MarketplaceListQueryDto, {});
    expect(result).toMatchObject({ page: 1, limit: 20 });
  });

  it('accepts the maximum limit of 100', async () => {
    const result = await query(MarketplaceListQueryDto, { limit: '100' });
    expect(result.limit).toBe(100);
  });

  it('refuses a limit above 100 — never silently clamps', async () => {
    await expect(query(MarketplaceListQueryDto, { limit: '101' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(query(MarketplaceListQueryDto, { limit: '999999' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses malformed limit and page values', async () => {
    await expect(query(MarketplaceListQueryDto, { limit: 'abc' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(query(MarketplaceListQueryDto, { page: '0' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(query(MarketplaceListQueryDto, { page: '-1' })).rejects.toBeInstanceOf(BadRequestException);
  });
});
