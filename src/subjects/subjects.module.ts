import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Subject } from './entities/subject.entity';
import { SubjectsService } from './subjects.service';
import { SubjectsController, AdminSubjectsController } from './controllers';

@Module({
  imports: [TypeOrmModule.forFeature([Subject])],
  controllers: [SubjectsController, AdminSubjectsController],
  providers: [SubjectsService],
  exports: [SubjectsService, TypeOrmModule],
})
export class SubjectsModule {}
