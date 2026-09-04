import { AddApplicationPersonalDataPurgedAt2109000000000 } from './2109000000000-AddApplicationPersonalDataPurgedAt';

describe('AddApplicationPersonalDataPurgedAt migration', () => {
  it('adds a nullable personal_data_purged_at column and a partial sweep index', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    await new AddApplicationPersonalDataPurgedAt2109000000000().up({ query } as never);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "personal_data_purged_at" timestamptz NULL');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "IDX_mp_applications_retention_sweep"');
  });

  it('down() drops the index and the column', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    await new AddApplicationPersonalDataPurgedAt2109000000000().down({ query } as never);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('DROP INDEX IF EXISTS "IDX_mp_applications_retention_sweep"');
    expect(sql).toContain('DROP COLUMN IF EXISTS "personal_data_purged_at"');
  });
});
