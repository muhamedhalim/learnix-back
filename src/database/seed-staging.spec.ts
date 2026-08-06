import 'reflect-metadata';

import {
  assertSafeTarget,
  assertSeedArmed,
  SeedNotArmedError,
  UnsafeSeedTargetError,
} from './seed-staging';

const stagingEnv = { NODE_ENV: 'production', APP_ENV: 'staging' };
const stagingUrl = 'postgresql://user:pass@staging-db.internal.test:5432/learnix_staging';

describe('staging seed guards — accepted target', () => {
  it('accepts a staging-marked database on a non-production host', () => {
    expect(() => assertSafeTarget(stagingEnv, stagingUrl)).not.toThrow();
  });

  it.each([
    'postgresql://u:p@db.test:5432/learnix_staging',
    'postgresql://u:p@db.test:5432/staging',
    'postgresql://u:p@db.test:5432/lms-staging',
    'postgresql://u:p@db.test:5432/learnix_stg',
  ])('accepts staging-marked database %s', (url) => {
    expect(() => assertSafeTarget(stagingEnv, url)).not.toThrow();
  });

  it('accepts a development target', () => {
    expect(() =>
      assertSafeTarget({ NODE_ENV: 'development' }, 'postgres://u:p@localhost:5432/lms_staging'),
    ).not.toThrow();
  });
});

describe('staging seed guards — guard 1: deployment identity', () => {
  it('refuses when APP_ENV is explicitly production', () => {
    expect(() =>
      assertSafeTarget({ NODE_ENV: 'production', APP_ENV: 'production' }, stagingUrl),
    ).toThrow(UnsafeSeedTargetError);
  });

  it('refuses when APP_ENV is absent and NODE_ENV is production', () => {
    // The derivation makes an unlabelled production deployment behave as
    // production, so forgetting APP_ENV cannot open a path to seeding it.
    expect(() => assertSafeTarget({ NODE_ENV: 'production' }, stagingUrl)).toThrow(
      /APP_ENV resolves to production/,
    );
  });

  it('refuses an unsupported APP_ENV rather than falling through', () => {
    expect(() => assertSafeTarget({ APP_ENV: 'stage' }, stagingUrl)).toThrow(
      /APP_ENV must be one of/,
    );
  });
});

describe('staging seed guards — guard 2: production host', () => {
  it.each([
    'learnix.school',
    'api.learnix.school',
    'learning-center-backend-production.up.railway.app',
  ])('refuses the production host %s', (host) => {
    expect(() =>
      assertSafeTarget(stagingEnv, `postgresql://u:p@${host}:5432/learnix_staging`),
    ).toThrow(/production host/);
  });

  it('refuses a host supplied through PROD_HOST_DENYLIST', () => {
    expect(() =>
      assertSafeTarget(
        { ...stagingEnv, PROD_HOST_DENYLIST: 'prod-db.internal' },
        'postgresql://u:p@prod-db.internal:5432/learnix_staging',
      ),
    ).toThrow(/production host/);
  });

  it('fires even when the database name looks correct', () => {
    // Guard independence: a correct-looking name must not rescue a bad host.
    expect(() =>
      assertSafeTarget(stagingEnv, 'postgresql://u:p@learnix.school:5432/learnix_staging'),
    ).toThrow(UnsafeSeedTargetError);
  });
});

describe('staging seed guards — guard 3: database name', () => {
  it.each(['learnix', 'railway'])('refuses the production database name %s', (name) => {
    expect(() =>
      assertSafeTarget(stagingEnv, `postgresql://u:p@safe-host.test:5432/${name}`),
    ).toThrow(/production database name/);
  });

  it('refuses a database that does not identify itself as staging', () => {
    expect(() =>
      assertSafeTarget(stagingEnv, 'postgresql://u:p@safe-host.test:5432/app_db'),
    ).toThrow(/does not identify itself as staging/);
  });

  it('fires even when APP_ENV and host are both correct', () => {
    // Guard independence in the other direction: right server, wrong database.
    expect(() =>
      assertSafeTarget(stagingEnv, 'postgresql://u:p@staging-db.internal.test:5432/production'),
    ).toThrow(UnsafeSeedTargetError);
  });
});

describe('staging seed guards — malformed input', () => {
  it('refuses a missing DATABASE_URL', () => {
    expect(() => assertSafeTarget(stagingEnv, undefined)).toThrow(/DATABASE_URL is not set/);
  });

  it('refuses an empty DATABASE_URL', () => {
    expect(() => assertSafeTarget(stagingEnv, '   ')).toThrow(/DATABASE_URL is not set/);
  });

  it('refuses an unparseable DATABASE_URL', () => {
    expect(() => assertSafeTarget(stagingEnv, 'not-a-url')).toThrow(/not a valid URL/);
  });
});

describe('staging seed guards — arming (independent of target identity)', () => {
  it('refuses to run when ALLOW_STAGING_SEED is unset, even on a verified staging target', () => {
    expect(() => assertSeedArmed({})).toThrow(SeedNotArmedError);
  });

  it('refuses any value other than the exact string "true"', () => {
    expect(() => assertSeedArmed({ ALLOW_STAGING_SEED: 'TRUE' })).toThrow(SeedNotArmedError);
    expect(() => assertSeedArmed({ ALLOW_STAGING_SEED: '1' })).toThrow(SeedNotArmedError);
    expect(() => assertSeedArmed({ ALLOW_STAGING_SEED: 'yes' })).toThrow(SeedNotArmedError);
  });

  it('allows the run once ALLOW_STAGING_SEED=true is set', () => {
    expect(() => assertSeedArmed({ ALLOW_STAGING_SEED: 'true' })).not.toThrow();
  });

  it('is independent of target-identity verification — both must pass', () => {
    // A correctly-identified staging target does not, by itself, arm the seed.
    expect(() => assertSafeTarget(stagingEnv, stagingUrl)).not.toThrow();
    expect(() => assertSeedArmed(stagingEnv)).toThrow(SeedNotArmedError);
  });
});
