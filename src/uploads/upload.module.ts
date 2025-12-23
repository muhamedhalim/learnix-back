import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UploadService } from './upload.service';
import { CleanupService } from './cleanup.service';
import { UploadsController } from './uploads.controller';
import { User } from '../users/entities/user.entity';

@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([User])],
  controllers: [UploadsController],
  providers: [UploadService, CleanupService],
  exports: [UploadService, CleanupService],
})
export class UploadModule {}
