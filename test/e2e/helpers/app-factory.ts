import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';

import cookieParser from 'cookie-parser';
import { DataSource } from 'typeorm';

import { AppModule } from '../../../src/app.module';
import { HttpExceptionFilter } from '../../../src/common/filters/http-exception.filter';
import { CsrfGuard } from '../../../src/common/guards/csrf.guard';

export interface E2EContext {
  app: INestApplication;
  dataSource: DataSource;
}

/** Shared bootstrap; `withCsrfGuard` controls whether CsrfGuard is installed. */
async function bootstrapE2EApp(withCsrfGuard: boolean): Promise<E2EContext> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication();

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

  if (withCsrfGuard) {
    app.useGlobalGuards(new CsrfGuard(new Reflector()));
  }

  app.setGlobalPrefix('api/v1');

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
export async function createE2EApp(): Promise<E2EContext> {
  return bootstrapE2EApp(false);
}

/**
 * Same as {@link createE2EApp}, but with the global `CsrfGuard` installed
 * (mirroring `main.ts` exactly, including cookie attribute derivation via
 * `getCrossSiteCookieOptions`). Use this to test the CSRF bootstrap/login flow
 * end-to-end.
 */
export async function createE2EAppWithCsrf(): Promise<E2EContext> {
  return bootstrapE2EApp(true);
}

/** Base URL prefix all E2E requests share. */
export const API_PREFIX = '/api/v1';
