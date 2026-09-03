import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { GetUser } from '../../../common/decorators/get-user.decorator';
import type { JwtPayload } from '../../../common/interfaces/user-request.interface';
import { biBody } from '../../../i18n/error-translator.util';
import { AccessService } from '../../commerce/access.service';
import { EnrollmentService } from '../../commerce/enrollment.service';
import type { MarketplaceEnrollment, MarketplaceLessonProgress } from '../../commerce/entities';
import { UpdateLessonProgressDto } from '../dto/update-lesson-progress.dto';
import { LessonProgressService } from '../lesson-progress.service';
import { PlayerData, PlayerService, SignedLessonContent } from '../player.service';

/**
 * Contracts §4 player block. Every route is learner-scoped (`GetUser()`),
 * and every access decision is made by `AccessService`/`EnrollmentService`
 * inside the services this controller only delegates to — never here.
 */
@ApiTags('Marketplace / Learning')
@Controller('marketplace/me/enrollments')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class LearnerPlayerController {
  constructor(
    private readonly enrollments: EnrollmentService,
    private readonly access: AccessService,
    private readonly player: PlayerService,
    private readonly lessonProgress: LessonProgressService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'My learning — every enrollment with its cached progress (FR-107)' })
  public async listMine(@GetUser() user: JwtPayload): Promise<MarketplaceEnrollment[]> {
    return this.enrollments.listOwnEnrollments(user.userId);
  }

  @Get(':id/player')
  @ApiOperation({ summary: 'Curriculum + per-lesson completion/position, access-checked (contracts §4)' })
  public async getPlayer(@GetUser() user: JwtPayload, @Param('id', ParseUUIDPipe) enrollmentId: string): Promise<PlayerData> {
    return this.player.getPlayerData(user.userId, enrollmentId);
  }

  @Get(':id/lessons/:lessonId')
  @ApiOperation({ summary: 'Signed content for one lesson, verified per request (FR-105, FR-084, FR-244)' })
  public async getLessonContent(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) enrollmentId: string,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
  ): Promise<SignedLessonContent> {
    return this.player.getLessonContent(user.userId, enrollmentId, lessonId);
  }

  @Put(':id/lessons/:lessonId/progress')
  @ApiOperation({ summary: 'Explicit mark-complete/incomplete and/or last position — never a percentage (FR-238, FR-239, FR-334)' })
  public async updateProgress(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) enrollmentId: string,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
    @Body() dto: UpdateLessonProgressDto,
  ): Promise<MarketplaceLessonProgress> {
    if (dto.is_completed === undefined && dto.position_seconds === undefined) {
      throw new BadRequestException(biBody('Nothing to update', 'لا يوجد شيء لتحديثه'));
    }
    const enrollment = await this.access.verifyAccessByEnrollment(user.userId, enrollmentId);

    let row: MarketplaceLessonProgress | undefined;
    if (dto.position_seconds !== undefined) {
      row = await this.lessonProgress.updatePosition(user.userId, enrollment.course_id, lessonId, dto.position_seconds);
    }
    if (dto.is_completed === true) {
      row = await this.lessonProgress.markComplete(user.userId, enrollment.course_id, lessonId);
    } else if (dto.is_completed === false) {
      row = await this.lessonProgress.markIncomplete(user.userId, enrollment.course_id, lessonId);
    }
    return row!;
  }
}
