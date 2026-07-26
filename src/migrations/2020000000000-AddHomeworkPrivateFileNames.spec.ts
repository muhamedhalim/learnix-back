import { AddHomeworkPrivateFileNames2020000000000 } from './2020000000000-AddHomeworkPrivateFileNames';

describe('AddHomeworkPrivateFileNames migration', () => {
  it('adds nullable display-name columns without rewriting private object keys', async () => {
    const query = jest.fn().mockResolvedValue(undefined);

    await new AddHomeworkPrivateFileNames2020000000000().up({ query } as never);

    expect(query).toHaveBeenCalledTimes(2);
    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('"lesson_homework"');
    expect(sql).toContain('"homework_submissions"');
    expect(sql).toContain('"resource_filename" varchar(255)');
    expect(sql).not.toMatch(/UPDATE|DELETE/);
  });
});
