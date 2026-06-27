import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { User } from '../../users/entities/user.entity';
import { UserRole } from '../../users/entities/user-role.enum';
import { ManualNotificationDto, ManualNotificationResponseDto } from '../dto';
import { Notification } from '../entities';
import { NotificationTriggersService } from '../services/notification-triggers.service';
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
    private readonly notificationTriggersService: NotificationTriggersService,
    private readonly smsSenderService: SmsSenderService,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(Notification)
    private readonly notificationsRepository: Repository<Notification>,
  ) {}

  @Post('manual')
  @ApiResponse({
    status: 201,
    description: 'Notifications sent',
    type: ManualNotificationResponseDto,
  })
  public async sendManualNotification(
    @Body() dto: ManualNotificationDto,
  ): Promise<{ message: string; data: ManualNotificationResponseDto }> {
    let userIds: string[];

    if (dto.user_ids && dto.user_ids.length > 0) {
      // Send to specific users
      userIds = dto.user_ids;
    } else {
      // Send to all active students
      const students = await this.usersRepository.find({
        where: {
          role: UserRole.STUDENT,
          is_active: true,
        },
        select: ['id'],
      });
      userIds = students.map((s) => s.id);
    }

    let sentCount = 0;
    let smsSentCount = 0;
    let smsFailedCount = 0;

    // Send notifications to each user
    for (const userId of userIds) {
      try {
        await this.notificationTriggersService.sendCustomNotification(
          userId,
          dto.title,
          dto.message,
          dto.send_sms ?? false,
        );
        sentCount++;

        if (dto.send_sms === true) {
          smsSentCount++;
        }
      } catch {
        if (dto.send_sms === true) {
          smsFailedCount++;
        }
      }
    }

    return {
      message: `Notification sent to ${sentCount.toString()} users`,
      data: {
        sent_count: sentCount,
        sms_sent_count: smsSentCount,
        sms_failed_count: smsFailedCount,
      },
    };
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

    return {
      message: 'Notification statistics retrieved',
      data: {
        total_notifications: totalNotifications,
        read_notifications: readNotifications,
        unread_notifications: totalNotifications - readNotifications,
        read_rate:
          totalNotifications > 0
            ? Math.round((readNotifications / totalNotifications) * 100)
            : 0,
        sms_sent: smsSent,
        sms_enabled: this.smsSenderService.isConfigured(),
        by_type: typeStats.reduce<Record<string, number>>((acc, item) => {
          acc[item.type] = Number.parseInt(item.count);
          return acc;
        }, {}),
        last_24_hours: last24Hours,
        last_7_days: last7Days,
      },
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
    const details =
      await this.notificationsService.getNotificationDetails(notificationId);
    return { data: details };
  }

  @Post(':notificationId/retry')
  @ApiOperation({
    summary: 'Retry a failed notification',
    description:
      'Retries sending a failed notification. Only notifications with status "failed" can be retried.',
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
    @Param('notificationId', ParseUUIDPipe) notificationId: string,
  ): Promise<{ message: string; data: unknown }> {
    const notification =
      await this.notificationsService.retryNotification(notificationId);
    return {
      message: 'Notification retry initiated',
      data: {
        id: notification.id,
        status: notification.status,
        attempts: notification.attempts,
        sms_sent: notification.sms_sent,
        error_message: notification.error_message,
      },
    };
  }
}
