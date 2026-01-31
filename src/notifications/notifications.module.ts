import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { StudentProfile } from '../students/entities/student-profile.entity';
import { User } from '../users/entities/user.entity';

import {
  AdminNotificationsController,
  NotificationsController,
  NotificationSettingsController,
} from './controllers';
import { Notification, NotificationSettings } from './entities';
import {
  NotificationsService,
  NotificationTriggersService,
  SmsSenderService,
} from './services';

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
export class NotificationsModule implements OnModuleInit {
  public onModuleInit(): void {
    // Module initialized - Notification services ready
  }
}
