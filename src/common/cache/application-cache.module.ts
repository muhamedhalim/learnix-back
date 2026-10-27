import { Global, Module } from '@nestjs/common';

import { ApplicationCacheService } from './application-cache.service';
import { DistributedSingleFlightService } from './distributed-single-flight.service';

/**
 * Owns the application cache (`ApplicationCacheService`) and the single-flight lock it uses
 * (`DistributedSingleFlightService`). About 25 services across unrelated domains depend on the
 * cache, so it lives in `common/cache` instead of being a by-product of `AnalyticsModule`, which
 * itself imports `PaymentsModule`. Global, like the `CACHE_MANAGER` it wraps (registered in
 * `AppModule`), so consumers keep injecting it without importing a module.
 */
@Global()
@Module({
  providers: [DistributedSingleFlightService, ApplicationCacheService],
  exports: [DistributedSingleFlightService, ApplicationCacheService],
})
export class ApplicationCacheModule {}
