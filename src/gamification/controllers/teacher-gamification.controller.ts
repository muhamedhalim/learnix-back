import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { CreateGamificationCampaignDto, UpdateGamificationCampaignDto } from '../dto/gamification-campaign.dto';
import { GamificationCampaign } from '../entities/gamification-campaign.entity';
import { GamificationCampaignsService } from '../services/gamification-campaigns.service';

/**
 * DEF-018: Teacher-scoped XP bonus campaigns. Strictly limited to lessons the
 * authenticated teacher owns (`assertOwned` pattern, 404 on non-owned) —
 * never a global scoring change, and never affects another teacher's content.
 */
@ApiTags('Teacher - Gamification')
@Controller('teacher/gamification')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('teacher')
@ApiBearerAuth('JWT-auth')
export class TeacherGamificationController {
  constructor(private readonly campaigns: GamificationCampaignsService) {}

  @Get('campaigns')
  @ApiOperation({ summary: "List the authenticated teacher's own XP bonus campaigns" })
  public async list(@GetUser() user: JwtPayload): Promise<GamificationCampaign[]> {
    return this.campaigns.listForTeacher(user.userId);
  }

  @Post('campaigns')
  @ApiOperation({ summary: 'Create an XP bonus campaign for a lesson the teacher owns' })
  public async create(
    @Body() dto: CreateGamificationCampaignDto,
    @GetUser() user: JwtPayload,
  ): Promise<GamificationCampaign> {
    return this.campaigns.createForTeacher(user.userId, dto);
  }

  @Patch('campaigns/:id')
  @ApiOperation({ summary: "Update one of the teacher's own campaigns" })
  public async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGamificationCampaignDto,
    @GetUser() user: JwtPayload,
  ): Promise<GamificationCampaign> {
    return this.campaigns.update(user.userId, id, dto);
  }
}
