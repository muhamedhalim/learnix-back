import {
  Body,
  Controller,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
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
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Lesson not found',
  })
  public async enterLesson(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) lessonId: string,
    @Req() request: Request,
  ): Promise<{ message: string; data: unknown }> {
    const ipAddress =
      (request.headers['x-forwarded-for'] as string).split(',')[0] ??
      request.ip ??
      null;
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
    const activeSession = await this.attendanceService.findActiveSession(
      user.userId,
      lessonId,
    );

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
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Progress updated',
  })
  public async updateProgress(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() dto: UpdateSessionDto,
  ): Promise<{ message: string; data: unknown }> {
    const session = await this.attendanceService.updateSessionProgress(
      sessionId,
      dto.video_progress_percent ?? 0,
    );

    return {
      message: 'Progress updated',
      data: session,
    };
  }
}
