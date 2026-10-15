import {
  buildGrantStatements,
  buildRoleStatement,
  ensureAppRole,
  readAppRoleConfig,
  type AppRoleConfig,
} from './app-role.util';

const config: AppRoleConfig = {
  user: 'learnix_app',
  password: 'p@ss',
  database: 'learnix',
  schema: 'public',
};

describe('app role', () => {
  it('is skipped unless both user and password are set', () => {
    expect(readAppRoleConfig({}, 'db')).toBeNull();
    expect(readAppRoleConfig({ APP_DB_USER: 'a' }, 'db')).toBeNull();
    expect(readAppRoleConfig({ APP_DB_USER: 'a', APP_DB_PASSWORD: 'b' }, 'db')).toEqual({
      user: 'a',
      password: 'b',
      database: 'db',
      schema: 'public',
    });
  });

  it('never grants DDL, superuser or role creation', () => {
    const sql = [buildRoleStatement(config, false), ...buildGrantStatements(config)].join('\n');
    expect(sql).toContain('NOSUPERUSER NOCREATEDB NOCREATEROLE');
    expect(sql).not.toMatch(/ALL PRIVILEGES|\bCREATE\b ON|TRUNCATE|OWNER/i);
  });

  it('escapes quotes in the password and rejects unsafe identifiers', () => {
    expect(buildRoleStatement({ ...config, password: "a'b" }, true)).toContain("PASSWORD 'a''b'");
    expect(() => buildRoleStatement({ ...config, user: 'x"; DROP ROLE y; --' }, true)).toThrow();
    expect(() => buildGrantStatements({ ...config, database: 'a b' })).toThrow();
  });

  it('creates when missing, alters (password sync) when present, then grants', async () => {
    const run = async (exists: boolean) => {
      const query = jest
        .fn()
        .mockResolvedValueOnce(exists ? [{}] : [])
        .mockResolvedValue([]);
      await ensureAppRole({ query } as never, config);
      return query.mock.calls.map((c) => c[0] as string);
    };
    const created = await run(false);
    expect(created[1]).toMatch(/^CREATE ROLE "learnix_app"/);
    const altered = await run(true);
    expect(altered[1]).toMatch(/^ALTER ROLE "learnix_app"/);
    expect(altered).toHaveLength(1 + 1 + buildGrantStatements(config).length);
  });
});
