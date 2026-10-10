import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { RegisterPushDeviceDto, UnregisterPushDeviceDto } from '../dto';
import { PushProviderName } from '../entities';
import { PUSH_PROVIDER, type PushProvider } from '../push/push-provider.interface';
import { WebPushProvider } from '../push/web-push.provider';
import { PushDeviceService, type PushDeviceView } from '../services/push-device.service';

/**
 * Push device registration.
 *
 * AUTHORIZATION. `HybridAuthGuard` alone — no `@Roles`. Every handler derives
 * the owner from `@GetUser()`, and every service call is scoped by that id, so:
 *
 *  - a user cannot register a token against another account (no target user id
 *    exists in the DTO);
 *  - a user cannot revoke another account's device (the `user_id` predicate is
 *    part of the lookup, so a foreign row is simply not found → 404);
 *  - the endpoints are unavailable to anonymous callers.
 *
 * Deliberately not `@Roles('student')`: a device belongs to a *user*. Teachers
 * and administrators receive in-app notifications too, and the storage model
 * must not have to change the day one of those surfaces gains a push toggle.
 * Delivery remains gated on `push_enabled` regardless of who registered.
 *
 * Registration tokens are write-only over this API: `PushDeviceView` never
 * contains one, so a stolen access token cannot be turned into the ability to
 * push to that user's handsets from outside Learnix.
 */
@ApiTags('Notifications · Push devices')
@ApiBearerAuth('JWT-auth')
@Controller('notifications/push/devices')
@UseGuards(HybridAuthGuard)
export class PushDevicesController {
  constructor(
    private readonly devices: PushDeviceService,
    @Inject(PUSH_PROVIDER) private readonly provider: PushProvider,
    private readonly web: WebPushProvider,
  ) {}

  @Get('public-key')
  @ApiOperation({
    summary: 'VAPID public key browsers need to subscribe to Web Push',
    description: 'Null when Web Push is not the active push provider.',
  })
  public publicKey(): { data: { public_key: string | null; provider: string } } {
    const active = this.provider.name === 'webpush' && this.web.isConfigured();
    return { data: { public_key: active ? this.web.publicKey : null, provider: this.provider.name } };
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Register or refresh this client as a push device',
    description:
      'Idempotent upsert. Re-posting the same token refreshes it; posting a new ' +
      'token with a known device_id rotates that device in place. A user may hold ' +
      'many devices and registering one never disturbs the others.',
  })
  @ApiResponse({ status: 200, description: 'Device registered' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  public async register(
    @GetUser() user: JwtPayload,
    @Body() dto: RegisterPushDeviceDto,
  ): Promise<{ message: string; data: PushDeviceView }> {
    const device = await this.devices.register({
      userId: user.userId,
      token: dto.token,
      ...(dto.platform === undefined ? {} : { platform: dto.platform }),
      ...(dto.provider === undefined ? {} : { provider: dto.provider }),
      ...(dto.device_id === undefined ? {} : { deviceId: dto.device_id }),
      ...(dto.device_label === undefined ? {} : { deviceLabel: dto.device_label }),
    });

    return {
      message: 'Push device registered successfully',
      data: PushDeviceService.toView(device),
    };
  }

  @Get()
  @ApiOperation({ summary: 'List my push devices (registration tokens excluded)' })
  @ApiResponse({ status: 200, description: 'Returns the caller-owned devices' })
  public async list(
    @GetUser() user: JwtPayload,
  ): Promise<{ message: string; data: PushDeviceView[] }> {
    return {
      message: 'Push devices retrieved successfully',
      data: await this.devices.listForUser(user.userId),
    };
  }

  @Post('unregister')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Revoke this client by token',
    description:
      'The shape logout needs: the client holds its own token but not the server ' +
      'row id. Scoped to the caller, so it can only ever revoke their own device.',
  })
  @ApiResponse({ status: 200, description: 'Device revoked, or nothing was registered' })
  public async unregister(
    @GetUser() user: JwtPayload,
    @Body() dto: UnregisterPushDeviceDto,
  ): Promise<{ message: string; data: { revoked: boolean } }> {
    const revoked = await this.devices.revokeByToken(
      user.userId,
      dto.token,
      dto.provider ?? PushProviderName.FCM,
    );
    return {
      message: revoked ? 'Push device revoked successfully' : 'No matching push device',
      data: { revoked },
    };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke one of my push devices by id' })
  @ApiResponse({ status: 200, description: 'Device revoked' })
  @ApiResponse({ status: 404, description: 'No such device for this user' })
  public async remove(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) deviceRowId: string,
  ): Promise<{ message: string }> {
    await this.devices.revokeById(user.userId, deviceRowId);
    return { message: 'Push device revoked successfully' };
  }
}
