import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiTags } from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { UpdateNotificationSettingsDto } from '../dto';
import { NotificationsService } from '../services/notifications.service';

@ApiTags('Notification Settings')
@ApiBearerAuth('JWT-auth')
@Controller('notification-settings')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('student')
export class NotificationSettingsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  @ApiResponse({
    status: 200,
    description: 'Returns notification settings',
  })
  public async getSettings(
    @GetUser() user: JwtPayload,
  ): Promise<{ message: string; data: unknown }> {
    const settings = await this.notificationsService.getOrCreateSettings(
      user.userId,
    );
    return {
      message: 'Notification settings retrieved successfully',
      data: settings,
    };
  }

  @Put()
  @ApiResponse({
    status: 200,
    description: 'Notification settings updated',
  })
  public async updateSettings(
    @GetUser() user: JwtPayload,
    @Body() dto: UpdateNotificationSettingsDto,
  ): Promise<{ message: string; data: unknown }> {
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
