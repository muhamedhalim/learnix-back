import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { Notification, NotificationSettings } from './entities';
import {
  SmsSenderService,
  NotificationsService,
  NotificationTriggersService,
} from './services';
import {
  NotificationsController,
  NotificationSettingsController,
  AdminNotificationsController,
} from './controllers';
import { User } from '../users/entities/user.entity';
import { StudentProfile } from '../students/entities/student-profile.entity';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([
      Notification,
      NotificationSettings,
      User,
      StudentProfile,
    ]),
  ],
  controllers: [
    NotificationsController,
    NotificationSettingsController,
    AdminNotificationsController,
  ],
  providers: [
    SmsSenderService,
    NotificationsService,
    NotificationTriggersService,
  ],
  exports: [
    NotificationsService,
    NotificationTriggersService,
    SmsSenderService,
  ],
})
export class NotificationsModule {}
