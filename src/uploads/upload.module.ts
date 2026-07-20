import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { User } from '../users/entities/user.entity';
import { MediaModule } from '../media/media.module';
import { CleanupService } from './cleanup.service';
import { UploadedFile } from './entities/uploaded-file.entity';
import { FileManagementService } from './file-management.service';
import { UploadService } from './upload.service';
import { UploadsController } from './uploads.controller';
import { TeacherUploadsController } from './teacher-uploads.controller';

@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([UploadedFile, User]), MediaModule],
  controllers: [UploadsController, TeacherUploadsController],
  providers: [CleanupService, FileManagementService, UploadService],
  exports: [CleanupService, FileManagementService, UploadService],
})
export class UploadModule implements OnModuleInit {
  public onModuleInit(): void {
    // Module initialized - Upload services ready
  }
}
