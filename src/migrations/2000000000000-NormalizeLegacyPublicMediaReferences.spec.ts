import { NormalizeLegacyPublicMediaReferences2000000000000 } from './2000000000000-NormalizeLegacyPublicMediaReferences';

describe('NormalizeLegacyPublicMediaReferences migration', () => {
  it('repairs every public image reference without touching private files', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const migration = new NormalizeLegacyPublicMediaReferences2000000000000();

    await migration.up({ query } as never);

    expect(query).toHaveBeenCalledTimes(6);
    const statements = query.mock.calls.map(([sql]) => String(sql)).join('\n');
    for (const target of ['lessons', 'lesson_packages', 'books', 'subjects', 'users']) {
      expect(statements).toContain(`"${target}"`);
    }
    expect(statements).not.toContain('homework_submissions');
    expect(statements).not.toContain('book_file');
    expect(query.mock.calls.every(([, parameters]) => Array.isArray(parameters))).toBe(true);
  });
});
