import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { Logger } from '@nestjs/common';

/**
 * Admin Seeding Script
 * Production-safe version
 */
async function bootstrap() {
  const logger = new Logger('AdminSeeder');

  logger.log('--- Admin User Seeding Started ---');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const adminService = app.get('ADMIN_SEEDER_SERVICE');

    if (!adminService) {
      throw new Error(
        'ADMIN_SEEDER_SERVICE not registered in DI container',
      );
    }

    const result = await adminService.initAdmin();

    if (result?.success) {
      logger.log(`SUCCESS: ${result.message}`);

      if (Array.isArray(result.results)) {
        result.results.forEach((msg: string) => logger.log(`- ${msg}`));
      }
    } else {
      logger.warn(`NOTICE: ${result?.message ?? 'Unknown result'}`);

      if (Array.isArray(result?.results)) {
        result.results.forEach((msg: string) => logger.warn(`- ${msg}`));
      }
    }
  } catch (error: any) {
    logger.error('Admin seeding failed', error?.stack || error?.message);
    process.exitCode = 1;
  } finally {
    await app.close();
    logger.log('--- Seeder Finished ---');
  }
}

bootstrap();