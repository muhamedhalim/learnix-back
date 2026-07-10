import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { ParentMessageFilterDto } from '../../notifications/dto/parent-message-filter.dto';
import { ParentMessageAdminService } from '../../notifications/services/parent-message-admin.service';
import { TeacherFollowUpService } from '../teacher-follow-up.service';

/**
 * Notification history/queue for a teacher's own students only.
 *
 * Reuses `ParentMessageAdminService` — the exact same query logic that backs
 * the admin surface — with a `scopeStudentIds` allow-list so no query param
 * can widen the result past the teacher's own roster.
 */
@ApiTags('Teacher · Parent Messages')
@Controller('teacher/parent-messages')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('teacher')
@ApiBearerAuth('JWT-auth')
export class TeacherParentMessagesController {
  constructor(
    private readonly followUp: TeacherFollowUpService,
    private readonly admin: ParentMessageAdminService,
  ) {}

  @Get()
  @ApiOperation({ summary: "List notifications sent about the teacher's own students" })
  public async list(@GetUser() user: JwtPayload, @Query() filter: ParentMessageFilterDto) {
    const scope = await this.followUp.getOwnedStudentIds(user.userId);
    return this.admin.list(filter, scope);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Delivery/read rates for the teacher\'s own students' })
  public async stats(@GetUser() user: JwtPayload) {
    const scope = await this.followUp.getOwnedStudentIds(user.userId);
    const data = await this.admin.stats(scope);
    return { data };
  }

  @Post(':id/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Retry a failed/dead notification for one of the teacher\'s own students' })
  public async retry(@GetUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    const scope = await this.followUp.getOwnedStudentIds(user.userId);
    const data = await this.admin.retry(id, scope);
    return { data };
  }
}
