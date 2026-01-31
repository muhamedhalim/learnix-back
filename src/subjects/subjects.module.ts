import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { UploadModule } from '../uploads/upload.module';

import { AdminSubjectsController, SubjectsController } from './controllers';
import { Subject } from './entities/subject.entity';
import { SubjectsService } from './subjects.service';

@Module({
  imports: [TypeOrmModule.forFeature([Subject]), UploadModule],
  controllers: [SubjectsController, AdminSubjectsController],
  providers: [SubjectsService],
  exports: [SubjectsService, TypeOrmModule],
})
export class SubjectsModule implements OnModuleInit {
  public onModuleInit(): void {
    // Module initialized - Subject services ready
  }
}
