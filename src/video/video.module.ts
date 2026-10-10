import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MediaModule } from '../media/media.module';
import { AwsVideoService } from './aws-video.service';
import { VideoAsset } from './entities/video-asset.entity';
import { MediaEventsConsumer } from './media-events.consumer';
import { PlaybackCookiesInterceptor } from './playback-cookies';
import { VideoConfig } from './video.config';

/** AWS video pipeline: S3 source -> MediaConvert HLS -> CloudFront (signed cookies). */
@Module({
  imports: [ConfigModule, MediaModule, TypeOrmModule.forFeature([VideoAsset])],
  providers: [VideoConfig, AwsVideoService, MediaEventsConsumer, PlaybackCookiesInterceptor],
  exports: [VideoConfig, AwsVideoService, PlaybackCookiesInterceptor],
})
export class VideoModule {}
