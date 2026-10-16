import 'reflect-metadata';

import {
  AppEnvironment,
  MissingAppEnvError,
  recordReader,
  resolveAppEnv,
  UnsupportedAppEnvError,
} from './app-env';
import { validate } from './env.validation';
import {
  assertEnvironmentIsolation,
  assertTestDatabaseIsSafe,
  EnvironmentIsolationError,
  fingerprint,
  UnsafeTestDatabaseError,
} from './environment-isolation.guard';

/**
 * A correctly-isolated staging deployment.
 *
 * NODE_ENV is `production` on purpose: staging needs every protection that flag
 * turns on (mandatory Redis, mandatory object storage, CSP, hidden stack
 * traces, secure cookies). `APP_ENV=staging` supplies the identity that
 * NODE_ENV can no longer express. See `app-env.ts`.
 */
const stagingConfig: Record<string, unknown> = {
  NODE_ENV: 'production',
  APP_ENV: 'staging',
  DATABASE_URL: 'postgresql://user:pass@staging-db.internal.test:5432/learnix_staging',
  REDIS_URL: 'redis://staging-redis.internal.test:6379',
  JWT_SECRET: 's'.repeat(32),
  JWT_REFRESH_SECRET: 't'.repeat(32),
  COOKIE_SECRET: 'u'.repeat(32),
  FRONTEND_URL: 'https://staging.learnix.school',
  BACKEND_URL: 'https://api-staging.learnix.school',
  PUBLIC_MEDIA_BASE_URL: 'https://api-staging.learnix.school',
  CORS_ORIGINS: 'https://staging.learnix.school',
  R2_BUCKET: 'learnix-staging',
  MAIL_PROVIDER: 'mailersend',
  MAILERSEND_API_KEY: 'staging-mail-key',
  MAIL_FROM_EMAIL: 'staging@staging.learnix.school',
  MAIL_ALLOWLIST: 'qa@staging.learnix.invalid',
  PAYMENT_CAPTURE_GRACE_SECONDS: '300',
  PAYMENT_PROVIDER_CLOCK_SKEW_SECONDS: '120',
};

/** The production deployment as it is configured today. */
const productionConfig: Record<string, unknown> = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://user:pass@prod-db.internal.test:5432/railway',
  REDIS_URL: 'redis://redis.railway.internal:6379',
  JWT_SECRET: 'p'.repeat(32),
  JWT_REFRESH_SECRET: 'q'.repeat(32),
  COOKIE_SECRET: 'r'.repeat(32),
  FRONTEND_URL: 'https://learnix.school',
  BACKEND_URL: 'https://learning-center-backend-production.up.railway.app',
  PUBLIC_MEDIA_BASE_URL: 'https://learning-center-backend-production.up.railway.app',
  CORS_ORIGINS: 'https://learnix.school',
  R2_BUCKET: 'learnix',
  EASYKASH_API_KEY: 'live-key',
  EASYKASH_HMAC_SECRET: 'live-hmac-secret',
  MAIL_PROVIDER: 'mailersend',
  MAILERSEND_API_KEY: 'prod-mail-key',
  MAIL_FROM_EMAIL: 'info@learnix.school',
  PAYMENT_CAPTURE_GRACE_SECONDS: '300',
  PAYMENT_PROVIDER_CLOCK_SKEW_SECONDS: '120',
};

function guard(config: Record<string, unknown>): void {
  const read = recordReader(config);
  assertEnvironmentIsolation(resolveAppEnv(read), read);
}

/** Violation codes raised by a config, for precise assertions. */
function codesFor(config: Record<string, unknown>): string[] {
  try {
    guard(config);
  } catch (error) {
    if (error instanceof EnvironmentIsolationError) {
      return error.violations.map((violation) => violation.code);
    }
    throw error;
  }
  return [];
}

