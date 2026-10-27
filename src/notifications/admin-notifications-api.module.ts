import { Module } from '@nestjs/common';

import { BulkOperationsModule } from '../bulk-operations/bulk-operations.module';
import { AdminNotificationsController } from './controllers';
import { NotificationsModule } from './notifications.module';

/**
 * Hosts the admin notifications API. It is the one place that needs both the notification
 * services and the bulk-campaign service (`manual`, `campaigns`), so it sits above both modules.
 * Registering this controller inside `NotificationsModule` made notifications depend on
 * `BulkOperationsModule`, which closed the Payments → Notifications → BulkOperations →
 * AttendanceCodes → Payments cycle. Routes, guards and handler order are unchanged — the whole
 * controller moved as one unit.
 */
@Module({
  imports: [NotificationsModule, BulkOperationsModule],
  controllers: [AdminNotificationsController],
})
export class AdminNotificationsApiModule {}
