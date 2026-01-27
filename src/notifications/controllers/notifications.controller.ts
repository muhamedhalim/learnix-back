import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { NotificationFilterDto } from '../dto';
import { NotificationsService } from '../services/notifications.service';

@ApiTags('Notifications')
@ApiBearerAuth('JWT-auth')
@Controller('notifications')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('student')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'Get my notifications (paginated)' })
  @ApiResponse({
    status: 200,
    description: 'Returns paginated list of notifications',
  })
  public async getMyNotifications(
    @GetUser() user: JwtPayload,
    @Query() filter: NotificationFilterDto,
  ): Promise<{ message: string; data: unknown[]; meta: unknown }> {
    const result = await this.notificationsService.findAllForUser(
      user.userId,
      filter,
    );
    return {
      message: 'Notifications retrieved successfully',
      ...result,
    };
  }

  @ApiResponse({
    status: 200,
    description: 'Returns unread notification count',
  })
  public async getUnreadCount(
    @GetUser() user: JwtPayload,
  ): Promise<{ message: string; data: { count: number } }> {
    const count = await this.notificationsService.getUnreadCount(user.userId);
    return {
      message: 'Unread count retrieved successfully',
      data: { count },
    };
  }

  @ApiResponse({
    status: 404,
    description: 'Notification not found',
  })
  public async markAsRead(
    @Param('id', ParseUUIDPipe) notificationId: string,
    @GetUser() user: JwtPayload,
  ): Promise<{ message: string; data: unknown }> {
    const notification = await this.notificationsService.markAsRead(
      notificationId,
      user.userId,
    );
    return {
      message: 'Notification marked as read',
      data: notification,
    };
  }

  @ApiResponse({
    status: 200,
    description: 'All notifications marked as read',
  })
  public async markAllAsRead(
    @GetUser() user: JwtPayload,
  ): Promise<{ message: string; data: unknown }> {
    const result = await this.notificationsService.markAllAsRead(user.userId);
    return {
      message: `${result.count.toString()} notifications marked as read`,
      data: result,
    };
  }
}
