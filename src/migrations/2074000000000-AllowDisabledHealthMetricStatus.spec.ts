import type { QueryRunner } from 'typeorm';

import { AllowDisabledHealthMetricStatus2074000000000 } from './2074000000000-AllowDisabledHealthMetricStatus';

describe('AllowDisabledHealthMetricStatus2074000000000', () => {
  it('allows the disabled health status emitted by configured probes', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const migration = new AllowDisabledHealthMetricStatus2074000000000();

    await migration.up({ query } as unknown as QueryRunner);

    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[1]?.[0])).toContain("'disabled'");
  });
});
