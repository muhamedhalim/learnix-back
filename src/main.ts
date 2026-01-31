import * as crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';

// Crypto polyfill for serverless environments (if needed)
// Note: Modern Node.js (16+) includes crypto on globalThis by default
// Keeping import for backward compatibility
Object.defineProperty(globalThis, 'crypto', {
  value: crypto,
  writable: false,
  configurable: false,
});

import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import basicAuth from 'express-basic-auth';
import helmet from 'helmet';
import { join } from 'path';

import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { CsrfGuard } from './common/guards/csrf.guard';

const logger = new Logger('Bootstrap');

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Protect Bull Board with basic authentication (Issue #13)
  const bullBoardUser = process.env['BULL_BOARD_USER'] ?? 'admin';
  const bullBoardPassword = process.env['BULL_BOARD_PASSWORD'];

  if (bullBoardPassword === undefined || bullBoardPassword === '') {
    logger.warn(
      'WARNING: BULL_BOARD_PASSWORD not set. Bull Board will be inaccessible in production.',
    );
  }

  if (bullBoardPassword !== undefined && bullBoardPassword !== '') {
    const authMiddleware = basicAuth({
      users: { [bullBoardUser]: bullBoardPassword },
      challenge: true,
      realm: 'Bull Board Admin',
    }) as unknown as (req: Request, res: Response, next: NextFunction) => void;

    app.use('/admin/queues', authMiddleware);
    logger.log('Bull Board protected with basic authentication');
  } else if (process.env['NODE_ENV'] !== 'production') {
    logger.warn(
      'WARNING: Bull Board running WITHOUT authentication in development',
    );
  }

  // Enable cookie parsing for CSRF protection (Double Submit Cookie pattern)
  // Use a secret for signing cookies
  const cookieSecret =
    process.env['COOKIE_SECRET'] ?? process.env['JWT_SECRET'];
  if (cookieSecret === undefined || cookieSecret === '') {
    logger.error(
      'ERROR: COOKIE_SECRET or JWT_SECRET must be set for signed cookies',
    );
    process.exit(1);
  }
  app.use(cookieParser(cookieSecret));

  // Security headers with Helmet
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"], // Required for Swagger UI
          scriptSrc: ["'self'", "'unsafe-inline'"], // Required for Swagger UI
          imgSrc: ["'self'", 'data:', 'https:'],
        },
      },
      hsts: {
        maxAge: 31536000, // 1 year
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
    }),
  );

  app.useStaticAssets(join('/app/uploads'), {
    prefix: '/uploads/',
  });

  const allowedOrigins =
    process.env['CORS_ORIGINS'] !== undefined &&
    process.env['CORS_ORIGINS'] !== ''
      ? process.env['CORS_ORIGINS']
          .split(',')
          .map((origin) => origin.trim())
          .filter((origin) => {
            try {
              new URL(origin);
              return true;
            } catch {
              logger.error(`Invalid CORS origin: ${origin}`);
              return false;
            }
          })
      : [
          'http://localhost:3000',
          'http://localhost:5173',
          'https://dodline.vercel.app',
        ];

  logger.log(`CORS enabled for origins: ${allowedOrigins.join(', ')}`);

  app.enableCors({
    origin: (origin: string | undefined, callback) => {
      const isProduction = process.env['NODE_ENV'] === 'production';

      if (origin === undefined) {
        if (isProduction) {
          logger.warn(
            'Request with no origin header (likely health check or direct API call)',
          );
        }
        callback(null, true);
        return;
      }

      // Check if origin is in allowed list
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      }
      // Allow all Vercel preview deployments (*.vercel.app)
      else if (origin.endsWith('.vercel.app')) {
        logger.log(`Accepting Vercel preview deployment: ${origin}`);
        callback(null, true);
      } else {
        logger.warn(`Blocked CORS request from: ${origin}`);
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Firebase-Auth-Token',
      'X-Requested-With',
      'X-CSRF-Token', // Required for CSRF protection
    ],
    credentials: true, // Required for cookies
    optionsSuccessStatus: 200,
  });

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

  // Register RFC 7807 global exception filter for standardized error responses
  app.useGlobalFilters(new HttpExceptionFilter());

  // Enable CSRF protection globally (Double Submit Cookie pattern)
  // Uses SameSite=Lax cookies as primary defense + token validation for state-changing requests
  app.useGlobalGuards(new CsrfGuard(new Reflector()));

  app.setGlobalPrefix('api/v1');

  const config = new DocumentBuilder()
    .setTitle('backend center')
    .setDescription(
      'Comprehensive backend API for backend center e-learning platform',
    )
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'JWT',
        description: 'Enter JWT token',
        in: 'header',
      },
      'JWT-auth',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document, {
    customSiteTitle: 'backend center API Documentation',
    customfavIcon: '/favicon.ico',
    customCss: '.swagger-ui .topbar { display: none }',
  });

  // Lightweight debug logger for root/health checks only
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (req.url === '/' || req.url.startsWith('/api/v1/health')) {
      logger.log(`[INCOMING] ${req.method} ${req.url}`);
    }
    next();
  });

  // Simple root endpoint for Railway healthcheck
  app.use('/', (req: Request, res: Response, next: NextFunction): void => {
    if (req.url === '/' && req.method === 'GET') {
      res.status(200).json({
        status: 'ok',
        message: 'E-Learning Platform API',
        version: '1.0.0',
        docs: '/api',
        health: '/api/v1/health',
        timestamp: new Date().toISOString(),
      });
      return;
    }
    next(); // ensure other routes still work
  });

  // Ensure we parse PORT as a number and bind to 0.0.0.0 so Railway's proxy can reach the process
  const port =
    process.env['PORT'] !== undefined && process.env['PORT'] !== ''
      ? Number(process.env['PORT'])
      : 3000;
  await app.listen(port, '0.0.0.0');

  logger.log(`Application is running on: 0.0.0.0:${String(port)}`);
  logger.log(`Swagger documentation: http://0.0.0.0:${String(port)}/api`);
}

bootstrap().catch((error: unknown) => {
  logger.error('ERROR: Error starting application:', error);
  process.exit(1);
});
