import { UnifySubjectNameAndRemoveThumbnail2074000000000 } from './2074000000000-UnifySubjectNameAndRemoveThumbnail';

describe('UnifySubjectNameAndRemoveThumbnail2074000000000', () => {
  it('preserves a deterministic non-empty name before removing legacy columns', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    await new UnifySubjectNameAndRemoveThumbnail2074000000000().up({ query } as never);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('btrim("name_ar")');
    expect(sql).toContain("'Subject ' || subject.\"id\"::text");
    expect(sql).toContain('DROP COLUMN IF EXISTS "name_ar"');
    expect(sql).toContain('DROP COLUMN IF EXISTS "thumbnail"');
    expect(sql).not.toMatch(/(?:DELETE|TRUNCATE)\s+(?:FROM\s+)?"?subjects"?/i);
  });
});
