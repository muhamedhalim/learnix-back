import { Module } from '@nestjs/common';

import { AdminInitializationService } from './admin-initialization.service';

/**
 * Isolated module for `AdminInitializationService` so it can be resolved by
 * both the main HTTP application (`AppModule`) and the standalone seed
 * script (`seed-admin.ts`, via `NestFactory.createApplicationContext`)
 * without either needing to import unrelated app modules.
 *
 * No `TypeOrmModule.forFeature` import is needed here: the service uses the
 * injected `DataSource` directly (via `manager.getRepository(User)` inside
 * its transaction), and `DataSource` is already provided globally by the
 * `TypeOrmCoreModule` registered in `AppModule`.
 */
@Module({
  providers: [AdminInitializationService],
  exports: [AdminInitializationService],
})
export class AdminInitModule {}
