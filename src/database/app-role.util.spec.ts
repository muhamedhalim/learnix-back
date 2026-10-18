import {
  buildGrantStatements,
  buildRoleStatement,
  ensureAppRole,
  readAppRoleConfig,
  resolveDatabaseName,
  scramSha256Verifier,
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

  it('never puts the plaintext password in SQL and rejects unsafe identifiers', () => {
    const sql = buildRoleStatement({ ...config, password: "a'b-plain" }, true);
    expect(sql).not.toContain('plain');
    expect(sql).toMatch(
      /PASSWORD 'SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+'$/,
    );
    expect(() => buildRoleStatement({ ...config, user: 'x"; DROP ROLE y; --' }, true)).toThrow();
    expect(() => buildGrantStatements({ ...config, database: 'a b' })).toThrow();
  });

  it('builds the SCRAM-SHA-256 verifier PostgreSQL expects', () => {
    // Format and determinism only; that PostgreSQL accepts a login with it is checked against a real server
    // by running the migrate task and then the api as the application role.
    const salt = Buffer.alloc(16, 1);
    const verifier = scramSha256Verifier('pencil', salt);
    expect(verifier.startsWith(`SCRAM-SHA-256$4096:${salt.toString('base64')}$`)).toBe(true);
    expect(scramSha256Verifier('pencil', salt)).toBe(verifier);
    expect(scramSha256Verifier('pencil2', salt)).not.toBe(verifier);
  });

  it('resolves the database name when TypeORM connects through a URL', () => {
    expect(resolveDatabaseName('configured', { DB_NAME: 'x' })).toBe('configured');
    expect(resolveDatabaseName(undefined, { DB_NAME: 'learnix' })).toBe('learnix');
    expect(resolveDatabaseName('', { DATABASE_URL: 'postgresql://u:p@host:5432/learnix' })).toBe(
      'learnix',
    );
    expect(resolveDatabaseName(undefined, {})).toBe('');
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