describe('APP_ENV resolution', () => {
  it('derives production from NODE_ENV=production when APP_ENV is absent', () => {
    expect(resolveAppEnv(recordReader({ NODE_ENV: 'production' }))).toBe(AppEnvironment.Production);
  });

  it('derives test and development from NODE_ENV', () => {
    expect(resolveAppEnv(recordReader({ NODE_ENV: 'test' }))).toBe(AppEnvironment.Test);
    expect(resolveAppEnv(recordReader({ NODE_ENV: 'development' }))).toBe(
      AppEnvironment.Development,
    );
  });

  it('derives development for an unset or unrecognised NODE_ENV, never production', () => {
    expect(resolveAppEnv(recordReader({}))).toBe(AppEnvironment.Development);
    expect(resolveAppEnv(recordReader({ NODE_ENV: 'prod' }))).toBe(AppEnvironment.Development);
  });

  it('prefers an explicit APP_ENV over the NODE_ENV derivation', () => {
    expect(resolveAppEnv(recordReader({ NODE_ENV: 'production', APP_ENV: 'staging' }))).toBe(
      AppEnvironment.Staging,
    );
  });

  it('normalises case and surrounding whitespace', () => {
    expect(resolveAppEnv(recordReader({ APP_ENV: '  STAGING  ' }))).toBe(AppEnvironment.Staging);
  });

  it('rejects an unsupported APP_ENV value', () => {
    expect(() => resolveAppEnv(recordReader({ APP_ENV: 'stage' }))).toThrow(UnsupportedAppEnvError);
    expect(() => resolveAppEnv(recordReader({ APP_ENV: 'stage' }))).toThrow(/must be one of/i);
  });

  it('requires an explicit APP_ENV when APP_ENV_STRICT=true', () => {
    expect(() =>
      resolveAppEnv(recordReader({ NODE_ENV: 'production', APP_ENV_STRICT: 'true' })),
    ).toThrow(MissingAppEnvError);
  });
});

describe('staging isolation — accepted configuration', () => {
  it('starts successfully when every resource is staging-owned', () => {
    expect(() => guard(stagingConfig)).not.toThrow();
  });

  it('passes full environment validation, not just the isolation rules', () => {
    expect(() => validate(stagingConfig)).not.toThrow();
  });
});

describe('staging isolation — production database', () => {
  it('fails when DATABASE_URL points at a production host', () => {
    const config = {
      ...stagingConfig,
      DATABASE_URL:
        'postgresql://u:p@learning-center-backend-production.up.railway.app:5432/learnix_staging',
    };
    expect(() => guard(config)).toThrow(EnvironmentIsolationError);
    expect(codesFor(config)).toContain('STAGING_PRODUCTION_DATABASE_HOST');
  });

  it('fails when the database NAME is the production one, even on a benign host', () => {
    const config = {
      ...stagingConfig,
      DATABASE_URL: 'postgresql://u:p@some-db.internal.test:5432/learnix',
    };
    expect(codesFor(config)).toContain('STAGING_PRODUCTION_DATABASE_NAME');
  });

  it('fails when the database name does not identify itself as staging', () => {
    const config = {
      ...stagingConfig,
      DATABASE_URL: 'postgresql://u:p@some-db.internal.test:5432/app_db',
    };
    expect(codesFor(config)).toContain('STAGING_DATABASE_NAME_NOT_MARKED');
  });

  it.each(['learnix_staging', 'staging', 'lms-staging', 'learnix_stg'])(
    'accepts staging-marked database name %s',
    (name) => {
      const config = {
        ...stagingConfig,
        DATABASE_URL: `postgresql://u:p@some-db.internal.test:5432/${name}`,
      };
      expect(codesFor(config)).toHaveLength(0);
    },
  );
});

