import 'reflect-metadata';

import {
  areBackgroundJobsEnabled,
  describeFeatureFlags,
  FEATURE_FLAGS,
  isFeatureEnabled,
} from './feature-flags';

function reader(values: Record<string, string | undefined>) {
  return (key: string): string | undefined => values[key];
}

const ALL_FLAGS = Object.values(FEATURE_FLAGS);

describe('feature flags default to enabled', () => {
  it.each(ALL_FLAGS)('%s is enabled when unset — production is unchanged', (flag) => {
    expect(isFeatureEnabled(flag, reader({}))).toBe(true);
  });

  it.each(ALL_FLAGS)('%s is enabled when set to an empty string', (flag) => {
    expect(isFeatureEnabled(flag, reader({ [flag]: '' }))).toBe(true);
  });

  it.each(ALL_FLAGS)('%s is enabled when set to "true"', (flag) => {
    expect(isFeatureEnabled(flag, reader({ [flag]: 'true' }))).toBe(true);
  });
});

describe('feature flags require an exact "false" to disable', () => {
  it.each(ALL_FLAGS)('%s is disabled by the exact string "false"', (flag) => {
    expect(isFeatureEnabled(flag, reader({ [flag]: 'false' }))).toBe(false);
  });

  // Financial and destructive jobs must not be switchable off by a near-miss.
  it.each(['FALSE', 'False', '0', 'no', 'off', 'disabled', ' false'])(
    'a near-miss value %s leaves the flag ENABLED',
    (value) => {
      expect(
        isFeatureEnabled(
          FEATURE_FLAGS.PAYMENT_RECONCILIATION,
          reader({
            ENABLE_PAYMENT_RECONCILIATION: value,
          }),
        ),
      ).toBe(true);
    },
  );
});

describe('flags are independent', () => {
  it('disabling one flag does not disable the others', () => {
    const env = reader({ ENABLE_FILE_CLEANUP: 'false' });
    expect(isFeatureEnabled(FEATURE_FLAGS.FILE_CLEANUP, env)).toBe(false);
    expect(isFeatureEnabled(FEATURE_FLAGS.PAYMENT_RECONCILIATION, env)).toBe(true);
    expect(isFeatureEnabled(FEATURE_FLAGS.WEBHOOK_REPLAY, env)).toBe(true);
    expect(isFeatureEnabled(FEATURE_FLAGS.NOTIFICATIONS, env)).toBe(true);
    expect(areBackgroundJobsEnabled(env)).toBe(true);
  });
});

describe('background jobs master switch', () => {
  it('is enabled when unset', () => {
    expect(areBackgroundJobsEnabled(reader({}))).toBe(true);
  });

  it('is disabled by ENABLE_BACKGROUND_JOBS=false', () => {
    expect(areBackgroundJobsEnabled(reader({ ENABLE_BACKGROUND_JOBS: 'false' }))).toBe(false);
  });
});

describe('flag reporting', () => {
  it('describes every flag without leaking any other configuration', () => {
    const state = describeFeatureFlags(reader({ ENABLE_WEBHOOK_REPLAY: 'false' }));
    expect(Object.keys(state).sort()).toEqual([...ALL_FLAGS].sort());
    expect(state['ENABLE_WEBHOOK_REPLAY']).toBe(false);
    expect(state['ENABLE_PAYMENT_RECONCILIATION']).toBe(true);
  });

  it('exposes exactly the five documented flags', () => {
    expect([...ALL_FLAGS].sort()).toEqual([
      'ENABLE_BACKGROUND_JOBS',
      'ENABLE_FILE_CLEANUP',
      'ENABLE_NOTIFICATIONS',
      'ENABLE_PAYMENT_RECONCILIATION',
      'ENABLE_WEBHOOK_REPLAY',
    ]);
  });
});
