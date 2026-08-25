import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import {
  CancelLessonSessionDto,
  CreateLessonSessionsDto,
  GenerateSessionMeetingDto,
  ReserveLessonSessionDto,
  UpdateLessonSessionDto,
} from '../dto';
import { LessonSessionsService } from '../lesson-sessions.service';

@ApiTags('Lesson Appointments')
@Controller('lessons')
export class PublicLessonSessionsController {
  public constructor(private readonly sessions: LessonSessionsService) {}

  @Get(':lessonId/sessions')
  public async list(@Param('lessonId', ParseUUIDPipe) lessonId: string): Promise<unknown> {
    return await this.sessions.listPublic(lessonId);
  }
}

@ApiTags('Student Lesson Appointments')
@Controller('student/lesson-sessions')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('student')
@ApiBearerAuth('JWT-auth')
export class StudentLessonSessionsController {
  public constructor(private readonly sessions: LessonSessionsService) {}

  @Get()
  public async list(@GetUser() user: JwtPayload): Promise<unknown> {
    return await this.sessions.listForStudent(user.userId);
  }

  @Post('reservations')
  @HttpCode(HttpStatus.CREATED)
  public async reserve(
    @GetUser() user: JwtPayload,
    @Body() dto: ReserveLessonSessionDto,
  ): Promise<unknown> {
    return await this.sessions.reserve(dto.session_id, user.userId);
  }

  @Delete('reservations/:bookingId')
  @HttpCode(HttpStatus.NO_CONTENT)
  public async release(
    @GetUser() user: JwtPayload,
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
  ): Promise<void> {
    await this.sessions.release(bookingId, user.userId);
  }
}

@ApiTags('Teacher Lesson Appointments')
@Controller('teacher/lessons/:lessonId/sessions')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('teacher')
@ApiBearerAuth('JWT-auth')
export class TeacherLessonSessionsController {
  public constructor(private readonly sessions: LessonSessionsService) {}

  @Get()
  public async list(
    @GetUser() user: JwtPayload,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
  ): Promise<unknown> {
    return await this.sessions.listForTeacher(lessonId, user.userId);
  }

  @Post()
  public async create(
    @GetUser() user: JwtPayload,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
    @Body() dto: CreateLessonSessionsDto,
  ): Promise<unknown> {
    return await this.sessions.createMany(lessonId, user.userId, dto.sessions);
  }

  @Patch(':sessionId')
  public async update(
    @GetUser() user: JwtPayload,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() dto: UpdateLessonSessionDto,
  ): Promise<unknown> {
    return await this.sessions.update(lessonId, sessionId, user.userId, dto);
  }

  @Post(':sessionId/cancel')
  public async cancel(
    @GetUser() user: JwtPayload,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() dto: CancelLessonSessionDto,
  ): Promise<unknown> {
    return await this.sessions.cancel(lessonId, sessionId, user.userId, dto);
  }

  /** Explicit Generate action (AD-7) — never triggered by create/update above. */
  @Post(':sessionId/meeting')
  public async generateMeeting(
    @GetUser() user: JwtPayload,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() dto: GenerateSessionMeetingDto,
  ): Promise<unknown> {
    return await this.sessions.requestMeetingGeneration(
      lessonId,
      sessionId,
      user.userId,
      dto.meeting_provider,
    );
  }

  @Delete(':sessionId/meeting')
  public async clearMeeting(
    @GetUser() user: JwtPayload,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
  ): Promise<unknown> {
    return await this.sessions.clearMeetingGeneration(lessonId, sessionId, user.userId);
  }
}

@ApiTags('Admin Lesson Appointments')
@Controller('admin/lessons/:lessonId/sessions')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('admin')
@ApiBearerAuth('JWT-auth')
export class AdminLessonSessionsController {
  public constructor(private readonly sessions: LessonSessionsService) {}

  @Get()
  public async list(@Param('lessonId', ParseUUIDPipe) lessonId: string): Promise<unknown> {
    return await this.sessions.listForAdmin(lessonId);
  }
}
