import { Controller, Post, Get, Body, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { User } from '../../users/entities/user.entity';
import { UserRole } from '../../users/entities/user-role.enum';
import { NotificationTriggersService } from '../services/notification-triggers.service';
import { SmsSenderService } from '../services/sms-sender.service';
import { Notification } from '../entities';
import { ManualNotificationDto, ManualNotificationResponseDto } from '../dto';

@ApiTags('Admin - Notifications')
@ApiBearerAuth('JWT-auth')
@Controller('admin/notifications')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('admin')
export class AdminNotificationsController {
  constructor(
    private readonly notificationTriggersService: NotificationTriggersService,
    private readonly smsSenderService: SmsSenderService,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(Notification)
    private readonly notificationsRepository: Repository<Notification>,
  ) {}

  @Post('send')
  @ApiOperation({ summary: 'Send manual notification to users' })
  @ApiResponse({
    status: 201,
    description: 'Notifications sent',
    type: ManualNotificationResponseDto,
  })
  async sendManualNotification(
    @Body() dto: ManualNotificationDto,
  ): Promise<{ message: string; data: ManualNotificationResponseDto }> {
    let userIds: number[];

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
          dto.send_sms || false,
        );
        sentCount++;

        if (dto.send_sms) {
          smsSentCount++;
        }
      } catch {
        if (dto.send_sms) {
          smsFailedCount++;
        }
      }
    }

    return {
      message: `Notification sent to ${sentCount} users`,
      data: {
        sent_count: sentCount,
        sms_sent_count: smsSentCount,
        sms_failed_count: smsFailedCount,
      },
    };
  }

  @Get('statistics')
  @ApiOperation({ summary: 'Get notification statistics' })
  @ApiResponse({
    status: 200,
    description: 'Returns notification statistics',
  })
  async getStatistics() {
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
        by_type: typeStats.reduce(
          (acc, item) => {
            acc[item.type] = parseInt(item.count);
            return acc;
          },
          {} as Record<string, number>,
        ),
        last_24_hours: last24Hours,
        last_7_days: last7Days,
      },
    };
  }
}
