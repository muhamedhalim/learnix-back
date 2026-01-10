import {
  Controller,
  Get,
  Put,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { JwtPayload } from '../../common/interfaces/user-request.interface';
import { NotificationsService } from '../services/notifications.service';
import { NotificationFilterDto } from '../dto';

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
  async getMyNotifications(
    @GetUser() user: JwtPayload,
    @Query() filter: NotificationFilterDto,
  ) {
    const result = await this.notificationsService.findAllForUser(
      user.userId,
      filter,
    );
    return {
      message: 'Notifications retrieved successfully',
      ...result,
    };
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Get count of unread notifications' })
  @ApiResponse({
    status: 200,
    description: 'Returns unread notification count',
  })
  async getUnreadCount(@GetUser() user: JwtPayload) {
    const count = await this.notificationsService.getUnreadCount(user.userId);
    return {
      message: 'Unread count retrieved successfully',
      data: { count },
    };
  }

  @Put(':id/mark-read')
  @ApiOperation({ summary: 'Mark a notification as read' })
  @ApiParam({ name: 'id', description: 'Notification ID' })
  @ApiResponse({
    status: 200,
    description: 'Notification marked as read',
  })
  @ApiResponse({
    status: 404,
    description: 'Notification not found',
  })
  async markAsRead(
    @Param('id', ParseUUIDPipe) notificationId: string,
    @GetUser() user: JwtPayload,
  ) {
    const notification = await this.notificationsService.markAsRead(
      notificationId,
      user.userId,
    );
    return {
      message: 'Notification marked as read',
      data: notification,
    };
  }

  @Put('mark-all-read')
  @ApiOperation({ summary: 'Mark all notifications as read' })
  @ApiResponse({
    status: 200,
    description: 'All notifications marked as read',
  })
  async markAllAsRead(@GetUser() user: JwtPayload) {
    const result = await this.notificationsService.markAllAsRead(user.userId);
    return {
      message: `${result.count} notifications marked as read`,
      data: result,
    };
  }
}