describe('staging isolation — production Redis', () => {
  it('fails when REDIS_URL points at a denylisted production host', () => {
    const config = {
      ...stagingConfig,
      PROD_HOST_DENYLIST: 'redis.railway.internal',
      REDIS_URL: 'redis://:pass@redis.railway.internal:6379',
    };
    expect(() => guard(config)).toThrow(EnvironmentIsolationError);
    expect(codesFor(config)).toContain('STAGING_PRODUCTION_REDIS_HOST');
  });

  it('fails when the bare REDIS_HOST form points at production', () => {
    const config = {
      ...stagingConfig,
      PROD_HOST_DENYLIST: 'redis.railway.internal',
      REDIS_URL: undefined,
      REDIS_HOST: 'redis.railway.internal',
    };
    expect(codesFor(config)).toContain('STAGING_PRODUCTION_REDIS_HOST');
  });

  it('fails when a supplied Redis namespace is not staging-marked', () => {
    expect(codesFor({ ...stagingConfig, REDIS_NAMESPACE: 'prod' })).toContain(
      'STAGING_REDIS_NAMESPACE_NOT_MARKED',
    );
  });
});

describe('staging isolation — production storage', () => {
  it('fails when R2_BUCKET is the production bucket', () => {
    const config = { ...stagingConfig, R2_BUCKET: 'learnix' };
    expect(() => guard(config)).toThrow(EnvironmentIsolationError);
    expect(codesFor(config)).toContain('STAGING_PRODUCTION_STORAGE_BUCKET');
  });

  it('fails when the bucket name does not identify itself as staging', () => {
    expect(codesFor({ ...stagingConfig, R2_BUCKET: 'media-assets' })).toContain(
      'STAGING_STORAGE_BUCKET_NOT_MARKED',
    );
  });

  it('fails when R2_PUBLIC_BASE_URL is set, mirroring the production rule', () => {
    const config = {
      ...stagingConfig,
      R2_PUBLIC_BASE_URL: 'https://example.r2.cloudflarestorage.com/learnix-staging',
    };
    expect(codesFor(config)).toContain('STAGING_R2_PUBLIC_BASE_URL_SET');
  });

  it('fails when R2_ACCOUNT_ID is the production account, even with a correctly-named bucket', () => {
    const config = {
      ...stagingConfig,
      PROD_IDENTIFIER_DENYLIST: 'prod-cf-account-id',
      R2_ACCOUNT_ID: 'prod-cf-account-id',
    };
    expect(codesFor(config)).toContain('STAGING_PRODUCTION_R2_ACCOUNT');
  });

  it('does not flag R2_ACCOUNT_ID when it is absent (Phase 2 configs never set it)', () => {
    expect(codesFor(stagingConfig)).toHaveLength(0);
  });
});

describe('staging isolation — production payment credentials', () => {
  // EasyKash documents no sandbox, so any credential on staging could move real money.
  it.each(['EASYKASH_API_KEY', 'EASYKASH_HMAC_SECRET'])(
    'fails when %s is set on staging',
    (variable) => {
      const config = { ...stagingConfig, [variable]: 'any-value' };
      expect(() => guard(config)).toThrow(EnvironmentIsolationError);
      expect(codesFor(config)).toContain('STAGING_PAYMENT_CREDENTIALS_SET');
    },
  );

  it('does not flag an unconfigured gateway', () => {
    expect(codesFor(stagingConfig)).toHaveLength(0);
  });

  it('fails when a production payment secret is reused, detected by fingerprint', () => {
    const productionApiKey = 'the-real-live-easykash-key';
    const config = {
      ...stagingConfig,
      EASYKASH_API_KEY: productionApiKey,
      PROD_SECRET_FINGERPRINTS: fingerprint(productionApiKey),
    };
    expect(() => guard(config)).toThrow(EnvironmentIsolationError);
    expect(codesFor(config)).toContain('STAGING_PRODUCTION_SECRET_REUSED');
  });

  it('never puts the secret value into the error message', () => {
    const productionApiKey = 'the-real-live-easykash-key';
    const config = {
      ...stagingConfig,
      EASYKASH_API_KEY: productionApiKey,
      PROD_SECRET_FINGERPRINTS: fingerprint(productionApiKey),
    };
    try {
      guard(config);
      throw new Error('expected the guard to throw');
    } catch (error) {
      expect((error as Error).message).not.toContain(productionApiKey);
      expect((error as Error).message).toContain('EASYKASH_API_KEY');
    }
  });
});

