import { Module } from '@nestjs/common';

import { MediaController } from './media.controller';
import { MediaService } from './media.service';

/**
 * Public media proxy — see `MediaController` for why this exists (never
 * expose storage URLs to the frontend). `StorageModule` is `@Global()` so it
 * doesn't need to be imported here.
 */
@Module({
  controllers: [MediaController],
  providers: [MediaService],
  exports: [MediaService],
})
export class MediaModule {}
