import type { DataSource } from 'typeorm';

import { MigrationLockTimeoutError, withMigrationAdvisoryLock } from './migration-lock.util';

function fakeDataSource(options: { failLockAcquireWith?: unknown } = {}): {
  dataSource: DataSource;
  calls: unknown[][];
  stats: { runnersCreated: number; released: number };
} {
  const calls: unknown[][] = [];
  const stats = { runnersCreated: 0, released: 0 };

  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    calls.push([sql, params]);
    if (sql.startsWith('SELECT hashtext')) {
      return [{ id: '123456789' }];
    }
    if (sql === 'SELECT pg_advisory_lock($1)' && options.failLockAcquireWith !== undefined) {
      throw options.failLockAcquireWith;
    }
    return [];
  });

  const dataSource = {
    // Every real caller (main.ts, migrate-cli.ts, the verification scripts)
    // goes through a dedicated QueryRunner rather than dataSource.query(), so
    // the fake mirrors that shape: one query log shared by every runner this
    // fake ever creates, so tests can still assert call order across the
    // whole operation regardless of which "connection" issued which query.
    createQueryRunner: jest.fn(() => {
      stats.runnersCreated++;
      return {
        connect: jest.fn(async () => undefined),
        query,
        release: jest.fn(async () => {
          stats.released++;
        }),
      };
    }),
  } as unknown as DataSource;

  return { dataSource, calls, stats };
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
    expect(sqlCalls[1]).toBe('SET lock_timeout = 300000');
    expect(sqlCalls[2]).toBe('SELECT pg_advisory_lock($1)');
    expect(sqlCalls).toContain('SELECT pg_advisory_unlock($1)');
    expect(sqlCalls.indexOf('SELECT pg_advisory_unlock($1)')).toBeGreaterThan(
      sqlCalls.indexOf('SELECT pg_advisory_lock($1)'),
    );
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

  it('sets a lock_timeout before attempting to acquire the lock', async () => {
    const { dataSource, calls } = fakeDataSource();

    await withMigrationAdvisoryLock(dataSource, async () => undefined);

    const sqlCalls = calls.map(([sql]) => sql as string);
    const setIndex = sqlCalls.findIndex((sql) => sql.startsWith('SET lock_timeout ='));
    const lockIndex = sqlCalls.indexOf('SELECT pg_advisory_lock($1)');
    expect(setIndex).toBeGreaterThanOrEqual(0);
    expect(setIndex).toBeLessThan(lockIndex);
  });

  it('resets lock_timeout back to 0 immediately after acquiring, before running fn', async () => {
    const { dataSource, calls } = fakeDataSource();

    await withMigrationAdvisoryLock(dataSource, async () => undefined);

    const sqlCalls = calls.map(([sql]) => sql as string);
    const lockIndex = sqlCalls.indexOf('SELECT pg_advisory_lock($1)');
    const resetIndex = sqlCalls.indexOf('SET lock_timeout = 0');
    expect(resetIndex).toBeGreaterThan(lockIndex);
  });

  it('throws MigrationLockTimeoutError — not a hang — when Postgres reports lock_timeout (55P03)', async () => {
    const { dataSource } = fakeDataSource({ failLockAcquireWith: { code: '55P03' } });

    await expect(withMigrationAdvisoryLock(dataSource, async () => undefined)).rejects.toThrow(
      MigrationLockTimeoutError,
    );
  });

  it('never calls fn when the lock acquisition itself times out', async () => {
    const { dataSource } = fakeDataSource({ failLockAcquireWith: { code: '55P03' } });
    const fn = jest.fn(async () => undefined);

    await expect(withMigrationAdvisoryLock(dataSource, fn)).rejects.toThrow(
      MigrationLockTimeoutError,
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it('re-throws an unrelated query error unchanged, without wrapping it as a lock timeout', async () => {
    const { dataSource } = fakeDataSource({ failLockAcquireWith: new Error('connection reset') });

    await expect(withMigrationAdvisoryLock(dataSource, async () => undefined)).rejects.toThrow(
      'connection reset',
    );
  });

  it('never leaves an unlock call pending when the lock was never actually acquired', async () => {
    const { dataSource, calls } = fakeDataSource({ failLockAcquireWith: { code: '55P03' } });

    await expect(withMigrationAdvisoryLock(dataSource, async () => undefined)).rejects.toThrow(
      MigrationLockTimeoutError,
    );

    const sqlCalls = calls.map(([sql]) => sql as string);
    expect(sqlCalls).not.toContain('SELECT pg_advisory_unlock($1)');
  });

  it('runs the entire critical section on exactly one dedicated connection', async () => {
    // Regression guard: an earlier version issued each statement via
    // dataSource.query(), which can hand out a *different* pooled connection
    // per call. Because advisory locks and lock_timeout are session-scoped,
    // that could acquire the lock on one session and later try to release it
    // (or apply the timeout) on another — a silent no-op. Exactly one
    // QueryRunner, created once and released once, is what rules that out.
    const { dataSource, stats } = fakeDataSource();

    await withMigrationAdvisoryLock(dataSource, async () => undefined);

    expect(stats.runnersCreated).toBe(1);
    expect(stats.released).toBe(1);
  });

  it('releases the dedicated connection even when the lock acquisition times out', async () => {
    const { dataSource, stats } = fakeDataSource({ failLockAcquireWith: { code: '55P03' } });

    await expect(withMigrationAdvisoryLock(dataSource, async () => undefined)).rejects.toThrow(
      MigrationLockTimeoutError,
    );

    expect(stats.released).toBe(1);
  });

  it('releases the dedicated connection even when fn throws', async () => {
    const { dataSource, stats } = fakeDataSource();

    await expect(
      withMigrationAdvisoryLock(dataSource, async () => {
        throw new Error('migration failed');
      }),
    ).rejects.toThrow('migration failed');

    expect(stats.released).toBe(1);
  });
});
