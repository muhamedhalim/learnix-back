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
import { DirectUpload } from './direct/direct-upload.entity';
import { DirectUploadsCleanupService } from './direct/direct-uploads-cleanup.service';
import { DirectUploadsController } from './direct/direct-uploads.controller';
import { DirectUploadsService } from './direct/direct-uploads.service';
import { TeacherUploadsController } from './teacher-uploads.controller';

@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([UploadedFile, User, DirectUpload]), MediaModule],
  controllers: [UploadsController, TeacherUploadsController, DirectUploadsController],
  providers: [
    CleanupService,
    FileManagementService,
    UploadService,
    DirectUploadsService,
    DirectUploadsCleanupService,
  ],
  exports: [CleanupService, FileManagementService, UploadService, DirectUploadsService],
})
export class UploadModule implements OnModuleInit {
  public onModuleInit(): void {
    // Module initialized - Upload services ready
  }
}
