import { BadRequestException, ValidationPipe } from '@nestjs/common';

import { MarketplaceReasonDto } from './reason.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});

async function body(value: object): Promise<MarketplaceReasonDto> {
  return pipe.transform(value, { type: 'body', metatype: MarketplaceReasonDto });
}

describe('MarketplaceReasonDto (FR-018, FR-020 — reason mandatory)', () => {
  it('accepts a reason and stores it trimmed', async () => {
    await expect(body({ reason: '  Incomplete portfolio  ' })).resolves.toMatchObject({
      reason: 'Incomplete portfolio',
    });
  });

  it.each([{}, { reason: '' }, { reason: '   ' }, { reason: '\n\t ' }])(
    'refuses a missing or blank reason: %j',
    async (value) => {
      await expect(body(value)).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it('refuses a reason over 1000 characters', async () => {
    await expect(body({ reason: 'x'.repeat(1001) })).rejects.toBeInstanceOf(BadRequestException);
  });
});
