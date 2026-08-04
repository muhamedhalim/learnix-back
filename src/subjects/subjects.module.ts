import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ActivityLogsModule } from '../activity-logs/activity-logs.module';
import { UploadModule } from '../uploads/upload.module';
import {
  AdminSubjectsController,
  SubjectsController,
  TeacherSubjectsController,
} from './controllers';
import { Subject } from './entities/subject.entity';
import { SubjectsService } from './subjects.service';

@Module({
  imports: [TypeOrmModule.forFeature([Subject]), UploadModule, ActivityLogsModule],
  controllers: [AdminSubjectsController, TeacherSubjectsController, SubjectsController],
  providers: [SubjectsService],
  exports: [SubjectsService, TypeOrmModule],
})
export class SubjectsModule implements OnModuleInit {
  public onModuleInit(): void {
    // Module initialized - Subject services ready
  }
}
