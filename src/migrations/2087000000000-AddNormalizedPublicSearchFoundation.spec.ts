import { AddNormalizedPublicSearchFoundation2087000000000 } from './2087000000000-AddNormalizedPublicSearchFoundation';

describe('AddNormalizedPublicSearchFoundation2087000000000', () => {
  it('creates a reversible normalized representation and matching partial trigram indexes', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const migration = new AddNormalizedPublicSearchFoundation2087000000000();

    await migration.up({ query } as never);
    const upStatements = query.mock.calls.map(([sql]) => String(sql));
    await migration.down({ query } as never);
    const statements = query.mock.calls.map(([sql]) => String(sql));

    expect(migration.transaction).toBe(false);
    expect(upStatements.join('\n')).toContain('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    expect(upStatements.join('\n')).toContain('learnix_normalize_search_text');
    expect(upStatements.join('\n')).toContain('GENERATED ALWAYS AS');
    expect(upStatements.join('\n')).toContain('lower(input)');
    expect(upStatements.join('\n')).toContain('آأإٱىة');
    expect(upStatements.join('\n')).toContain('gin_trgm_ops');
    expect(upStatements.join('\n')).toContain('IDX_users_public_teacher_search_text_trgm');
    expect(upStatements.join('\n')).toContain('IDX_users_support_search_text_trgm');
    expect(upStatements.join('\n')).toContain('"role" = \'teacher\'');
    expect(upStatements.join('\n')).toContain('"deleted_at" IS NULL');
    expect(statements.join('\n')).toContain(
      'DROP FUNCTION IF EXISTS public.learnix_normalize_search_text',
    );
  });
});
