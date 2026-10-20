import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { BulkOperationsService } from '../../bulk-operations/bulk-operations.service';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { biBody } from '../../i18n/error-translator.util';
import { MailService, type MailMessage } from '../../mail/mail.service';
import { areQueuesEnabled } from '../../queues/queues.constants';
import {
  AdminNotificationFilterDto,
  ManualNotificationAudience,
  ManualNotificationDto,
  ManualNotificationResponseDto,
} from '../dto';
import { Notification, NotificationCampaign, NotificationDelivery } from '../entities';
import { NotificationChannel, NotificationDeliveryStatus } from '../entities';
import { NotificationDeliveryService } from '../services/notification-delivery.service';
import { PushNotificationJobsService } from '../services/push-notification-jobs.service';
import { PushDispatchService } from '../services/push-dispatch.service';
import type {
  AdminNotificationView,
  PaginatedNotifications,
} from '../services/notifications.service';
import { NotificationsService } from '../services/notifications.service';
import { SmsSenderService } from '../services/sms-sender.service';

@ApiTags('Admin - Notifications')
@ApiBearerAuth('JWT-auth')
@Controller('admin/notifications')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('admin')
export class AdminNotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly bulkOperationsService: BulkOperationsService,
    private readonly smsSenderService: SmsSenderService,
    private readonly notificationDeliveries: NotificationDeliveryService,
    private readonly pushJobs: PushNotificationJobsService,
    private readonly pushDispatch: PushDispatchService,
    private readonly mail: MailService,
    @InjectRepository(Notification)
    private readonly notificationsRepository: Repository<Notification>,
    @InjectRepository(NotificationCampaign)
    private readonly campaignsRepository: Repository<NotificationCampaign>,
    @InjectRepository(NotificationDelivery)
    private readonly deliveriesRepository: Repository<NotificationDelivery>,
  ) {}

  @Post('manual')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiResponse({
    status: HttpStatus.ACCEPTED,
    description: 'Notification campaign durably queued',
    type: ManualNotificationResponseDto,
  })
  public async sendManualNotification(
    @GetUser() user: JwtPayload,
    @Body() dto: ManualNotificationDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<{ message: string; data: ManualNotificationResponseDto }> {
    const key = idempotencyKey?.trim();
    if (!key || key.length > 180) {
      throw new BadRequestException(
        biBody(
          'A valid Idempotency-Key header is required',
          'A valid Idempotency-Key header is required',
        ),
      );
    }
    const audience =
      dto.audience ??
      (dto.user_ids?.length
        ? ManualNotificationAudience.USER_IDS
        : ManualNotificationAudience.ALL_ACTIVE_STUDENTS);
    if (
      (audience === ManualNotificationAudience.USER_IDS && !dto.user_ids?.length) ||
      (audience === ManualNotificationAudience.ALL_ACTIVE_STUDENTS && dto.user_ids?.length)
    ) {
      throw new BadRequestException(
        biBody(
          'The selected audience does not match user_ids',
          'The selected audience does not match user_ids',
        ),
      );
    }

    const result = await this.bulkOperationsService.sendBulkNotifications(
      {
        title: dto.title,
        message: dto.message,
        ...(dto.title_ar === undefined ? {} : { title_ar: dto.title_ar }),
        ...(dto.message_ar === undefined ? {} : { message_ar: dto.message_ar }),
        filter: dto.user_ids?.length ? { student_ids: dto.user_ids } : {},
      },
      user.userId,
      key,
    );

    return {
      message: `Notification campaign queued for ${result.total_queued.toString()} users`,
      data: {
        campaign_id: result.campaign_id,
        intended_count: result.total_queued,
        status: result.status,
      },
    };
  }

  @Get()
  @ApiResponse({
    status: 200,
    description: 'Paginated list of all in-app notifications across users',
  })
  public async findAll(
    @Query() filter: AdminNotificationFilterDto,
  ): Promise<PaginatedNotifications<AdminNotificationView>> {
    return await this.notificationsService.findAllAdmin(filter);
  }

  @Get('stats')
  @ApiResponse({
    status: 200,
    description: 'Returns notification statistics',
  })
  public async getStatistics(): Promise<{ message: string; data: unknown }> {
    const totalNotifications = await this.notificationsRepository.count();
    const readNotifications = await this.notificationsRepository.count({
      where: { is_read: true },
    });
    const smsSent = await this.notificationsRepository.count({
      where: { sms_sent: true },
    });

    // Count by type
    interface TypeStatRaw {
      type: string;
      count: string;
    }
    const typeStats = await this.notificationsRepository
      .createQueryBuilder('notification')
      .select('notification.type', 'type')
      .addSelect('COUNT(*)', 'count')
      .groupBy('notification.type')
      .getRawMany<TypeStatRaw>();

    // Notifications in last 24 hours
    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);

    const last24Hours = await this.notificationsRepository
      .createQueryBuilder('notification')
      .where('notification.sent_at >= :date', { date: oneDayAgo })
      .getCount();

    // Notifications in last 7 days
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const last7Days = await this.notificationsRepository
      .createQueryBuilder('notification')
      .where('notification.sent_at >= :date', { date: sevenDaysAgo })
      .getCount();

    const [campaignStats, deliveryStats, needsAttention] = await Promise.all([
      this.campaignsRepository
        .createQueryBuilder('campaign')
        .select('campaign.status', 'status')
        .addSelect('COUNT(*)', 'count')
        .groupBy('campaign.status')
        .getRawMany<{ status: string; count: string }>(),
      this.deliveriesRepository
        .createQueryBuilder('delivery')
        .select('delivery.status', 'status')
        .addSelect('COUNT(*)', 'count')
        .groupBy('delivery.status')
        .getRawMany<{ status: string; count: string }>(),
      this.deliveriesRepository.count({
        where: [
          { status: NotificationDeliveryStatus.FAILED },
          { status: NotificationDeliveryStatus.PROVIDER_UNAVAILABLE },
        ],
      }),
    ]);
    const pushReadiness = this.pushDispatch.readiness();

    return {
      message: 'Notification statistics retrieved',
      data: {
        total_notifications: totalNotifications,
        read_notifications: readNotifications,
        unread_notifications: totalNotifications - readNotifications,
        read_rate:
          totalNotifications > 0 ? Math.round((readNotifications / totalNotifications) * 100) : 0,
        sms_sent: smsSent,
        sms_enabled: this.smsSenderService.isConfigured(),
        by_type: typeStats.reduce<Record<string, number>>((acc, item) => {
          acc[item.type] = Number.parseInt(item.count);
          return acc;
        }, {}),
        last_24_hours: last24Hours,
        last_7_days: last7Days,
        campaigns: campaignStats.reduce<Record<string, number>>((acc, item) => {
          acc[item.status] = Number.parseInt(item.count, 10);
          return acc;
        }, {}),
        deliveries: deliveryStats.reduce<Record<string, number>>((acc, item) => {
          acc[item.status] = Number.parseInt(item.count, 10);
          return acc;
        }, {}),
        needs_attention: needsAttention,
        readiness: {
          queues: areQueuesEnabled(),
          push: pushReadiness.configured,
          push_provider: pushReadiness.provider,
          email: this.mail.isConfigured(),
          sms: this.smsSenderService.isConfigured(),
        },
      },
    };
  }

  @Get('campaigns')
  public async listCampaigns(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<unknown> {
    return await this.bulkOperationsService.listNotificationCampaigns(
      Number.parseInt(page ?? '1', 10),
      Number.parseInt(limit ?? '20', 10),
    );
  }

  @Get('campaigns/:campaignId')
  public async getCampaign(
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
  ): Promise<{ data: unknown }> {
    return { data: await this.bulkOperationsService.getNotificationCampaign(campaignId) };
  }

  @Post('deliveries/:deliveryId/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  public async retryDelivery(
    @Param('deliveryId', ParseUUIDPipe) deliveryId: string,
  ): Promise<{ message: string; data: unknown }> {
    const delivery = await this.notificationDeliveries.findOne(deliveryId);
    if (!delivery) {
      throw new BadRequestException(biBody('Delivery not found', 'Delivery not found'));
    }
    if (
      ![
        NotificationDeliveryStatus.FAILED,
        NotificationDeliveryStatus.PROVIDER_UNAVAILABLE,
      ].includes(delivery.status)
    ) {
      throw new BadRequestException(
        biBody(
          'Only failed or unavailable deliveries can be retried here',
          'Only failed or unavailable deliveries can be retried here',
        ),
      );
    }
    if (delivery.channel === NotificationChannel.PUSH) {
      await this.notificationDeliveries.record(delivery.id, NotificationDeliveryStatus.QUEUED, {
        provider: delivery.provider ?? 'fcm',
      });
      try {
        await this.pushJobs.enqueueDelivery(delivery.notification_id, {
          forceNewJob: true,
          retryDeliveryId: delivery.id,
        });
      } catch (error) {
        await this.notificationDeliveries.record(delivery.id, NotificationDeliveryStatus.FAILED, {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    } else if (delivery.channel === NotificationChannel.EMAIL) {
      if (!delivery.request_payload) {
        throw new BadRequestException(
          biBody(
            'This historical email has no replay payload',
            'This historical email has no replay payload',
          ),
        );
      }
      const payload = delivery.request_payload;
      if (typeof payload['to'] !== 'string' || payload['to'].trim() === '') {
        throw new BadRequestException(
          biBody('Email replay payload is invalid', 'Email replay payload is invalid'),
        );
      }
      const replay: MailMessage = {
        to: payload['to'],
        ...(typeof payload['recipientName'] === 'string'
          ? { recipientName: payload['recipientName'] }
          : {}),
        ...(typeof payload['subject'] === 'string' ? { subject: payload['subject'] } : {}),
        ...(typeof payload['html'] === 'string' ? { html: payload['html'] } : {}),
        ...(typeof payload['text'] === 'string' ? { text: payload['text'] } : {}),
      };
      if (
        replay.subject === undefined ||
        (replay.html === undefined && replay.text === undefined)
      ) {
        // Payloads recorded for a removed remote-template provider carry no rendered content.
        throw new BadRequestException(
          biBody(
            'This historical email has no rendered subject and body to replay',
            'This historical email has no rendered subject and body to replay',
          ),
        );
      }
      const queued = await this.mail.send({
        ...replay,
        notificationDeliveryId: delivery.id,
      });
      if (!queued) {
        throw new BadRequestException(
          biBody(
            'Email queue or provider is unavailable',
            'Email queue or provider is unavailable',
          ),
        );
      }
      await this.notificationDeliveries.record(delivery.id, NotificationDeliveryStatus.QUEUED, {
        provider: this.mail.providerName,
      });
    } else {
      throw new BadRequestException(
        biBody('This channel cannot be retried here', 'This channel cannot be retried here'),
      );
    }
    return {
      message: `${delivery.channel} delivery retry queued`,
      data: { delivery_id: delivery.id, notification_id: delivery.notification_id },
    };
  }

  @Get(':notificationId')
  @ApiOperation({
    summary: 'Get notification details',
    description:
      'Returns detailed information about a specific notification including status, attempts, and error messages.',
  })
  @ApiParam({
    name: 'notificationId',
    description: 'Notification UUID',
    type: String,
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Notification details',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Notification not found',
  })
  public async getNotificationDetails(
    @Param('notificationId', ParseUUIDPipe) notificationId: string,
  ): Promise<{ data: unknown }> {
    const details = await this.notificationsService.getNotificationDetails(notificationId);
    return { data: details };
  }

  @Post(':notificationId/retry')
  @ApiOperation({
    summary: 'Retry a failed notification',
    description: 'Deprecated: retry a specific failed delivery leg instead.',
    deprecated: true,
  })
  @ApiParam({
    name: 'notificationId',
    description: 'Notification UUID',
    type: String,
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Notification retry initiated',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Notification not found',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Notification is not in failed status',
  })
  public async retryNotification(
    @Param('notificationId', ParseUUIDPipe) _notificationId: string,
  ): Promise<{ message: string; data: unknown }> {
    throw new BadRequestException(
      biBody(
        'Top-level retry is deprecated; retry a failed delivery leg',
        'Top-level retry is deprecated; retry a failed delivery leg',
      ),
    );
  }
}
