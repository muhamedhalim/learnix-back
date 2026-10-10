import { HttpModule } from '@nestjs/axios';
import { forwardRef, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { GuardiansModule } from '../guardians/guardians.module';
import { BulkOperationsModule } from '../bulk-operations/bulk-operations.module';
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
  PushDevicesController,
} from './controllers';
import { AdminParentMessagesController } from './controllers/admin-parent-messages.controller';
import { WhatsAppWebhookController } from './controllers/whatsapp-webhook.controller';
import {
  Notification,
  NotificationCampaign,
  NotificationDelivery,
  NotificationSettings,
  ParentMessage,
  PushDevice,
} from './entities';
import { AdminAlertsListener } from './listeners/admin-alerts.listener';
import { ParentNotificationListener } from './listeners/parent-notification.listener';
import { PurchaseParentNotificationListener } from './listeners/purchase-parent-notification.listener';
import { Order } from '../payments/entities/order.entity';
import { ParentNotificationProcessor } from './processors/parent-notification.processor';
import { PushNotificationProcessor } from './processors/push-notification.processor';
import { ConfigService } from '@nestjs/config';
import { FirebasePushProvider } from './push/firebase-push.provider';
import { WebPushProvider } from './push/web-push.provider';
import { PUSH_PROVIDER } from './push/push-provider.interface';
import {
  AdminNotificationsService,
  NotificationChannelPolicyService,
  NotificationDeliveryService,
  NotificationDispatchRecoveryService,
  NotificationEmailService,
  NotificationsService,
  NotificationTriggersService,
  PushDeviceService,
  PushDispatchService,
  PushNotificationJobsService,
  SmsSenderService,
} from './services';
import { ParentMessageAdminService } from './services/parent-message-admin.service';
import { SmsEventsConsumer } from './services/sms-events.consumer';
import { ParentMessageService } from './services/parent-message.service';
import { ParentNotificationJobsService } from './services/parent-notification-jobs.service';
import { TemplateRendererService } from './templates/template-renderer.service';

/**
 * Notifications: in-app records, the guardian delivery pipeline, and the user
 * push pipeline.
 *
 * Both pipelines are strictly one-directional and share one policy chokepoint:
 *
 *   domain event → listener (enqueue only) → BullMQ → worker
 *     → who (guardians / push devices)
 *     → may we (NotificationChannelPolicyService)
 *     → what (renderer / notification row)
 *     → how (ParentChannel / PushProvider)
 *     → proof (parent_messages / notification_deliveries)
 *
 * Nothing upstream of a worker knows a provider exists, and no worker decides
 * policy: guardian *event* eligibility lives in `GuardiansService`, *channel*
 * eligibility in `NotificationChannelPolicyService`, wording in the template
 * catalogue, transport choice in `ChannelRegistryService` / `PUSH_PROVIDER`.
 *
 * `PUSH_PROVIDER` is bound to `FirebasePushProvider` here and nowhere else.
 * That single binding is the entire Firebase surface of the notification
 * domain — business code depends on the `PushProvider` interface, so replacing
 * FCM means changing this one line.
 */
@Module({
  imports: [
    ConfigModule,
    forwardRef(() => BulkOperationsModule),
    GuardiansModule,
    // The Meta Cloud API adapter is the only HTTP consumer here.
    HttpModule,
    // NoopQueue-backed when Redis isn't configured in development. Push falls
    // back to inline dispatch in that case — see PushNotificationJobsService.
    registerQueues(
      {
        name: QUEUE_NAMES.PARENT_NOTIFICATIONS,
        config: QUEUE_CONFIGS[QUEUE_NAMES.PARENT_NOTIFICATIONS],
      },
      {
        name: QUEUE_NAMES.PARENT_NOTIFICATIONS_DLQ,
        config: QUEUE_CONFIGS[QUEUE_NAMES.PARENT_NOTIFICATIONS_DLQ],
      },
      {
        name: QUEUE_NAMES.PUSH_NOTIFICATIONS,
        config: QUEUE_CONFIGS[QUEUE_NAMES.PUSH_NOTIFICATIONS],
      },
    ),
    TypeOrmModule.forFeature([
      Notification,
      NotificationCampaign,
      NotificationDelivery,
      NotificationSettings,
      ParentMessage,
      PushDevice,
      User,
      Order,
    ]),
  ],
  controllers: [
    AdminNotificationsController,
    AdminParentMessagesController,
    NotificationsController,
    NotificationSettingsController,
    PushDevicesController,
    WhatsAppWebhookController,
  ],
  providers: [
    NotificationsService,
    NotificationTriggersService,
    AdminNotificationsService,
    AdminAlertsListener,
    SmsSenderService,
    SmsEventsConsumer,

    // Preference policy + delivery ledger (shared by every channel)
    NotificationChannelPolicyService,
    NotificationDeliveryService,
    NotificationEmailService,

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

    // Push pipeline
    FirebasePushProvider,
    WebPushProvider,
    {
      // PUSH_PROVIDER=webpush selects standard Web Push; anything else keeps FCM (historic default).
      provide: PUSH_PROVIDER,
      inject: [ConfigService, FirebasePushProvider, WebPushProvider],
      useFactory: (config: ConfigService, fcm: FirebasePushProvider, web: WebPushProvider) =>
        config.get<string>('PUSH_PROVIDER')?.trim().toLowerCase() === 'webpush' ? web : fcm,
    },
    PushDeviceService,
    PushDispatchService,
    PushNotificationJobsService,
    NotificationDispatchRecoveryService,

    // The workers need a real queue connection to pull jobs from; skip them
    // entirely when queues are disabled rather than let them attempt one.
    ...(areQueuesEnabled() ? [ParentNotificationProcessor, PushNotificationProcessor] : []),
  ],
  exports: [
    NotificationsService,
    NotificationTriggersService,
    AdminNotificationsService,
    NotificationChannelPolicyService,
    NotificationDeliveryService,
    NotificationEmailService,
    SmsSenderService,
    ParentMessageService,
    ParentMessageAdminService,
    ParentNotificationJobsService,
    PushDeviceService,
    PushDispatchService,
    PushNotificationJobsService,
  ],
})
export class NotificationsModule {}
