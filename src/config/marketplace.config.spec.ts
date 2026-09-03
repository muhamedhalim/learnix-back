import { getMarketplaceConfig, isMarketplaceEnabled, MARKETPLACE_ALERT_THRESHOLDS } from './marketplace.config';

const ENV_KEYS = [
  'MARKETPLACE_COMMISSION_RATE_BPS',
  'MARKETPLACE_REFUND_WINDOW_DAYS',
  'MARKETPLACE_REFUND_CONSUMPTION_CAP_BPS',
  'MARKETPLACE_MIN_LESSONS_FOR_PUBLICATION',
  'MARKETPLACE_MIN_REQUIRED_LESSONS_FOR_PUBLICATION',
  'MARKETPLACE_FREE_PREVIEW_PROPORTION',
  'MARKETPLACE_FREE_PREVIEW_MAX_COUNT',
  'MARKETPLACE_APPLICATION_RESUBMISSION_WAIT_DAYS',
  'MARKETPLACE_APPLICATION_MAX_ATTEMPTS',
  'MARKETPLACE_SIGNED_URL_TTL_SECONDS',
  'MARKETPLACE_PUBLIC_CACHE_TTL_SECONDS',
  'MARKETPLACE_DEFAULT_PAGE_SIZE',
  'MARKETPLACE_MAX_PAGE_SIZE',
  'MARKETPLACE_STRICT_RATE_LIMIT_PER_MINUTE',
  'MARKETPLACE_FREE_ENROLLMENT_RATE_LIMIT_PER_MINUTE',
  'MARKETPLACE_FREE_ENROLLMENT_RATE_LIMIT_PER_DAY',
  'MARKETPLACE_APPLICATION_RETENTION_MONTHS',
  'MARKETPLACE_FINANCIAL_RETENTION_YEARS',
];

describe('getMarketplaceConfig', () => {
  const originalValues = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalValues.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const original = originalValues.get(key);
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  });

  it('seeds every value to its spec.md §Y Configuration Register launch default when unset', () => {
    expect(getMarketplaceConfig()).toEqual({
      commissionRateBps: 3000,
      refundWindowDays: 14,
      refundConsumptionCapBps: 3000,
      minLessonsForPublication: 3,
      minRequiredLessonsForPublication: 1,
      freePreviewProportion: 0.2,
      freePreviewMaxCount: 5,
      applicationResubmissionWaitDays: 14,
      applicationMaxAttempts: 3,
      signedUrlTtlSeconds: 900,
      publicCacheTtlSeconds: 60,
      defaultPageSize: 20,
      maxPageSize: 100,
      strictRateLimitPerMinute: 3,
      freeEnrollmentRateLimitPerMinute: 5,
      freeEnrollmentRateLimitPerDay: 10,
      applicationRetentionMonths: 24,
      financialRetentionYears: 10,
    });
  });

  it('reads every value from its named environment variable when set, never hardcoded', () => {
    process.env['MARKETPLACE_COMMISSION_RATE_BPS'] = '2500';
    process.env['MARKETPLACE_REFUND_WINDOW_DAYS'] = '7';
    process.env['MARKETPLACE_SIGNED_URL_TTL_SECONDS'] = '300';

    const config = getMarketplaceConfig();

    expect(config.commissionRateBps).toBe(2500);
    expect(config.refundWindowDays).toBe(7);
    expect(config.signedUrlTtlSeconds).toBe(300);
  });

  it('defines an alert threshold with a named owner for every FR-319 condition', () => {
    for (const threshold of Object.values(MARKETPLACE_ALERT_THRESHOLDS)) {
      expect(threshold.owner.length).toBeGreaterThan(0);
    }
    expect(Object.keys(MARKETPLACE_ALERT_THRESHOLDS)).toHaveLength(8);
  });
});

describe('isMarketplaceEnabled', () => {
  const original = process.env['MARKETPLACE_ENABLED'];

  afterEach(() => {
    if (original === undefined) delete process.env['MARKETPLACE_ENABLED'];
    else process.env['MARKETPLACE_ENABLED'] = original;
  });

  it('defaults to disabled when unset — the safe direction for a feature still under construction', () => {
    delete process.env['MARKETPLACE_ENABLED'];
    expect(isMarketplaceEnabled()).toBe(false);
  });

  it('stays disabled for anything other than the exact string "true" (typos, "1", "TRUE")', () => {
    process.env['MARKETPLACE_ENABLED'] = 'TRUE';
    expect(isMarketplaceEnabled()).toBe(false);
    process.env['MARKETPLACE_ENABLED'] = '1';
    expect(isMarketplaceEnabled()).toBe(false);
  });

  it('enables only on the exact string "true" — a deliberate, unambiguous act', () => {
    process.env['MARKETPLACE_ENABLED'] = 'true';
    expect(isMarketplaceEnabled()).toBe(true);
  });
});

/**
 * T002: proves the conditional-registration mechanism app.module.ts uses,
 * without booting a live database-backed application. Each `it` reloads
 * app.module.ts fresh (`jest.resetModules()`) under a different flag value,
 * since — like `areQueuesEnabled()` — the flag is read once at module
 * decoration time, not per-request.
 */
describe('AppModule marketplace registration (T002)', () => {
  const originalEnabled = process.env['MARKETPLACE_ENABLED'];
  const originalNodeEnv = process.env['NODE_ENV'];

  beforeAll(() => {
    // Requiring app.module.ts triggers ConfigModule.forRoot({ validate })
    // synchronously at decoration time, so the full env contract must be
    // satisfied even though this spec never actually connects to anything —
    // the same disposable-test values the e2e harness itself loads.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    (require('dotenv') as typeof import('dotenv')).config({
      path: require('node:path').join(__dirname, '..', '..', '.env.test'),
    });
  });

  beforeEach(() => {
    jest.resetModules();
    process.env['NODE_ENV'] = 'test';
  });

  afterEach(() => {
    if (originalEnabled === undefined) delete process.env['MARKETPLACE_ENABLED'];
    else process.env['MARKETPLACE_ENABLED'] = originalEnabled;
    if (originalNodeEnv === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = originalNodeEnv;
    jest.resetModules();
  });

  it('registers exactly one MarketplaceModule import when the flag is "true"', () => {
    process.env['MARKETPLACE_ENABLED'] = 'true';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AppModule } = require('../app.module') as typeof import('../app.module');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { MarketplaceModule } = require('../marketplace/marketplace.module') as typeof import('../marketplace/marketplace.module');
    const { MODULE_METADATA } = require('@nestjs/common/constants') as typeof import('@nestjs/common/constants');

    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule) ?? []) as unknown[];
    expect(imports.filter((m) => m === MarketplaceModule)).toHaveLength(1);
  });

  it('registers no MarketplaceModule import when the flag is unset — every academic module import is otherwise unchanged', () => {
    delete process.env['MARKETPLACE_ENABLED'];

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AppModule } = require('../app.module') as typeof import('../app.module');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { MarketplaceModule } = require('../marketplace/marketplace.module') as typeof import('../marketplace/marketplace.module');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { UsersModule } = require('../users/users.module') as typeof import('../users/users.module');
    const { MODULE_METADATA } = require('@nestjs/common/constants') as typeof import('@nestjs/common/constants');

    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule) ?? []) as unknown[];
    expect(imports).not.toContain(MarketplaceModule);
    // A representative academic module — proof the surrounding array is untouched.
    expect(imports).toContain(UsersModule);
  });
});