describe('staging isolation — production webhook secrets', () => {
  it.each(['EASYKASH_HMAC_SECRET', 'META_WHATSAPP_APP_SECRET'])(
    'fails when %s matches a production fingerprint',
    (variable) => {
      const secret = `production-${variable}`;
      const config = {
        ...stagingConfig,
        [variable]: secret,
        PROD_SECRET_FINGERPRINTS: fingerprint(secret),
      };
      expect(codesFor(config)).toContain('STAGING_PRODUCTION_SECRET_REUSED');
    },
  );

  it.each([
    'JWT_SECRET',
    'JWT_REFRESH_SECRET',
    'COOKIE_SECRET',
    'MAILERSEND_API_KEY',
    'R2_SECRET_ACCESS_KEY',
    'TWILIO_AUTH_TOKEN',
  ])('fails when the production %s is reused on staging', (variable) => {
    const secret = `production-value-for-${variable}-padded-to-length`;
    const config = {
      ...stagingConfig,
      [variable]: secret,
      PROD_SECRET_FINGERPRINTS: fingerprint(secret),
    };
    expect(codesFor(config)).toContain('STAGING_PRODUCTION_SECRET_REUSED');
  });
});

describe('staging isolation — production origins and cookies', () => {
  it.each(['FRONTEND_URL', 'BACKEND_URL', 'PUBLIC_MEDIA_BASE_URL'])(
    'fails when %s is a production origin',
    (variable) => {
      const config = { ...stagingConfig, [variable]: 'https://learnix.school' };
      expect(codesFor(config)).toContain('STAGING_PRODUCTION_ORIGIN');
    },
  );

  it('fails when CORS_ORIGINS admits the production frontend', () => {
    const config = {
      ...stagingConfig,
      CORS_ORIGINS: 'https://staging.learnix.school,https://learnix.school',
    };
    expect(codesFor(config)).toContain('STAGING_PRODUCTION_CORS_ORIGIN');
  });

  it('treats staging subdomains as distinct hosts, not as the production domain', () => {
    expect(codesFor(stagingConfig)).toHaveLength(0);
  });

  it('fails when COOKIE_DOMAIN would be shared with production', () => {
    const config = { ...stagingConfig, COOKIE_DOMAIN: '.learnix.school' };
    expect(codesFor(config)).toContain('STAGING_PRODUCTION_COOKIE_DOMAIN');
  });

  it('accepts an absent COOKIE_DOMAIN, which is how this codebase behaves', () => {
    expect(codesFor({ ...stagingConfig, COOKIE_DOMAIN: undefined })).toHaveLength(0);
  });
});

describe('staging isolation — email and SMS', () => {
  it('fails when MailerSend is configured without a recipient allowlist', () => {
    const config = { ...stagingConfig, MAIL_ALLOWLIST: undefined };
    expect(codesFor(config)).toContain('STAGING_MAIL_ALLOWLIST_MISSING');
  });

  it('fails when staging sends from a production address', () => {
    const config = { ...stagingConfig, MAIL_FROM_EMAIL: 'info@learnix.school' };
    expect(codesFor(config)).toContain('STAGING_PRODUCTION_MAIL_SENDER');
  });

  it('fails when SMS credentials are present without sandbox mode', () => {
    const config = { ...stagingConfig, TWILIO_AUTH_TOKEN: 'staging-token' };
    expect(codesFor(config)).toContain('STAGING_SMS_MODE_NOT_SANDBOX');
  });

  it('accepts SMS credentials in sandbox mode', () => {
    const config = {
      ...stagingConfig,
      TWILIO_AUTH_TOKEN: 'staging-token',
      SMS_MODE: 'sandbox',
    };
    expect(codesFor(config)).toHaveLength(0);
  });

  it('does not demand an allowlist when mail is not configured at all', () => {
    const config = {
      ...stagingConfig,
      MAILERSEND_API_KEY: undefined,
      MAIL_ALLOWLIST: undefined,
      MAIL_FROM_EMAIL: undefined,
    };
    expect(codesFor(config)).toHaveLength(0);
  });
});

