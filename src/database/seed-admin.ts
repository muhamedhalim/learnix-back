import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AdminInitializationService } from '../admin-init/admin-initialization.service';
import { AppModule } from '../app.module';

/**
 * Manual admin-initialization entry point (`npm run seed:admin`).
 *
 * Calls the exact same `AdminInitializationService.initialize()` used
 * automatically at every application boot (see `main.ts`) — there is no
 * separate seeding implementation. The previous version of this script
 * called `app.get('ADMIN_SEEDER_SERVICE')`, a string DI token that was never
 * registered as a provider anywhere in this codebase; it always failed with
 * "Nest could not find ADMIN_SEEDER_SERVICE element". That token has been
 * removed entirely — this now resolves the real, typed provider.
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('AdminSeeder');
  logger.log('--- Admin User Seeding Started ---');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const adminInitializationService = app.get(AdminInitializationService);
    const result = await adminInitializationService.initialize();

    switch (result.outcome) {
      case 'created':
        logger.log(`SUCCESS: Initial administrator created (${result.adminEmail ?? 'unknown'})`);
        break;
      case 'already_exists':
        logger.log('NOTICE: Administrator already exists. Skipping initialization.');
        break;
      case 'skipped_missing_env':
        logger.warn(
          'SKIPPED: ADMIN_INIT_EMAIL / ADMIN_INIT_PASSWORD are not configured.',
        );
        process.exitCode = 1;
        break;
    }
  } catch (error) {
    logger.error(
      'Admin seeding failed',
      error instanceof Error ? error.stack : String(error),
    );
    process.exitCode = 1;
  } finally {
    await app.close();
    logger.log('--- Seeder Finished ---');
  }
}

bootstrap();
