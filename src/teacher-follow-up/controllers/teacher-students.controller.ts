import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { SendStudentMessageDto, TeacherStudentFilterDto } from '../dto';
import { TeacherFollowUpService } from '../teacher-follow-up.service';
import { TeacherTimelineService } from '../teacher-timeline.service';

/**
 * Read-only student roster for the teacher's own "Parents & Follow-up"
 * workspace. Ownership is always transitive through a purchased lesson or
 * package — see `TeacherFollowUpService.assertOwnsStudent` — so a teacher can
 * never enumerate or look up a student who never bought anything from them.
 */
@ApiTags('Teacher · Students')
@Controller('teacher/students')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('teacher')
@ApiBearerAuth('JWT-auth')
export class TeacherStudentsController {
  constructor(
    private readonly followUp: TeacherFollowUpService,
    private readonly timeline: TeacherTimelineService,
  ) {}

  @Get()
  @ApiOperation({ summary: "List students enrolled in the teacher's own lessons/packages" })
  public async list(@GetUser() user: JwtPayload, @Query() filter: TeacherStudentFilterDto) {
    const result = await this.followUp.getRoster(user.userId, filter);
    return {
      data: result.data,
      meta: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: Math.ceil(result.total / result.limit),
      },
    };
  }

  @Get(':studentId')
  @ApiOperation({ summary: 'Guardian, attendance, exam, and risk summary for one student' })
  public async detail(
    @GetUser() user: JwtPayload,
    @Param('studentId', ParseUUIDPipe) studentId: string,
  ) {
    const data = await this.followUp.getStudentSummary(user.userId, studentId);
    return { data };
  }

  @Post(':studentId/message')
  @ApiOperation({ summary: "Send an in-app message to one of the teacher's students" })
  public async sendMessage(
    @GetUser() user: JwtPayload,
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Body() dto: SendStudentMessageDto,
  ) {
    return this.followUp.sendStudentMessage(user.userId, studentId, dto.message, dto.title);
  }

  @Get(':studentId/timeline')
  @ApiOperation({
    summary: 'Chronological feed: exam lifecycle, attendance, and notification delivery',
  })
  public async timelineFor(
    @GetUser() user: JwtPayload,
    @Param('studentId', ParseUUIDPipe) studentId: string,
  ) {
    const data = await this.timeline.getTimeline(user.userId, studentId);
    return { data };
  }
}
