import {
  assertExecutionGuards,
  BUNNY_CLEANUP_STATUS,
  classifyTables,
  databaseIdentity,
  redisOwnedPatterns,
  UnsafePrelaunchResetError,
} from './prelaunch-reset';

describe('prelaunch reset safety', () => {
  const identity = { host: 'db.internal', database: 'railway', environment: 'production' };

  it('classifies only entity-backed tables as application data', () => {
    expect(
      classifyTables(
        ['users', 'rank_tiers', 'health_alert_rules', 'migrations', 'typeorm_metadata', 'mystery'],
        ['users', 'rank_tiers', 'health_alert_rules'],
      ),
    ).toEqual({
      application: ['users'],
      system: ['health_alert_rules', 'rank_tiers'],
      metadata: ['migrations', 'typeorm_metadata'],
      unknown: ['mystery'],
    });
  });

  it('never exposes credentials in the target identity', () => {
    expect(
      databaseIdentity({
        DATABASE_URL: 'postgres://secret-user:secret-pass@db.internal:5432/railway',
        APP_ENV: 'production',
      }),
    ).toEqual(identity);
  });

  it('requires every destructive production guard', () => {
    expect(() =>
      assertExecutionGuards(
        {
          APP_ENV: 'production',
          DATABASE_URL: 'postgres://user:pass@db.internal/railway',
        },
        identity,
        { skipExternal: false },
      ),
    ).toThrow(UnsafePrelaunchResetError);
  });

  it('accepts an exact armed target with backup and stopped-service evidence', () => {
    expect(() =>
      assertExecutionGuards(
        {
          APP_ENV: 'production',
          DATABASE_URL: 'postgres://user:pass@db.internal/railway',
          REDIS_URL: 'redis://redis.internal:6379',
          RESET_PRELAUNCH_DATA: 'true',
          RESET_PRELAUNCH_BACKUP_CONFIRMED: 'true',
          RESET_PRELAUNCH_BACKUP_REFERENCE: 'railway-backup-2026-08-10',
          RESET_PRELAUNCH_SERVICES_STOPPED: 'true',
          RESET_PRELAUNCH_TARGET: 'db.internal/railway',
          RESET_PRELAUNCH_REDIS_DEDICATED: 'true',
        },
        identity,
        { skipExternal: false },
      ),
    ).not.toThrow();
  });

  it('scopes BullMQ cleanup to the declared Learnix queues', () => {
    const patterns = redisOwnedPatterns({ APP_ENV: 'production' });
    expect(patterns).toContain('bull:exam-auto-submit:*');
    expect(patterns).toContain('bull:gamification:*');
    expect(patterns).not.toContain('*');
  });

  it('always preserves Bunny Stream assets during the pre-launch reset', () => {
    expect(BUNNY_CLEANUP_STATUS).toBe('SKIPPED BY USER REQUEST');
  });
});
