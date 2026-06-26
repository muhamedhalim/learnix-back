import './polyfills';

import {
  Logger,
  ValidationPipe,
} from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { join } from 'path';

import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
// import { CsrfGuard } from './common/guards/csrf.guard';

const logger = new Logger('Bootstrap');

function getAllowedOrigins(): string[] {
  const env = process.env['CORS_ORIGINS'];

  if (env && env.length > 0) {
    return env
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
  }

  return [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:5173',
    'https://*.vercel.app',
  ];
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: process.env['NODE_ENV'] === 'production'
      ? ['error', 'warn', 'log']
      : ['debug', 'log', 'warn', 'error'],
  });

  const isProd = process.env['NODE_ENV'] === 'production';

  app.set('trust proxy', 1);

  const cookieSecret =
    process.env['COOKIE_SECRET'] || process.env['JWT_SECRET'];

  if (!cookieSecret) {
    logger.error('COOKIE_SECRET or JWT_SECRET is required');
    process.exit(1);
  }

  app.use(cookieParser(cookieSecret));

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },

      contentSecurityPolicy: isProd
        ? {
            directives: {
              defaultSrc: ["'self'"],
              imgSrc: ["'self'", 'data:', 'https:'],
              scriptSrc: ["'self'"],
              styleSrc: ["'self'"],
            },
          }
        : false, // IMPORTANT: disable CSP in dev (fix Swagger + HMR issues)
    }),
  );

  app.useStaticAssets(join(process.cwd(), 'uploads'), {
    prefix: '/uploads/',
  });

  const allowedOrigins = getAllowedOrigins();

  logger.log(`Allowed CORS Origins: ${allowedOrigins.join(', ')}`);

  app.enableCors({
    origin: (origin, callback) => {
      // allow server-to-server / postman / health checks
      if (!origin) return callback(null, true);

      const isAllowed =
        allowedOrigins.includes(origin) ||
        origin.endsWith('.vercel.app');

      if (isAllowed) return callback(null, true);

      logger.warn(`CORS BLOCKED: ${origin}`);
      return callback(null, false);
    },

    credentials: true,

    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],

    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-CSRF-Token',
    ],
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

  app.useGlobalFilters(new HttpExceptionFilter());

  // app.useGlobalGuards(new CsrfGuard(new Reflector()));

  app.setGlobalPrefix('api/v1');

  if (!isProd || process.env['ENABLE_SWAGGER'] === 'true') {
    const config = new DocumentBuilder()
      .setTitle('E-Learning Platform API')
      .setDescription('Backend API Documentation')
      .setVersion('1.0')
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

  app.use((req: { method: string; url: string; }, res: { status: (arg0: number) => { (): any; new(): any; json: { (arg0: { status: string; service: string; version: string; docs: string; health: string; timestamp: string; }): any; new(): any; }; }; }, next: () => void) => {
    if (req.method === 'GET' && req.url === '/') {
      return res.status(200).json({
        status: 'ok',
        service: 'E-Learning API',
        version: '1.0',
        docs: '/api',
        health: '/api/v1/health',
        timestamp: new Date().toISOString(),
      });
    }

    next();
  });

  const port = Number(process.env['PORT']) || 3000;

  await app.listen(port, '0.0.0.0');

  logger.log(`🚀 Server running on http://0.0.0.0:${port}`);
  logger.log(`📘 Swagger: http://0.0.0.0:${port}/api`);
}


bootstrap().catch((err) => {
  logger.error('❌ Fatal Bootstrap Error:', err);
  process.exit(1);
});