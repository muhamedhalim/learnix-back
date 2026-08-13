import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AttendanceCodesModule } from '../attendance-codes/attendance-codes.module';
import { ActivityLogsModule } from '../activity-logs/activity-logs.module';
import { GuardiansModule } from '../guardians/guardians.module';
import { Lesson } from '../lessons/entities/lesson.entity';
import { Notification, NotificationCampaign } from '../notifications/entities';
import { areQueuesEnabled, QUEUE_CONFIGS, QUEUE_NAMES } from '../queues/queues.constants';
import { registerQueues } from '../queues/register-queues.util';
import { User } from '../users/entities/user.entity';
import { BulkOperationsController } from './bulk-operations.controller';
import { BulkOperationsService } from './bulk-operations.service';
import { BulkNotificationProcessor } from './processors/bulk-notification.processor';

@Module({
  imports: [
    forwardRef(() => AttendanceCodesModule),
    ActivityLogsModule,
    GuardiansModule,
    registerQueues({
      name: QUEUE_NAMES.BULK_NOTIFICATIONS,
      config: QUEUE_CONFIGS[QUEUE_NAMES.BULK_NOTIFICATIONS],
    }),
    registerQueues({
      name: QUEUE_NAMES.PUSH_NOTIFICATIONS,
      config: QUEUE_CONFIGS[QUEUE_NAMES.PUSH_NOTIFICATIONS],
    }),
    TypeOrmModule.forFeature([User, Lesson, Notification, NotificationCampaign]),
  ],
  controllers: [BulkOperationsController],
  providers: [BulkOperationsService, ...(areQueuesEnabled() ? [BulkNotificationProcessor] : [])],
  exports: [BulkOperationsService],
})
export class BulkOperationsModule {}
