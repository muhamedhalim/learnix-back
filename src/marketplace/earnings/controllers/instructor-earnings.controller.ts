import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { PaginatedResponse } from '../../../common/interfaces/pagination.interface';
import { ApprovedInstructor } from '../../common/decorators/approved-instructor.decorator';
import { CurrentInstructor } from '../../common/decorators/current-instructor.decorator';
import type { MarketplaceInstructor } from '../../instructors/entities/marketplace-instructor.entity';
import { EarningsQueryDto } from '../dto/earnings-query.dto';
import type { MarketplaceBalanceWithShortfall } from '../balance.service';
import { BalanceService } from '../balance.service';
import type { InstructorEarning } from '../entities/instructor-earning.entity';
import { LedgerService } from '../ledger.service';

/** Contracts §3 money block. FR-300: every query is scoped to the caller's own instructor row, never another instructor's — resolved via `@CurrentInstructor()`, never a route param (T172). */
@ApiTags('Marketplace / Instructor Earnings')
@Controller('marketplace/instructor/earnings')
@ApprovedInstructor()
@ApiBearerAuth('JWT-auth')
export class InstructorEarningsController {
  constructor(
    private readonly balances: BalanceService,
    private readonly ledger: LedgerService,
  ) {}

  @Get('balance')
  @ApiOperation({ summary: 'Per-currency balance breakdown — pending, clearing, available, requested, paid out, reversed, shortfall (FR-151)' })
  public async balance(@CurrentInstructor() instructor: MarketplaceInstructor): Promise<MarketplaceBalanceWithShortfall[]> {
    return this.balances.getAllBalances(instructor.id);
  }

  @Get()
  @ApiOperation({ summary: 'Own earnings, filterable by status/currency (FR-152)' })
  public async list(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Query() query: EarningsQueryDto,
  ): Promise<PaginatedResponse<InstructorEarning>> {
    return this.ledger.listEarnings(instructor.id, query);
  }
}
