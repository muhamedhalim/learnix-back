import {
  Body,
  Controller,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import type { Request } from 'express';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { getClientIp } from '../../common/utils/client-ip.util';
import { AttendanceService } from '../attendance.service';
import { UpdateSessionDto } from '../dto';

@ApiTags('Lesson Sessions')
@Controller('lessons')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('student')
@ApiBearerAuth('JWT-auth')
export class SessionController {
  constructor(private readonly attendanceService: AttendanceService) {}

  /**
   * Enter a lesson (start session tracking)
   */
  @Post(':id/enter')
  @ApiOperation({ summary: 'Start a lesson tracking session' })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Lesson not found',
  })
  public async enterLesson(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) lessonId: string,
    @Req() request: Request,
  ): Promise<{ message: string; data: unknown }> {
    const ipAddress = getClientIp(request);
    const deviceInfo = request.headers['user-agent'] ?? null;

    const session = await this.attendanceService.enterLesson(
      user.userId,
      lessonId,
      ipAddress ?? undefined,
      deviceInfo ?? undefined,
    );

    return {
      message: 'Session started',
      data: session,
    };
  }

  /**
   * Exit a lesson (end session tracking)
   * Triggers auto-attendance if 80%+ video watched
   */
  @Post(':id/exit')
  @ApiOperation({ summary: 'End a lesson tracking session' })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Active session not found',
  })
  public async exitLesson(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) lessonId: string,
    @Body() dto: UpdateSessionDto,
  ): Promise<{
    message: string;
    data?: unknown;
    session?: unknown;
    auto_attendance?: boolean;
  }> {
    // Find active session
    const activeSession = await this.attendanceService.findActiveSession(user.userId, lessonId);

    if (!activeSession) {
      return {
        message: 'No active session found',
        session: null,
      };
    }

    const result = await this.attendanceService.exitLesson(
      activeSession.id,
      dto.video_progress_percent ?? 0,
      dto.duration_seconds ?? 0,
    );

    return {
      message: result.auto_attendance
        ? 'Session ended. Attendance auto-marked as present (80%+ completion)'
        : 'Session ended',
      data: result.session,
      auto_attendance: result.auto_attendance,
    };
  }

  /**
   * Update session progress (during playback)
   */
  @Patch('sessions/:sessionId/progress')
  @ApiOperation({ summary: 'Update session progress (during playback)' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Progress updated',
  })
  public async updateProgress(
    @GetUser() user: JwtPayload,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() dto: UpdateSessionDto,
  ): Promise<{ message: string; data: unknown }> {
    const session = await this.attendanceService.updateSessionProgress(
      sessionId,
      user.userId,
      dto.video_progress_percent ?? 0,
    );

    return {
      message: 'Progress updated',
      data: session,
    };
  }
}
