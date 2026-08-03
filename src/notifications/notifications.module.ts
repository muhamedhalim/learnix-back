import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { GuardiansModule } from '../guardians/guardians.module';
import { areQueuesEnabled, QUEUE_CONFIGS, QUEUE_NAMES } from '../queues/queues.constants';
import { registerQueues } from '../queues/register-queues.util';
import { User } from '../users/entities/user.entity';
import { ChannelRegistryService } from './channels/channel-registry.service';
import { SmsChannel } from './channels/sms.channel';
import { WhatsAppMetaChannel } from './channels/whatsapp-meta.channel';
import {
  AdminNotificationsController,
  NotificationsController,
  NotificationSettingsController,
} from './controllers';
import { AdminParentMessagesController } from './controllers/admin-parent-messages.controller';
import { WhatsAppWebhookController } from './controllers/whatsapp-webhook.controller';
import { Notification, NotificationSettings, ParentMessage } from './entities';
import { ParentNotificationListener } from './listeners/parent-notification.listener';
import { PurchaseParentNotificationListener } from './listeners/purchase-parent-notification.listener';
import { Order } from '../payments/entities/order.entity';
import { ParentNotificationProcessor } from './processors/parent-notification.processor';
import {
  NotificationsService,
  NotificationTriggersService,
  SmsSenderService,
} from './services';
import { ParentMessageAdminService } from './services/parent-message-admin.service';
import { ParentMessageService } from './services/parent-message.service';
import { ParentNotificationJobsService } from './services/parent-notification-jobs.service';
import { TemplateRendererService } from './templates/template-renderer.service';

/**
 * Notifications: in-app records, plus the guardian delivery pipeline.
 *
 * The pipeline is strictly one-directional:
 *
 *   domain event → listener (enqueue only) → BullMQ → worker
 *     → guardians (who) → renderer (what) → channel (how) → parent_messages (proof)
 *
 * Nothing upstream of the worker knows a provider exists, and the worker never
 * decides policy — eligibility lives in `GuardiansService`, wording in the
 * template catalogue, transport preference in `ChannelRegistryService`.
 */
@Module({
  imports: [
    ConfigModule,
    GuardiansModule,
    // The Meta Cloud API adapter is the only HTTP consumer here.
    HttpModule,
    // NoopQueue-backed when Redis isn't configured in development.
    registerQueues(
      {
        name: QUEUE_NAMES.PARENT_NOTIFICATIONS,
        config: QUEUE_CONFIGS[QUEUE_NAMES.PARENT_NOTIFICATIONS],
      },
      {
        name: QUEUE_NAMES.PARENT_NOTIFICATIONS_DLQ,
        config: QUEUE_CONFIGS[QUEUE_NAMES.PARENT_NOTIFICATIONS_DLQ],
      },
    ),
    TypeOrmModule.forFeature([Notification, NotificationSettings, ParentMessage, User, Order]),
  ],
  controllers: [
    AdminNotificationsController,
    AdminParentMessagesController,
    NotificationsController,
    NotificationSettingsController,
    WhatsAppWebhookController,
  ],
  providers: [
    NotificationsService,
    NotificationTriggersService,
    SmsSenderService,

    // Guardian pipeline
    TemplateRendererService,
    WhatsAppMetaChannel,
    SmsChannel,
    ChannelRegistryService,
    ParentMessageService,
    ParentMessageAdminService,
    ParentNotificationJobsService,
    ParentNotificationListener,
    PurchaseParentNotificationListener,
    // The worker needs a real queue connection to pull jobs from; skip it
    // entirely when queues are disabled rather than let it attempt one.
    ...(areQueuesEnabled() ? [ParentNotificationProcessor] : []),
  ],
  exports: [
    NotificationsService,
    NotificationTriggersService,
    SmsSenderService,
    ParentMessageService,
    ParentMessageAdminService,
    ParentNotificationJobsService,
  ],
})
export class NotificationsModule {}
