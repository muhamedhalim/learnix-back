import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { FinancialReportFilterDto } from './commerce.dto';

const parse = async (query: Record<string, unknown>) => {
  const dto = plainToInstance(FinancialReportFilterDto, query);
  return { dto, errors: await validate(dto, { whitelist: true, forbidNonWhitelisted: true }) };
};

describe('FinancialReportFilterDto.widgets (T054)', () => {
  it('absent -> undefined (all widgets)', async () => {
    const { dto, errors } = await parse({});
    expect(errors).toHaveLength(0);
    expect(dto.widgets).toBeUndefined();
  });

  it('CSV becomes a de-duplicated array of known ids', async () => {
    const { dto, errors } = await parse({ widgets: 'summary, top_products,summary' });
    expect(errors).toHaveLength(0);
    expect(dto.widgets).toEqual(['summary', 'top_products']);
  });

  it('rejects an unknown widget id', async () => {
    const { errors } = await parse({ widgets: 'summary,drop_tables' });
    expect(errors.length).toBeGreaterThan(0);
  });
});
