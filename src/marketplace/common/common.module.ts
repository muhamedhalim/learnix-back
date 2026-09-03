import { Module } from '@nestjs/common';

import { StorageModule } from '../../storage/storage.module';
import { MarketplaceStorageService } from './marketplace-storage.service';

/**
 * Genuinely cross-cutting marketplace providers that more than one
 * sub-module needs — currently just the private-storage wrapper. Any
 * sub-module that needs one of these imports `MarketplaceCommonModule`
 * rather than redeclaring the provider itself.
 */
@Module({
  imports: [StorageModule],
  providers: [MarketplaceStorageService],
  exports: [MarketplaceStorageService],
})
export class MarketplaceCommonModule {}
