import type { DataSource } from 'typeorm';

import { CronSingleRunner, registerCronLockDataSource, runWithCronLock } from './cron-lock.util';

function fakeDataSource(acquired: boolean) {
  const query = jest.fn((sql: string) =>
    Promise.resolve(sql.includes('pg_try_advisory_lock') ? [{ ok: acquired }] : []),
  );
  const release = jest.fn().mockResolvedValue(undefined);
  const runner = { connect: jest.fn().mockResolvedValue(undefined), query, release };
  return { ds: { createQueryRunner: () => runner } as unknown as DataSource, query, release };
}

describe('cron lock', () => {
  afterEach(() => registerCronLockDataSource(null));

  it('runs the task directly when no DataSource is registered', async () => {
    await expect(runWithCronLock('x', () => Promise.resolve(7))).resolves.toBe(7);
  });

  it('runs the task, then unlocks and releases the connection', async () => {
    const { ds, query, release } = fakeDataSource(true);
    registerCronLockDataSource(ds);
    await expect(runWithCronLock('x', () => Promise.resolve('done'), 0)).resolves.toBe('done');
    expect(query.mock.calls.map((c) => c[0] as string)).toEqual([
      expect.stringContaining('pg_try_advisory_lock'),
      expect.stringContaining('pg_advisory_unlock'),
    ]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('skips the task when another process holds the lock', async () => {
    const { ds, release } = fakeDataSource(false);
    registerCronLockDataSource(ds);
    const task = jest.fn();
    await expect(runWithCronLock('x', task)).resolves.toBeUndefined();
    expect(task).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('unlocks even when the task throws', async () => {
    const { ds, query } = fakeDataSource(true);
    registerCronLockDataSource(ds);
    await expect(runWithCronLock('x', () => Promise.reject(new Error('boom')), 0)).rejects.toThrow('boom');
    expect(query.mock.calls.some((c) => (c[0] as string).includes('pg_advisory_unlock'))).toBe(true);
  });

  it('keeps the lock for the hold window so a late replica skips the same tick', async () => {
    jest.useFakeTimers();
    try {
      const { ds, query, release } = fakeDataSource(true);
      registerCronLockDataSource(ds);
      await runWithCronLock('x', () => Promise.resolve(1), 30_000);
      expect(query.mock.calls.some((c) => (c[0] as string).includes('pg_advisory_unlock'))).toBe(false);
      expect(release).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(30_000);
      expect(query.mock.calls.some((c) => (c[0] as string).includes('pg_advisory_unlock'))).toBe(true);
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('decorator preserves `this` and arguments', async () => {
    class Job {
      public value = 5;
      @CronSingleRunner('job')
      public async run(add: number): Promise<number> {
        return this.value + add;
      }
    }
    const { ds } = fakeDataSource(true);
    registerCronLockDataSource(ds);
    await expect(new Job().run(2)).resolves.toBe(7);
    jest.clearAllTimers();
  });
});
