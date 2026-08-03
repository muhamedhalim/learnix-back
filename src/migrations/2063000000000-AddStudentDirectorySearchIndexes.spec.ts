import { AddStudentDirectorySearchIndexes2063000000000 } from './2063000000000-AddStudentDirectorySearchIndexes';

describe('AddStudentDirectorySearchIndexes2063000000000', () => {
  it('creates reversible trigram indexes for both searchable student name fields', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const migration = new AddStudentDirectorySearchIndexes2063000000000();

    await migration.up({ query } as never);
    await migration.down({ query } as never);

    expect(query).toHaveBeenCalledWith(expect.stringContaining('IDX_users_first_name_trgm'));
    expect(query).toHaveBeenCalledWith(expect.stringContaining('IDX_users_last_name_trgm'));
    expect(query).toHaveBeenCalledTimes(4);
  });
});
