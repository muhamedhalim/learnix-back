import type { INestApplication } from '@nestjs/common';
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';

import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { DataSource } from 'typeorm';

import { AppModule } from '../../../src/app.module';
import { HttpExceptionFilter } from '../../../src/common/filters/http-exception.filter';
import { CsrfGuard } from '../../../src/common/guards/csrf.guard';
import { ResponseLocalizationInterceptor } from '../../../src/common/interceptors/response-localization.interceptor';
import { GoogleMeetProvider } from '../../../src/lessons/meetings/providers/google-meet/google-meet.provider';
import type { MeetingProviderClient } from '../../../src/lessons/meetings/providers/meeting-provider.interface';
import {
  PUSH_PROVIDER,
  type PushProvider,
} from '../../../src/notifications/push/push-provider.interface';
import { StorageService } from '../../../src/storage/storage.service';

export interface E2EContext {
  app: INestApplication;
  dataSource: DataSource;
}

export interface E2EOverrides {
  storageService?: Partial<StorageService>;
  /**
   * Substitute the push transport. Push is the one notification channel whose
   * "did it actually go out?" question cannot be answered from the database, so
   * specs that assert real dispatch swap in a recording double here rather than
   * contacting FCM. Everything above the provider — preference policy, device
   * selection, delivery records, invalid-token handling — remains the real code.
   */
  pushProvider?: Partial<PushProvider>;
  /**
   * Substitute Google Meet, the first concrete `MeetingProviderClient`
   * (Phase 4). No real OAuth app / Calendar API call can happen in CI, so
   * specs exercising meeting generation swap in a recording double here —
   * mirroring `pushProvider` above. Everything above the provider —
   * preconditions, the queue, the worker's claim/persist logic, exposure
   * shaping — remains the real code. Overrides `GoogleMeetProvider`
   * directly (not the `MEETING_PROVIDERS` factory token) so the same
   * instance reaches `MeetingProviderRegistry` via its `inject` array.
   */
  meetingProvider?: Partial<MeetingProviderClient>;
}

/** Shared bootstrap; `withCsrfGuard` controls whether CsrfGuard is installed. */
async function bootstrapE2EApp(
  withCsrfGuard: boolean,
  overrides?: E2EOverrides,
): Promise<E2EContext> {
  let builder = Test.createTestingModule({
    imports: [AppModule],
  });
  if (overrides?.storageService !== undefined) {
    builder = builder.overrideProvider(StorageService).useValue(overrides.storageService);
  }
  if (overrides?.pushProvider !== undefined) {
    builder = builder.overrideProvider(PUSH_PROVIDER).useValue(overrides.pushProvider);
  }
  if (overrides?.meetingProvider !== undefined) {
    builder = builder.overrideProvider(GoogleMeetProvider).useValue(overrides.meetingProvider);
  }
  const moduleFixture: TestingModule = await builder.compile();

  const app = moduleFixture.createNestApplication();

  // Match `main.ts`: production TLS terminates at the reverse proxy, so
  // `request.secure` must use X-Forwarded-Proto when issuing cookies.
  app.set('trust proxy', 1);

  // Match `main.ts` Helmet hardening so header assertions test real behavior.
  app.use(
    helmet({
      hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
      frameguard: { action: 'deny' },
      noSniff: true,
      xssFilter: true,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );

  const cookieSecret =
    process.env['COOKIE_SECRET'] ?? process.env['JWT_SECRET'] ?? 'test-cookie-secret';
  app.use(cookieParser(cookieSecret));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  // Also from `main.ts`: success bodies authored with `biBody(en, ar)` are
  // resolved to one locale and stripped of `message_ar` here. Without it, specs
  // would assert on a body shape no client ever receives.
  app.useGlobalInterceptors(new ResponseLocalizationInterceptor());

  if (withCsrfGuard) {
    app.useGlobalGuards(new CsrfGuard(new Reflector()));
  }

  // Match `main.ts`: /metrics lives outside the API prefix (scrape target).
  app.setGlobalPrefix('api/v1', {
    exclude: [{ path: 'metrics', method: RequestMethod.GET }],
  });

  await app.init();

  const dataSource = moduleFixture.get<DataSource>(DataSource);
  return { app, dataSource };
}

/**
 * Boot the full application the same way `main.ts` does (global prefix,
 * cookie-parser, validation pipe, exception filter) for end-to-end tests.
 *
 * The global CSRF guard is intentionally omitted here: CSRF is a transport
 * concern, and wiring the double-submit token into every request would
 * obscure the business-logic flows these specs test. Use
 * {@link createE2EAppWithCsrf} for specs that specifically exercise the CSRF
 * bootstrap/login flow.
 */
export async function createE2EApp(overrides?: E2EOverrides): Promise<E2EContext> {
  return bootstrapE2EApp(false, overrides);
}

/**
 * Same as {@link createE2EApp}, but with the global `CsrfGuard` installed
 * (mirroring `main.ts` exactly, including cookie attribute derivation via
 * `getCrossSiteCookieOptions`). Use this to test the CSRF bootstrap/login flow
 * end-to-end.
 */
export async function createE2EAppWithCsrf(overrides?: E2EOverrides): Promise<E2EContext> {
  return bootstrapE2EApp(true, overrides);
}

/** Base URL prefix all E2E requests share. */
export const API_PREFIX = '/api/v1';
