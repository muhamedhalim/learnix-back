import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { AdminDashboardQueryDto } from './admin-dashboard-query.dto';

describe('AdminDashboardQueryDto', () => {
  it.each(['7', '30'] as const)('accepts the supported %s day period', async (days) => {
    const dto = plainToInstance(AdminDashboardQueryDto, { days });
    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.days).toBe(Number(days));
  });

  it('defaults to 30 days and rejects unsupported periods', async () => {
    const defaultDto = plainToInstance(AdminDashboardQueryDto, {});
    await expect(validate(defaultDto)).resolves.toHaveLength(0);
    expect(defaultDto.days).toBe(30);

    const invalid = plainToInstance(AdminDashboardQueryDto, { days: '14' });
    await expect(validate(invalid)).resolves.not.toHaveLength(0);
  });
});
