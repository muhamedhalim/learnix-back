import 'reflect-metadata';

import { Controller, Get, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { validate } from './config/env.validation';
import { EnvironmentIsolationError } from './config/environment-isolation.guard';

/**
 * Integration test — proves the application refuses to boot, not merely that
 * a function throws in isolation.
 *
 * WHY A REAL `NestFactory.create()` CALL, NOT A UNIT TEST OF `validate()`
 * -----------------------------------------------------------------------
 * `environment-isolation.guard.spec.ts` and `env.validation.spec.ts` already
 * prove `validate()` throws on a bad config, called directly as a function.
 * That is necessary but not sufficient: it doesn't prove Nest actually WIRES
 * that function into the real boot path, or that a thrown error there
 * actually stops `NestFactory.create()` from producing an application. A
 * refactor that silently stopped passing `validate` to `ConfigModule.forRoot`
 * would leave every one of those unit tests green while the real
 * application booted normally with a production database configured on
 * staging. This test would catch that: it exercises the ACTUAL mechanism
 * `main.ts` and `app.module.ts` use in production.
 *
 * `@nestjs/config`'s `ConfigModule.forRoot()` is an `async` static method
 * (verified against the installed package,
 * node_modules/@nestjs/config/dist/config.module.js) that calls
 * `options.validate(config)` synchronously in its body, before any `await`.
 * Because `forRoot()` is itself async, a synchronous throw inside it becomes a
 * REJECTED PROMISE, not a synchronous exception at the `@Module({ imports })`
 * call site. NestJS supports `Promise<DynamicModule>` entries in `imports`
 * precisely for cases like this, and resolves them during
 * `NestFactory.create()`'s module-compilation phase — which is exactly where
 * these tests observe the rejection surface.
 *
 * WHAT "NestFactory never starts" MEANS HERE, PRECISELY
 * ------------------------------------------------------
 * `await NestFactory.create(Module)` REJECTS. No `INestApplication` is ever
 * returned. Since `app.listen()` can only be called on the object `create()`
 * would have returned, and no such object exists, the HTTP server can never
 * open a port. There is no `app` reference in any of these tests after the
 * `try` block — that absence is the proof.
 *
 * A FINDING THIS TEST SURFACED: REAL PRODUCTION BEHAVIOUR IS STRONGER STILL.
 * ---------------------------------------------------------------------------
 * `NestFactory.create()`'s `abortOnError` option defaults to `true`
 * (node_modules/@nestjs/core/nest-factory.js). On a bootstrap failure with the
 * default, Nest does not reject the promise at all — it logs the error and
 * calls `process.exit(1)` directly (`ExceptionsZone`'s default teardown).
 * `main.ts`'s real `bootstrap()` never overrides this. So the ACTUAL
 * production/staging behaviour on an isolation violation is not merely "the
 * app object is never returned" — it is "the OS process terminates outright,
 * before a single byte of application code beyond validate() has run."
 * `abortOnError: false` is passed below ONLY so Jest can observe and assert
 * the underlying rejection instead of the test worker being killed; it is not
 * how the real deployment boots.
 */
describe('bootstrap refuses to start on an environment isolation violation', () => {
  /**
   * A minimal module using the EXACT SAME `ConfigModule.forRoot({ validate })`
   * call as `app.module.ts` — no feature modules, no database, no Redis. This
   * isolates the assertion to the precise mechanism under test (does Nest's
   * boot path actually enforce `validate()`?) without dragging in every other
   * module's own failure modes (unreachable DB, unset storage credentials,
   * etc.), which would make a failure ambiguous about its cause.
   */
  function buildIsolatedTestModule(): typeof TestAppModule {
    @Controller()
    class PingController {
      @Get()
      public ping(): string {
        return 'ok';
      }
    }

    @Module({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true, // exercise only the explicit `config` below
          validate,
        }),
      ],
      controllers: [PingController],
    })
    class TestAppModule {}

    return TestAppModule;
  }

  /** A staging config that is valid in every respect except the one violation under test. */
  function validStagingConfig(overrides: Record<string, string>): void {
    const base: Record<string, string> = {
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
      PAYMENT_CAPTURE_GRACE_SECONDS: '300',
      PAYMENT_PROVIDER_CLOCK_SKEW_SECONDS: '120',
    };
    for (const [key, value] of Object.entries({ ...base, ...overrides })) {
      process.env[key] = value;
    }
  }

  const managedKeys = [
    'NODE_ENV',
    'APP_ENV',
    'DATABASE_URL',
    'REDIS_URL',
    'JWT_SECRET',
    'JWT_REFRESH_SECRET',
    'COOKIE_SECRET',
    'FRONTEND_URL',
    'BACKEND_URL',
    'PUBLIC_MEDIA_BASE_URL',
    'CORS_ORIGINS',
    'R2_BUCKET',
    'PAYMENT_CAPTURE_GRACE_SECONDS',
    'PAYMENT_PROVIDER_CLOCK_SKEW_SECONDS',
    'PROD_HOST_DENYLIST',
    'EASYKASH_API_KEY',
    'EASYKASH_HMAC_SECRET',
  ];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of managedKeys) savedEnv[key] = process.env[key];
  });

  afterEach(() => {
    for (const key of managedKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('rejects NestFactory.create() when a production database URL is configured on staging', async () => {
    validStagingConfig({
      PROD_HOST_DENYLIST: 'prod-db.internal.test',
      DATABASE_URL: 'postgresql://user:pass@prod-db.internal.test:5432/learnix_staging',
    });

    let app: import('@nestjs/common').INestApplication | undefined;
    let caught: unknown;
    try {
      app = await NestFactory.create(buildIsolatedTestModule(), {
        logger: false,
        abortOnError: false,
      });
    } catch (error) {
      caught = error;
    }

    // The proof: no application instance exists.
    expect(app).toBeUndefined();
    expect(caught).toBeInstanceOf(EnvironmentIsolationError);
    expect((caught as EnvironmentIsolationError).violations.map((v) => v.code)).toContain(
      'STAGING_PRODUCTION_DATABASE_HOST',
    );

    // A correctly-refused boot never has a running server to close, but if a
    // reference were ever accidentally captured above, prove it cannot serve.
    if (app !== undefined) {
      await (app as import('@nestjs/common').INestApplication).close();
      throw new Error('app should never have been constructed');
    }
  });

  it('rejects EasyKash credentials on staging', async () => {
    validStagingConfig({
      EASYKASH_API_KEY: 'live-key',
      EASYKASH_HMAC_SECRET: 'live-secret',
    });

    let app: import('@nestjs/common').INestApplication | undefined;
    let caught: unknown;
    try {
      app = await NestFactory.create(buildIsolatedTestModule(), {
        logger: false,
        abortOnError: false,
      });
    } catch (error) {
      caught = error;
    }

    expect(app).toBeUndefined();
    expect(caught).toBeInstanceOf(EnvironmentIsolationError);
    expect((caught as EnvironmentIsolationError).violations.map((v) => v.code)).toContain(
      'STAGING_PAYMENT_CREDENTIALS_SET',
    );
  });

  it('rejects when a production storage bucket is configured on staging', async () => {
    validStagingConfig({ R2_BUCKET: 'learnix' });

    let app: import('@nestjs/common').INestApplication | undefined;
    let caught: unknown;
    try {
      app = await NestFactory.create(buildIsolatedTestModule(), {
        logger: false,
        abortOnError: false,
      });
    } catch (error) {
      caught = error;
    }

    expect(app).toBeUndefined();
    expect(caught).toBeInstanceOf(EnvironmentIsolationError);
    expect((caught as EnvironmentIsolationError).violations.map((v) => v.code)).toContain(
      'STAGING_PRODUCTION_STORAGE_BUCKET',
    );
  });

  it('CONTROL: boots successfully when the same staging config has no violation', async () => {
    // Proves the previous three tests fail for the SPECIFIC reason claimed,
    // not because staging can never boot at all under this harness.
    validStagingConfig({});

    const app = await NestFactory.create(buildIsolatedTestModule(), {
      logger: false,
      abortOnError: false,
    });
    try {
      expect(app).toBeDefined();
      await app.init();
    } finally {
      await app.close();
    }
  });

  it('CONTROL: the real production configuration (APP_ENV unset) still boots', async () => {
    // The isolation guard's mirror rules must not accidentally block a
    // legitimate production boot. See environment-isolation.guard.spec.ts for
    // the exhaustive version; this is the NestFactory-level confirmation.
    process.env['NODE_ENV'] = 'production';
    delete process.env['APP_ENV'];
    process.env['DATABASE_URL'] = 'postgresql://user:pass@prod-db.internal.test:5432/railway';
    process.env['REDIS_URL'] = 'redis://redis.railway.internal:6379';
    process.env['JWT_SECRET'] = 'p'.repeat(32);
    process.env['JWT_REFRESH_SECRET'] = 'q'.repeat(32);
    process.env['COOKIE_SECRET'] = 'r'.repeat(32);
    process.env['FRONTEND_URL'] = 'https://learnix.school';
    process.env['BACKEND_URL'] = 'https://learning-center-backend-production.up.railway.app';
    process.env['PUBLIC_MEDIA_BASE_URL'] =
      'https://learning-center-backend-production.up.railway.app';
    process.env['CORS_ORIGINS'] = 'https://learnix.school';
    process.env['R2_BUCKET'] = 'learnix';
    process.env['PAYMENT_CAPTURE_GRACE_SECONDS'] = '300';
    process.env['PAYMENT_PROVIDER_CLOCK_SKEW_SECONDS'] = '120';

    const app = await NestFactory.create(buildIsolatedTestModule(), {
      logger: false,
      abortOnError: false,
    });
    try {
      expect(app).toBeDefined();
    } finally {
      await app.close();
    }
  });
});

/**
 * End-to-end confirmation using the LITERAL production `AppModule` — every
 * feature module (Payments, Books, Exams, Lessons, Guardians, Queues, ~30 in
 * total), not a minimal stand-in. This is the strongest form of the proof: it
 * demonstrates the isolation guard blocks the exact class `main.ts` passes to
 * `NestFactory.create()` in every real deployment.
 *
 * `require` (not `import`) is used deliberately: `AppModule`'s `@Module()`
 * decorator — and therefore its `ConfigModule.forRoot({ validate })` call —
 * must not evaluate until AFTER this test has set `process.env` for the
 * scenario under test. A static top-level `import` would run at file-load
 * time, before that setup exists.
 *
 * This full graph completes (rejects) in single-digit seconds with NO
 * database, Redis, or storage credentials ever reachable — direct evidence
 * that no other module's factory (TypeORM's connection, BullMQ's Redis
 * client, R2's S3Client, etc.) ever attempted to run. If the isolation check
 * were bypassed, this same test would instead hang or throw a connection
 * timeout from one of those factories, not an `EnvironmentIsolationError`.
 */
describe('the real AppModule refuses to boot on an environment isolation violation', () => {
  const managedKeys = [
    'NODE_ENV',
    'APP_ENV',
    'DATABASE_URL',
    'PROD_HOST_DENYLIST',
    'REDIS_URL',
    'JWT_SECRET',
    'JWT_REFRESH_SECRET',
    'COOKIE_SECRET',
    'FRONTEND_URL',
    'BACKEND_URL',
    'PUBLIC_MEDIA_BASE_URL',
    'CORS_ORIGINS',
    'R2_BUCKET',
    'R2_PUBLIC_BASE_URL',
    'PAYMENT_CAPTURE_GRACE_SECONDS',
    'PAYMENT_PROVIDER_CLOCK_SKEW_SECONDS',
    'METRICS_BEARER_TOKEN',
    'BULL_BOARD_USER',
    'BULL_BOARD_PASSWORD',
  ];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of managedKeys) savedEnv[key] = process.env[key];
  });

  afterEach(() => {
    for (const key of managedKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    jest.resetModules();
  });

  it('never returns an application, and the specific violation is present among the reasons', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['APP_ENV'] = 'staging';
    process.env['DATABASE_URL'] =
      'postgresql://user:pass@prod-db.internal.test:5432/learnix_staging';
    process.env['PROD_HOST_DENYLIST'] = 'prod-db.internal.test';
    process.env['REDIS_URL'] = 'redis://staging-redis.internal.test:6379';
    process.env['JWT_SECRET'] = 's'.repeat(32);
    process.env['JWT_REFRESH_SECRET'] = 't'.repeat(32);
    process.env['COOKIE_SECRET'] = 'u'.repeat(32);
    process.env['FRONTEND_URL'] = 'https://staging.learnix.school';
    process.env['BACKEND_URL'] = 'https://api-staging.learnix.school';
    process.env['PUBLIC_MEDIA_BASE_URL'] = 'https://api-staging.learnix.school';
    process.env['CORS_ORIGINS'] = 'https://staging.learnix.school';
    process.env['R2_BUCKET'] = 'learnix-staging';
    process.env['PAYMENT_CAPTURE_GRACE_SECONDS'] = '300';
    process.env['PAYMENT_PROVIDER_CLOCK_SKEW_SECONDS'] = '120';
    process.env['METRICS_BEARER_TOKEN'] = 'x'.repeat(20);
    process.env['BULL_BOARD_USER'] = 'admin';
    process.env['BULL_BOARD_PASSWORD'] = 'y'.repeat(20);
    // A developer's local, gitignored .env (see docs/SECRET_ROTATION_CHECKLIST.md
    // finding A-09) can set this to a value CI never will. Neutralising it here
    // keeps this assertion about the DATABASE_URL violation specifically, on
    // every machine this test runs on — see the empty-string note below.
    //
    // Set to '', not deleted: ConfigModule.forRoot's loadEnvFile still reads
    // `.env` from disk and would re-populate a DELETED key from that file, but
    // treats an already-present (even empty) key as already defined and skips
    // it. An empty string also short-circuits the value's own validation in
    // public-url.util.ts.
    process.env['R2_PUBLIC_BASE_URL'] = '';

    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- see doc comment above
    const { AppModule } = require('./app.module') as typeof import('./app.module');
    // Re-required from the SAME fresh module registry as AppModule.
    // jest.resetModules() gives that registry its own copy of every module,
    // including this error class — the statically-imported EnvironmentIsolationError
    // at the top of this file is a DIFFERENT class object (same name and shape,
    // different identity) after a reset, so `instanceof` against it would fail
    // even on a correct rejection. This is a Jest module-registry artefact, not
    // a real behavioural difference — production only ever has one registry.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- see above
    const { EnvironmentIsolationError: FreshEnvironmentIsolationError } =
      require('./config/environment-isolation.guard') as typeof import('./config/environment-isolation.guard');

    let app: import('@nestjs/common').INestApplication | undefined;
    let caught: unknown;
    try {
      app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    } catch (error) {
      caught = error;
    }

    expect(app).toBeUndefined();
    expect(caught).toBeInstanceOf(FreshEnvironmentIsolationError);
    expect(
      (caught as InstanceType<typeof FreshEnvironmentIsolationError>).violations.map((v) => v.code),
    ).toContain('STAGING_PRODUCTION_DATABASE_HOST');
  }, 30_000);
});
