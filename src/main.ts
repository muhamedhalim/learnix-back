import './polyfills';
// Initialises Sentry + global error handlers before any other module loads so
// its auto-instrumentation can hook HTTP/DB/Redis. No-op when SENTRY_DSN is unset.
import './instrument';

import {
  ConsoleLogger,
  Logger,
  type LogLevel,
  RequestMethod,
  ValidationPipe,
} from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import compression from 'compression';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

import { AdminInitializationService } from './admin-init/admin-initialization.service';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { CsrfGuard } from './common/guards/csrf.guard';
import { rejectBrotliRequestBodies } from './common/middleware/reject-brotli-request-body.middleware';
import { buildCorsOptions, getAllowedOrigins } from './common/utils/cors.util';
import { ResponseLocalizationInterceptor } from './common/interceptors/response-localization.interceptor';
import { AppDataSource } from './data-source';
import { withMigrationAdvisoryLock } from './database/migration-lock.util';
import { isMarketplaceEnabled } from './config/marketplace.config';
import { resolveProcessRole, runsBackgroundWork } from './config/process-role';
import {
  buildLoggerOptions,
  resolveKeepAliveTimeouts,
  resolveTrustProxyHops,
} from './config/http-runtime';
import { installGracefulShutdown } from './common/utils/graceful-shutdown.util';

const logger = new Logger('Bootstrap');

// Applies any pending TypeORM migrations before the Nest module tree is
// built. Deploy platforms are typically configured to run
// `migration:run:prod` as a separate step before starting the process (see
// Procfile / nixpacks.toml), but that ordering lives in platform-level start
// commands, which can be overridden or bypassed outside this repo. Modules
// that query the database from `onModuleInit` (e.g. RankSeederService) run
// during `NestFactory.create()`, before `bootstrap()` gets a chance to do
// anything else — so migrations must be guaranteed to have run *before* that
// call, from inside the app itself, not just as an external shell step.
// This uses TypeORM's own migration runner (`runMigrations`), which is
// idempotent — already-applied migrations are skipped — and never touches
// `synchronize`.
//
// Production-only (see call site below): a developer running `start:dev`
// wants to iterate against whatever schema state their local DB is already
// in and apply migrations manually (`npm run migration:run`) on their own
// schedule — an automatic run blocking every dev restart on a migration
// that fails (or a DB that isn't reachable yet) defeats that. Gating this on
// `NODE_ENV === 'production'` doesn't change production's behavior at all:
// by the time `main.js` runs there, `npm run start:migrate:prod` has always
// already run `migration:run:prod` first, so this call is already a no-op
// idempotency check in practice — it stays only as the from-inside-the-app
// safety net the comment above describes.
async function runPendingMigrations(): Promise<void> {
  const dataSource = await AppDataSource.initialize();
  try {
    // Same advisory lock `migration:run:prod` (`database/migrate-cli.ts`)
    // uses — both the external pre-boot step and this in-app safety net
    // coordinate through the identical lock, so whichever one wins the race
    // against a concurrently-deploying replica runs first and the other
    // blocks briefly against an already-migrated (no-op) database. See
    // `database/migration-lock.util.ts` for why this exists (R4).
    const executed = await withMigrationAdvisoryLock(
      dataSource,
      () => dataSource.runMigrations(),
      (message) => logger.log(message),
    );
    if (executed.length > 0) {
      logger.log(
        `Applied ${String(executed.length)} pending migration(s): ${executed.map((m) => m.name).join(', ')}`,
      );
    }
  } finally {
    await dataSource.destroy();
  }
}

function getLogLevels(): LogLevel[] {
  const configured = process.env['LOG_LEVELS'];
  if (configured) {
    const validLevels = new Set<LogLevel>(['fatal', 'error', 'warn', 'log', 'debug', 'verbose']);
    const levels = configured
      .split(',')
      .map((level) => level.trim() as LogLevel)
      .filter((level) => validLevels.has(level));
    if (levels.length > 0) return levels;
  }

  return process.env['NODE_ENV'] === 'production'
    ? ['error', 'warn', 'log']
    : ['debug', 'log', 'warn', 'error'];
}

