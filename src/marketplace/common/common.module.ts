import { Module } from '@nestjs/common';

import { StorageModule } from '../../storage/storage.module';
import { MarketplaceImageService } from './marketplace-image.service';
import { MarketplaceStorageService } from './marketplace-storage.service';

/**
 * Genuinely cross-cutting marketplace providers that more than one
 * sub-module needs — currently just the private-storage wrapper. Any
 * sub-module that needs one of these imports `MarketplaceCommonModule`
 * rather than redeclaring the provider itself.
 */
@Module({
  imports: [StorageModule],
  providers: [MarketplaceStorageService, MarketplaceImageService],
  exports: [MarketplaceStorageService, MarketplaceImageService],
})
export class MarketplaceCommonModule {}
