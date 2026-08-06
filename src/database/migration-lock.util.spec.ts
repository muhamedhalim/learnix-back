import type { DataSource } from 'typeorm';

import { withMigrationAdvisoryLock } from './migration-lock.util';

function fakeDataSource(): { dataSource: DataSource; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const dataSource = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      calls.push([sql, params]);
      if (sql.startsWith('SELECT hashtext')) {
        return [{ id: '123456789' }];
      }
      return [];
    }),
  } as unknown as DataSource;
  return { dataSource, calls };
}

describe('withMigrationAdvisoryLock', () => {
  it('acquires the lock, runs the callback, then releases the lock', async () => {
    const { dataSource, calls } = fakeDataSource();
    const order: string[] = [];

    const result = await withMigrationAdvisoryLock(dataSource, async () => {
      order.push('callback');
      return 'done';
    });

    expect(result).toBe('done');
    expect(order).toEqual(['callback']);

    const sqlCalls = calls.map(([sql]) => sql as string);
    expect(sqlCalls[0]).toContain('hashtext');
    expect(sqlCalls[1]).toBe('SELECT pg_advisory_lock($1)');
    expect(sqlCalls[2]).toBe('SELECT pg_advisory_unlock($1)');
  });

  it('releases the lock even when the callback throws', async () => {
    const { dataSource, calls } = fakeDataSource();

    await expect(
      withMigrationAdvisoryLock(dataSource, async () => {
        throw new Error('migration failed');
      }),
    ).rejects.toThrow('migration failed');

    const sqlCalls = calls.map(([sql]) => sql as string);
    expect(sqlCalls).toContain('SELECT pg_advisory_unlock($1)');
  });

  it('uses the same lock ID for both the lock and unlock calls', async () => {
    const { dataSource, calls } = fakeDataSource();

    await withMigrationAdvisoryLock(dataSource, async () => undefined);

    const lockCall = calls.find(([sql]) => sql === 'SELECT pg_advisory_lock($1)');
    const unlockCall = calls.find(([sql]) => sql === 'SELECT pg_advisory_unlock($1)');
    expect(lockCall?.[1]).toEqual(unlockCall?.[1]);
  });

  it('invokes the optional logger at each stage', async () => {
    const { dataSource } = fakeDataSource();
    const messages: string[] = [];

    await withMigrationAdvisoryLock(
      dataSource,
      async () => undefined,
      (message) => messages.push(message),
    );

    expect(messages.some((message) => message.includes('Waiting'))).toBe(true);
    expect(messages.some((message) => message.includes('acquired'))).toBe(true);
    expect(messages.some((message) => message.includes('released'))).toBe(true);
  });
});