describe('Phase 3 — WhatsApp and Firebase resource identifiers', () => {
  it('fails when META_WHATSAPP_PHONE_NUMBER_ID is the production phone number', () => {
    const config = {
      ...stagingConfig,
      PROD_IDENTIFIER_DENYLIST: 'prod-phone-number-id',
      META_WHATSAPP_PHONE_NUMBER_ID: 'prod-phone-number-id',
    };
    expect(codesFor(config)).toContain('STAGING_PRODUCTION_WHATSAPP_NUMBER');
  });

  it('fails when FIREBASE_PROJECT_ID is the production project', () => {
    const config = {
      ...stagingConfig,
      PROD_IDENTIFIER_DENYLIST: 'learnix-prod',
      FIREBASE_PROJECT_ID: 'learnix-prod',
    };
    expect(codesFor(config)).toContain('STAGING_PRODUCTION_FIREBASE_PROJECT');
  });

  it('does not flag either identifier when absent', () => {
    expect(codesFor(stagingConfig)).toHaveLength(0);
  });
});

describe('staging isolation — reporting', () => {
  it('reports every violation at once rather than only the first', () => {
    const config = {
      ...stagingConfig,
      DATABASE_URL: 'postgresql://u:p@some-db.internal.test:5432/learnix',
      R2_BUCKET: 'learnix',
      EASYKASH_API_KEY: 'live-key',
      MAIL_FROM_EMAIL: 'info@learnix.school',
    };
    const codes = codesFor(config);
    expect(codes).toEqual(
      expect.arrayContaining([
        'STAGING_PRODUCTION_DATABASE_NAME',
        'STAGING_PRODUCTION_STORAGE_BUCKET',
        'STAGING_PAYMENT_CREDENTIALS_SET',
        'STAGING_PRODUCTION_MAIL_SENDER',
      ]),
    );
    expect(codes.length).toBeGreaterThanOrEqual(4);
  });

  it('labels each violation with the rule class that caught it', () => {
    try {
      guard({ ...stagingConfig, R2_BUCKET: 'learnix' });
      throw new Error('expected the guard to throw');
    } catch (error) {
      const violations = (error as EnvironmentIsolationError).violations;
      expect(violations.some((violation) => violation.rule === 'identifier-denylist')).toBe(true);
    }
  });
});

describe('production is unaffected', () => {
  it('boots with the current production configuration', () => {
    expect(() => guard(productionConfig)).not.toThrow();
  });

  it('passes full environment validation unchanged', () => {
    expect(() => validate(productionConfig)).not.toThrow();
  });

  it('applies the production rules when APP_ENV is explicitly production', () => {
    expect(() => guard({ ...productionConfig, APP_ENV: 'production' })).not.toThrow();
  });

  it('rejects a staging-only mail allowlist reaching production', () => {
    const config = { ...productionConfig, MAIL_ALLOWLIST: 'qa@example.test' };
    expect(codesFor(config)).toContain('PRODUCTION_MAIL_ALLOWLIST_SET');
  });

  it('rejects sandbox SMS mode reaching production', () => {
    const config = { ...productionConfig, SMS_MODE: 'sandbox' };
    expect(codesFor(config)).toContain('PRODUCTION_SMS_MODE_IS_SANDBOX');
  });
});