async function bootstrap(): Promise<void> {
  // Additive opt-out (RUN_MIGRATIONS), default unset — i.e. unchanged
  // behaviour. Exists for a deployment topology where boot-time migrations
  // would race across replicas; scripts/migrate.ts's advisory lock is the
  // primary fix for that race, this is the escape hatch for an operator who
  // wants migrations run only from an explicit, out-of-band command instead.
  if (process.env['NODE_ENV'] === 'production' && process.env['RUN_MIGRATIONS'] !== 'false') {
    await runPendingMigrations();
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: new ConsoleLogger(buildLoggerOptions(getLogLevels())),
    // Retains the unparsed request body on `req.rawBody`. Required to verify
    // Meta's `X-Hub-Signature-256` HMAC, which is computed over the exact bytes
    // Meta sent — re-serialising the parsed JSON would not reproduce them.
    rawBody: true,
  });

  // Without this, Nest's OnModuleDestroy lifecycle (TypeORM, BullMQ, the
  // idempotency/single-flight/health-collector Redis clients, the throttler
  // storage adapter) never runs on SIGTERM/SIGINT — Railway's stop signal
  // simply kills the process and every connection is dropped by the OS
  // instead of closed by the app. Strictly additive: request handling and
  // responses are unchanged; only the shutdown path gains a clean drain.
  // Not app.enableShutdownHooks(): that closes the moment the signal arrives and cannot wait for the load
  // balancer to stop routing here. The handler marks readiness not-ready, waits SHUTDOWN_DELAY_MS, then
  // runs app.close() (which still fires every OnModuleDestroy hook) under a hard SHUTDOWN_TIMEOUT_MS.
  installGracefulShutdown(app);

  // Explicit, sequential — not a lifecycle hook — so the ordering the
  // deployment lifecycle requires (migrations → admin init → HTTP server
  // listening) is readable directly from this file instead of depending on
  // NestJS's OnApplicationBootstrap invocation order across every provider
  // that implements it. A genuine failure here (not the two expected skip
  // cases, which AdminInitializationService returns rather than throws)
  // propagates out of bootstrap() below and stops the process before
  // app.listen() — the server must never come up without this step having
  // definitely completed one way or another.
  await app.get(AdminInitializationService).initialize();

  const isProd = process.env['NODE_ENV'] === 'production';

  // Hops between the client and this process: 1 historically; CloudFront + ALB = 2.
  app.set('trust proxy', resolveTrustProxyHops());

  // Before the body parsers Nest registers in init(): brotli request bodies never reach the decoder.
  app.use(rejectBrotliRequestBodies);

  const cookieSecret = process.env['COOKIE_SECRET'] || process.env['JWT_SECRET'];

  if (!cookieSecret) {
    logger.error('COOKIE_SECRET or JWT_SECRET is required');
    process.exit(1);
  }

  app.use(cookieParser(cookieSecret));

  // Gzip/deflate response compression for JSON payloads and list responses.
  app.use(compression());

  app.use(
    helmet({
      hsts: {
        maxAge: 31_536_000, // 1 year
        includeSubDomains: true,
        preload: true,
      },
      frameguard: {
        action: 'deny', // X-Frame-Options: DENY (clickjacking protection)
      },
      noSniff: true, // X-Content-Type-Options: nosniff
      xssFilter: true, // X-XSS-Protection: 1; mode=block (legacy browsers)
      referrerPolicy: {
        policy: 'strict-origin-when-cross-origin',
      },
      // Allow cross-origin resource loading for images/uploads
      // This fixes ERR_BLOCKED_BY_RESPONSE.NotSameOrigin for thumbnails
      crossOriginResourcePolicy: { policy: 'cross-origin' },

      contentSecurityPolicy: isProd
        ? {
            directives: {
              defaultSrc: ["'self'"],
              imgSrc: ["'self'", 'data:', 'https:'],
              scriptSrc: ["'self'"],
              styleSrc: ["'self'"],
              // Hardening: block plugins/objects, lock down base URI and form
              // targets, forbid framing (defence-in-depth with frameguard), and
              // disallow the API being embedded anywhere.
              objectSrc: ["'none'"],
              baseUri: ["'self'"],
              formAction: ["'self'"],
              frameAncestors: ["'none'"],
              upgradeInsecureRequests: [],
            },
          }
        : false, // IMPORTANT: disable CSP in dev (fix Swagger + HMR issues)
    }),
  );

  const allowedOrigins = getAllowedOrigins();

  logger.log(`Allowed CORS Origins: ${allowedOrigins.join(', ')}`);

  // Strict allow-list match, no wildcard suffix matching: arbitrary *.vercel.app (or any look-alike)
  // origins cannot make credentialed cross-origin requests (see buildCorsOptions).
  app.enableCors(
    buildCorsOptions(allowedOrigins, (origin) => logger.warn(`CORS BLOCKED: ${origin}`)),
  );

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new ResponseLocalizationInterceptor());

  app.useGlobalGuards(new CsrfGuard(new Reflector()));

  app.setGlobalPrefix('api/v1', {
    exclude: [{ path: 'metrics', method: RequestMethod.GET }],
  });

  if (!isProd || process.env['ENABLE_SWAGGER'] === 'true') {
    const config = new DocumentBuilder()
      .setTitle('E-Learning Platform API')
      .setDescription('Backend API Documentation')
      .setVersion('1.0')
      .addCookieAuth('access_token', { type: 'apiKey', in: 'cookie' }, 'cookie-auth')
      // Retained only for Firebase ID-token endpoints/clients.
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
        'JWT-auth',
      )
      .build();

    const document = SwaggerModule.createDocument(app, config);

    SwaggerModule.setup('api', app, document, {
      customSiteTitle: 'API Docs',
    });
  }

  app.use((req: Request, res: Response, next: NextFunction): void => {
    if (req.method === 'GET' && req.url === '/') {
      res.status(200).json({
        status: 'ok',
        service: 'E-Learning API',
        version: '1.0',
        docs: '/api',
        health: '/api/v1/health',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    next();
  });

  const port = Number(process.env['PORT']) || 3000;

  await app.listen(port, '0.0.0.0');
  logger.log(
    `Process role: ${resolveProcessRole()} (background work ${runsBackgroundWork() ? 'on' : 'off'})`,
  );
  // Absent/false means every /api/v1/marketplace/* route answers "Cannot GET": say so at boot.
  logger.log(
    isMarketplaceEnabled()
      ? 'Marketplace module: enabled'
      : 'Marketplace module: DISABLED (set MARKETPLACE_ENABLED=true to serve /api/v1/marketplace/*)',
  );

  // Lesson videos are uploaded as one long-lived multipart request (see
  // teacher-lessons.controller.ts). Node's http.Server defaults — introduced
  // as slow-loris hardening — would otherwise forcibly kill any such request
  // once its TOTAL duration (not just idle time) exceeds requestTimeout,
  // independent of file size: a large/slow upload over a real network can
  // easily take much longer than the 300s default. Disabling these here is
  // safe: authentication/role guards run before the (now much larger) body is
  // ever read, so this doesn't relax the DoS protection those defaults exist
  // for — it only stops legitimate long uploads from being killed mid-transfer.
  const httpServer = app.getHttpServer();
  // Total request duration stays uncapped so a legitimate multi-GB lesson
  // upload is never killed mid-transfer regardless of how long it takes.
  httpServer.requestTimeout = 0; // Node 18+/20 default: 300_000ms (5 min)
  // BUT keep finite header and keep-alive deadlines. These bound the phases no
  // upload needs to hold open — waiting for the *request line + headers* to
  // fully arrive, and idle time *between* requests on a reused connection — and
  // are the exact window a Slowloris/idle-socket exhaustion attack lives in.
  // An unauthenticated client can no longer pin a socket open indefinitely by
  // dribbling headers or going idle; the body phase (where large uploads live)
  // remains unbounded. headersTimeout must exceed keepAliveTimeout.
  // Defaults (125 s / 130 s) sit above the ALB's 120 s idle timeout so the LB never reuses a
  // socket Node already closed. Override with HTTP_KEEP_ALIVE_TIMEOUT_MS.
  const keepAlive = resolveKeepAliveTimeouts();
  httpServer.headersTimeout = keepAlive.headersTimeoutMs;
  httpServer.keepAliveTimeout = keepAlive.keepAliveTimeoutMs;
  httpServer.setTimeout(0); // no per-socket inactivity kill during a slow large upload body

  logger.log(`🚀 Server running on http://0.0.0.0:${port}`);
  logger.log(`📘 Swagger: http://0.0.0.0:${port}/api`);
}

bootstrap().catch((err) => {
  logger.error('❌ Fatal Bootstrap Error:', err);
  process.exit(1);
});
