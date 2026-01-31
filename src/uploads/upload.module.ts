import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { User } from '../users/entities/user.entity';

import { CleanupService } from './cleanup.service';
import { UploadService } from './upload.service';
import { UploadsController } from './uploads.controller';

@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([User])],
  controllers: [UploadsController],
  providers: [UploadService, CleanupService],
  exports: [UploadService, CleanupService],
})
export class UploadModule implements OnModuleInit {
  public onModuleInit(): void {
    // Module initialized - Upload services ready
  }
}
