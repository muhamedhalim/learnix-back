import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Subject } from './entities/subject.entity';
import { SubjectsService } from './subjects.service';
import { SubjectsController, AdminSubjectsController } from './controllers';
import { UploadModule } from '../uploads/upload.module';

@Module({
  imports: [TypeOrmModule.forFeature([Subject]), UploadModule],
  controllers: [SubjectsController, AdminSubjectsController],
  providers: [SubjectsService],
  exports: [SubjectsService, TypeOrmModule],
})
export class SubjectsModule {}
