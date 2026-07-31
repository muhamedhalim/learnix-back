import { GrantAdminFinancePermissions2058000000000 } from './2058000000000-GrantAdminFinancePermissions';

describe('GrantAdminFinancePermissions migration', () => {
  it('grants the complete finance capability set to admins and clears non-admin grants', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const migration = new GrantAdminFinancePermissions2058000000000();

    await migration.up({ query } as never);

    expect(query).toHaveBeenCalledTimes(3);
    expect(String(query.mock.calls[0]?.[0])).toContain(`WHERE "role" = 'admin'`);
    expect(String(query.mock.calls[0]?.[0])).toContain('reports.view');
    expect(String(query.mock.calls[0]?.[0])).toContain('settlements.cancel');
    expect(String(query.mock.calls[1]?.[0])).toContain(`WHERE "role" <> 'admin'`);
    expect(String(query.mock.calls[2]?.[0])).toContain(`DEFAULT '[]'::jsonb`);
  });
});
