import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

import cookieParser from 'cookie-parser';
import request from 'supertest';

import { API_PREFIX } from './fixtures';

/**
 * T204 (US11, release gate). `isMarketplaceEnabled()` (src/config/marketplace.config.ts)
 * gates `MarketplaceModule`'s inclusion in `AppModule`'s own static `imports`
 * array (`...(isMarketplaceEnabled() ? [MarketplaceModule] : [])`) — read
 * once, at module-class-evaluation time, from `process.env` directly (not
 * `ConfigService`), the same constraint the isolation-guard boot tests in
 * `src/bootstrap-isolation.integration.spec.ts` document and the same
 * `jest.resetModules()` + fresh `require('./app.module')` technique that
 * file already establishes for exactly this reason: a plain top-level
 * `import { AppModule }` would freeze the module's `imports` array at
 * whatever `MARKETPLACE_ENABLED` was when THIS FILE first loaded, before
 * the test below ever runs.
 */
describe('marketplace-disabled academic behaviour (Phase 13, T204)', () => {
  const ORIGINAL_MARKETPLACE_ENABLED = process.env['MARKETPLACE_ENABLED'];

  afterEach(() => {
    if (ORIGINAL_MARKETPLACE_ENABLED === undefined) delete process.env['MARKETPLACE_ENABLED'];
    else process.env['MARKETPLACE_ENABLED'] = ORIGINAL_MARKETPLACE_ENABLED;
    jest.resetModules();
  });

  /**
   * A genuinely fresh, fully-configured app — every piece `main.ts`'s own
   * `bootstrap()` applies before it serves real traffic (`app-factory.ts`'s
   * `createE2EApp()` already replicates the same set for every other e2e
   * test). `NestFactory.create(AppModule)` alone is a DIFFERENT, unprefixed
   * app, not a smaller one — every route this file asserts on, reachable or
   * 404, would 404 for the wrong reason (no `/api/v1` prefix registered at
   * all) without the rest of this setup. Every piece is loaded from the SAME
   * fresh module registry `jest.resetModules()` just produced: a statically
   * top-level `import` (of `NestFactory`, `ValidationPipe`, or this
   * project's own `HttpExceptionFilter`/`ResponseLocalizationInterceptor`)
   * would instead be the module registry's PREVIOUS copy, frozen from
   * before the reset — two different copies of `@nestjs/core` (and anything
   * that keys off its internal provider tokens, like `HttpAdapterHost`,
   * which is exactly what `BullBoardModule.forRoot()` needs) disagreeing
   * about identity. The real symptom observed from getting this wrong: a
   * `NestFactory.create()` throwing "Nest can't resolve dependencies of the
   * BullBoardRootModule ... HttpAdapterHost" even though that provider is
   * always core-registered — the cross-copy mismatch, not a genuinely
   * missing provider.
   */
  async function bootApp(marketplaceEnabled: boolean): Promise<{ app: INestApplication; server: Server }> {
    process.env['MARKETPLACE_ENABLED'] = marketplaceEnabled ? 'true' : 'false';
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppModule } = require('../../src/app.module') as typeof import('../../src/app.module');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { NestFactory } = require('@nestjs/core') as typeof import('@nestjs/core');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ValidationPipe, RequestMethod } = require('@nestjs/common') as typeof import('@nestjs/common');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { HttpExceptionFilter } = require('../../src/common/filters/http-exception.filter') as typeof import('../../src/common/filters/http-exception.filter');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ResponseLocalizationInterceptor } = require('../../src/common/interceptors/response-localization.interceptor') as typeof import('../../src/common/interceptors/response-localization.interceptor');

    // `abortOnError: false` is required here: Nest's default bootstrap error
    // handler calls `process.exit(1)` on an uncaught exception, which — inside
    // a Jest worker — kills the entire test runner process, silently
    // truncating every subsequent test file's results rather than failing
    // just this one test. `abortOnError: false` makes a bootstrap failure a
    // normal, catchable rejection instead.
    const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    // Match `main.ts`: `request.secure` needs X-Forwarded-Proto (reverse-proxy
    // TLS termination), and `/auth/login` reads/writes a signed cookie —
    // both external Express middleware with no NestJS DI identity, so no
    // module-registry-freshness concern for these two specifically.
    app.set('trust proxy', 1);
    app.use(cookieParser(process.env['COOKIE_SECRET'] ?? process.env['JWT_SECRET'] ?? 'test-cookie-secret'));
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true } }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new ResponseLocalizationInterceptor());
    app.setGlobalPrefix('api/v1', { exclude: [{ path: 'metrics', method: RequestMethod.GET }] });

    await app.init();
    return { app, server: app.getHttpServer() as Server };
  }

  it('every marketplace route is unreachable — 404, never a partial/degraded response', async () => {
    const { app, server } = await bootApp(false);
    try {
      // No `.env.test` fixture id needed — the module itself is absent, so
      // even a syntactically well-formed request 404s at the router before
      // any handler, guard, or service runs.
      await request(server).get(`${API_PREFIX}/marketplace/courses`).expect(404);
      await request(server).get(`${API_PREFIX}/marketplace/categories`).expect(404);
      await request(server).get(`${API_PREFIX}/marketplace/admin/overview`).expect(404);
      await request(server).post(`${API_PREFIX}/marketplace/applications`).send({}).expect(404);
    } finally {
      await app.close();
    }
  });

  it('a core academic journey — register, log in, read the public academic catalogue — completes normally with marketplace absent', async () => {
    const { app, server } = await bootApp(false);
    try {
      // Loaded fresh, from the same reset module registry as `AppModule` —
      // a statically-imported helper would be a different module instance
      // than the one this freshly-booted app's own `DataSource` belongs to.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getUserIdByEmail, setUserStatus } = require('./helpers/database') as typeof import('./helpers/database');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { buildRegisterPayload } = require('./factories/user.factory') as typeof import('./factories/user.factory');
      const dataSource = app.get((require('typeorm') as typeof import('typeorm')).DataSource);

      const credentials = buildRegisterPayload();
      await request(server).post(`${API_PREFIX}/auth/register`).send(credentials).expect(202);
      const userId = await getUserIdByEmail(dataSource, credentials.email);
      await setUserStatus(dataSource, userId, 'approved');

      const login = await request(server)
        .post(`${API_PREFIX}/auth/login`)
        .send({ email: credentials.email, password: credentials.password })
        .expect(200);
      expect(login.body).toBeDefined();

      // The academic public catalogue (courses/packages) — an entirely
      // different route namespace from `/marketplace/*` — is unaffected.
      await request(server).get(`${API_PREFIX}/packages`).expect((res) => {
        expect(res.status).toBeLessThan(500);
      });
    } finally {
      await app.close();
    }
  });

  it('CONTROL: with the flag on (the normal e2e default), the same marketplace route is reachable', async () => {
    const { app, server } = await bootApp(true);
    try {
      const res = await request(server).get(`${API_PREFIX}/marketplace/categories`);
      expect(res.status).not.toBe(404);
    } finally {
      await app.close();
    }
  }, 30_000);
});