describe('test and development environments are exempt', () => {
  it('does not apply isolation rules to the test environment', () => {
    expect(() =>
      guard({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/lms_e2e',
        R2_BUCKET: 'learnix',
      }),
    ).not.toThrow();
  });

  it('does not apply isolation rules to development', () => {
    expect(() =>
      guard({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgres://user:pass@localhost:5432/LMS',
        R2_BUCKET: 'learnix',
        MAIL_FROM_EMAIL: 'info@learnix.school',
      }),
    ).not.toThrow();
  });

  it('exempts development even when APP_ENV is stated explicitly', () => {
    expect(() =>
      guard({
        NODE_ENV: 'development',
        APP_ENV: 'development',
        R2_BUCKET: 'learnix',
      }),
    ).not.toThrow();
  });
});

describe('Phase 2 — staging database safety', () => {
  it('rejects TYPEORM_SYNCHRONIZE=true on staging even if NODE_ENV is somehow not production', () => {
    // Defence in depth: this scenario should not be reachable (staging is
    // required to run NODE_ENV=production), but the check is keyed on
    // APP_ENV specifically so it still fires if that requirement is ever
    // violated by mistake.
    const config = { ...stagingConfig, NODE_ENV: 'development', TYPEORM_SYNCHRONIZE: 'true' };
    expect(codesFor(config)).toContain('STAGING_SYNCHRONIZE_ENABLED');
  });

  it('rejects TYPEORM_SYNCHRONIZE=true on staging under the normal NODE_ENV=production setup too', () => {
    const config = { ...stagingConfig, TYPEORM_SYNCHRONIZE: 'true' };
    expect(codesFor(config)).toContain('STAGING_SYNCHRONIZE_ENABLED');
  });

  it('accepts the correctly-isolated staging configuration unchanged', () => {
    expect(() => guard(stagingConfig)).not.toThrow();
  });
});

describe('Phase 2 — production mirror: staging-shaped database/Redis resources', () => {
  it('rejects a production deployment pointed at a staging-named database', () => {
    const config = {
      ...productionConfig,
      DATABASE_URL: 'postgresql://user:pass@prod-db.internal.test:5432/learnix_staging',
    };
    expect(codesFor(config)).toContain('PRODUCTION_DATABASE_NAME_LOOKS_LIKE_STAGING');
  });

  it('rejects a production deployment with a staging-shaped REDIS_NAMESPACE', () => {
    const config = { ...productionConfig, REDIS_NAMESPACE: 'learnix:staging' };
    expect(codesFor(config)).toContain('PRODUCTION_REDIS_NAMESPACE_LOOKS_LIKE_STAGING');
  });

  it('accepts the current production configuration unchanged', () => {
    expect(() => guard(productionConfig)).not.toThrow();
  });
});

describe('Phase 2 — assertTestDatabaseIsSafe', () => {
  it('is a no-op outside NODE_ENV=test', () => {
    expect(() =>
      assertTestDatabaseIsSafe(
        recordReader({ NODE_ENV: 'development', DATABASE_URL: 'postgres://x@learnix.school/db' }),
      ),
    ).not.toThrow();
  });

  it('rejects a test run whose DATABASE_URL resolves to a known production host', () => {
    expect(() =>
      assertTestDatabaseIsSafe(
        recordReader({
          NODE_ENV: 'test',
          DATABASE_URL: 'postgres://user:pass@learnix.school:5432/railway',
        }),
      ),
    ).toThrow(UnsafeTestDatabaseError);
  });

  it('rejects a test run whose REDIS_URL resolves to a known production host', () => {
    expect(() =>
      assertTestDatabaseIsSafe(
        recordReader({
          NODE_ENV: 'test',
          REDIS_URL: 'redis://learning-center-backend-production.up.railway.app:6379',
        }),
      ),
    ).toThrow(UnsafeTestDatabaseError);
  });

  it('accepts the real .env.test configuration', () => {
    expect(() =>
      assertTestDatabaseIsSafe(
        recordReader({
          NODE_ENV: 'test',
          DATABASE_URL: 'postgres://postgres:lms_e2e_password@localhost:54329/lms_e2e',
          REDIS_URL: 'redis://localhost:56379/15',
        }),
      ),
    ).not.toThrow();
  });
});
