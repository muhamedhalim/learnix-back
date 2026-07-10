import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { TeacherBroadcastDto } from '../dto';
import { TeacherBroadcastService } from '../teacher-broadcast.service';

/**
 * Manual guardian messages a teacher sends about a whole class, that
 * class's absentees, or students with low grades. Always goes through the
 * same event → queue → channel pipeline as every automatic notification —
 * there is no separate "send now" HTTP call to a provider.
 */
@ApiTags('Teacher · Parent Broadcast')
@Controller('teacher/parent-broadcast')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('teacher')
@ApiBearerAuth('JWT-auth')
export class TeacherBroadcastController {
  constructor(private readonly broadcast: TeacherBroadcastService) {}

  @Post('preview')
  @ApiOperation({ summary: 'Preview who will receive a broadcast before sending it' })
  public async preview(@GetUser() user: JwtPayload, @Body() dto: TeacherBroadcastDto) {
    const data = await this.broadcast.preview(user.userId, dto);
    return { data };
  }

  @Post('send')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Send the broadcast to every reachable guardian in scope' })
  public async send(@GetUser() user: JwtPayload, @Body() dto: TeacherBroadcastDto) {
    const data = await this.broadcast.send(user.userId, dto);
    return { data };
  }
}
