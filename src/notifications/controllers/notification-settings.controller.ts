import { Controller, Get, Put, Body, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { JwtPayload } from '../../common/interfaces/user-request.interface';
import { NotificationsService } from '../services/notifications.service';
import { UpdateNotificationSettingsDto } from '../dto';

@ApiTags('Notification Settings')
@ApiBearerAuth('JWT-auth')
@Controller('notification-settings')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('student')
export class NotificationSettingsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'Get my notification settings' })
  @ApiResponse({
    status: 200,
    description: 'Returns notification settings',
  })
  async getSettings(@GetUser() user: JwtPayload) {
    const settings = await this.notificationsService.getOrCreateSettings(
      user.userId,
    );
    return {
      message: 'Notification settings retrieved successfully',
      data: settings,
    };
  }

  @Put()
  @ApiOperation({ summary: 'Update my notification settings' })
  @ApiResponse({
    status: 200,
    description: 'Notification settings updated',
  })
  async updateSettings(
    @GetUser() user: JwtPayload,
    @Body() dto: UpdateNotificationSettingsDto,
  ) {
    const settings = await this.notificationsService.updateSettings(
      user.userId,
      dto,
    );
    return {
      message: 'Notification settings updated successfully',
      data: settings,
    };
  }
}
