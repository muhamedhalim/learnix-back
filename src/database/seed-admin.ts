import { NestFactory } from '@nestjs/core';

import { AppModule } from '../app.module';
import { AppService } from '../app.service';

/**
 * Admin Seeding Script
 *
 * This script initializes the first admin user using credentials defined in the .env file.
 * Usage: npm run seed:admin
 *
 * Requirements:
 * - ADMIN_INIT_EMAIL in .env
 * - ADMIN_INIT_PASSWORD in .env
 */
async function bootstrap() {
  console.log('--- Admin User Seeding ---');

  const app = await NestFactory.createApplicationContext(AppModule);
  const appService = app.get(AppService);

  try {
    const result = await appService.initAdmin();

    if (result.success) {
      console.log('\u001B[32m%s\u001B[0m', `SUCCESS: ${result.message}`);
      result.results.forEach((msg) => console.log(`- ${msg}`));
    } else {
      console.log('\u001B[33m%s\u001B[0m', `NOTICE: ${result.message}`);
      result.results.forEach((msg) => console.log(`- ${msg}`));
    }
  } catch (error: any) {
    console.error('\u001B[31m%s\u001B[0m', 'ERROR: Admin seeding failed');
    console.error(`Reason: ${error.message || error}`);
    process.exitCode = 1;
  } finally {
    await app.close();
    console.log('--------------------------');
  }
}

bootstrap();
