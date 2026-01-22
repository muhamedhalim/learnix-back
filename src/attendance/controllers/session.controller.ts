import {
  Controller,
  Post,
  Put,
  Param,
  Body,
  Req,
  ParseUUIDPipe,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { Request } from 'express';
import { AttendanceService } from '../attendance.service';
import { UpdateSessionDto } from '../dto';
import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { JwtPayload } from '../../common/interfaces/user-request.interface';

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
  @ApiOperation({
    summary: 'Enter lesson',
    description:
      'Start a lesson session. Tracks when student enters the lesson video.',
  })
  @ApiParam({ name: 'id', description: 'Lesson ID' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Session started successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Lesson not found',
  })
  async enterLesson(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) lessonId: string,
    @Req() request: Request,
  ) {
    const ipAddress =
      (request.headers['x-forwarded-for'] as string)?.split(',')[0] ||
      request.ip ||
      null;
    const deviceInfo = request.headers['user-agent'] || null;

    const session = await this.attendanceService.enterLesson(
      user.userId,
      lessonId,
      ipAddress || undefined,
      deviceInfo || undefined,
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
  @ApiOperation({
    summary: 'Exit lesson',
    description:
      'End a lesson session. Provide watch percentage and duration. Auto-marks attendance if 80%+ watched.',
  })
  @ApiParam({ name: 'id', description: 'Lesson ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Session ended. May include auto-attendance status.',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Active session not found',
  })
  async exitLesson(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) lessonId: string,
    @Body() dto: UpdateSessionDto,
  ) {
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
      dto.video_progress_percent || 0,
      dto.duration_seconds || 0,
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
  @Put('sessions/:sessionId/progress')
  @ApiOperation({
    summary: 'Update session progress',
    description: 'Update the watch percentage during video playback.',
  })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Progress updated',
  })
  async updateProgress(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() dto: UpdateSessionDto,
  ) {
    const session = await this.attendanceService.updateSessionProgress(
      sessionId,
      dto.video_progress_percent || 0,
    );

    return {
      message: 'Progress updated',
      data: session,
    };
  }
}
