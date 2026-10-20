import { AddParentReports2083000000000 } from './2083000000000-AddParentReports';

describe('AddParentReports2083000000000', () => {
  /** What TypeORM's Postgres query runner really returns: `[rows, rowCount]` for UPDATE … RETURNING. */
  function queryRunner(backfilledRows: number) {
    const query = jest.fn(async (statement: string) => {
      if (statement.includes('UPDATE "lesson_progress"')) {
        return [Array.from({ length: backfilledRows }, (_, i) => ({ id: `p${String(i)}` })), backfilledRows];
      }
      return undefined;
    });
    return { query } as never;
  }

  afterEach(() => jest.restoreAllMocks());

  it.each([0, 1, 250])('logs the number of lesson_progress rows actually backfilled (%i) — FIA-003', async (rows) => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await new AddParentReports2083000000000().up(queryRunner(rows));

    const line = log.mock.calls.map(([message]) => String(message)).find((message) => message.startsWith('[DEF-006]'));
    expect(line).toContain(`Backfilled completed_at on ${String(rows)} already-completed`);
  });
});
