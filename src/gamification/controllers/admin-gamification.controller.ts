import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { CreateGamificationRuleSetDto, SetGamificationRuleSetEnabledDto } from '../dto/gamification-rule-set.dto';
import { GamificationRuleSet } from '../entities/gamification-rule-set.entity';
import { GamificationRulesService, ResolvedRuleSet } from '../services/gamification-rules.service';

/**
 * DEF-018: Admin configuration of the platform's global XP economy. The
 * engine itself (Elo/Levels/Leaderboard/Ranks) is untouched — this only
 * makes the previously-hardcoded scoring constants admin-editable, versioned,
 * and non-retroactive.
 */
@ApiTags('Admin - Gamification')
@Controller('admin/gamification')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('admin')
@ApiBearerAuth('JWT-auth')
export class AdminGamificationController {
  constructor(private readonly rules: GamificationRulesService) {}

  @Get('rule-sets')
  @ApiOperation({ summary: 'List every XP ruleset version, newest first' })
  public async history(): Promise<GamificationRuleSet[]> {
    return this.rules.history();
  }

  @Get('rule-sets/current')
  @ApiOperation({ summary: 'The XP ruleset currently applied to new practice solves' })
  public async current(): Promise<ResolvedRuleSet> {
    return this.rules.resolveCurrent();
  }

  @Post('rule-sets')
  @ApiOperation({ summary: 'Create a new XP ruleset version (never edits a past one)' })
  public async create(
    @Body() dto: CreateGamificationRuleSetDto,
    @GetUser() user: JwtPayload,
  ): Promise<GamificationRuleSet> {
    return this.rules.create(dto, user.userId);
  }

  @Patch('rule-sets/:id/enabled')
  @ApiOperation({ summary: 'Enable or disable a ruleset version (rollback switch)' })
  public async setEnabled(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetGamificationRuleSetEnabledDto,
  ): Promise<GamificationRuleSet> {
    return this.rules.setEnabled(id, dto.enabled);
  }
}
