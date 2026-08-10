import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ActivityLogsModule } from '../activity-logs/activity-logs.module';
import { MetricsModule } from '../common/metrics';
import { MediaModule } from '../media/media.module';
import { ReviewsModule } from '../reviews/reviews.module';
import { Subject } from '../subjects/entities/subject.entity';
import { User } from '../users/entities/user.entity';
import {
  AdminTeachersController,
  TeacherProfileController,
  TeachersController,
} from './controllers';
import { TeacherProfile } from './entities/teacher-profile.entity';
import { TeachersService } from './teachers.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([TeacherProfile, User, Subject]),
    MediaModule,
    ActivityLogsModule,
    MetricsModule,
    // Supplies the canonical teacher rating (approved teacher_reviews).
    // ReviewsModule imports no feature module, so this is not circular.
    ReviewsModule,
  ],
  controllers: [
    AdminTeachersController,
    TeacherProfileController,
    TeachersController,
  ],
  providers: [TeachersService],
  exports: [TeachersService, TypeOrmModule],
})
export class TeachersModule implements OnModuleInit {
  public onModuleInit(): void {
    // Module initialized - Teacher services ready
  }
}
