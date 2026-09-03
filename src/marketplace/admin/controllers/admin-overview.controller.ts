import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { AdminOverview, MarketplaceOverviewService } from '../overview.service';

/** Contracts §5. No finance permission — an operational summary every admin can see, matching the contract's blank "Extra guard" column for this route. */
@ApiTags('Marketplace / Admin / Overview')
@Controller('marketplace/admin/overview')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@ApiBearerAuth('JWT-auth')
export class AdminOverviewController {
  constructor(private readonly overview: MarketplaceOverviewService) {}

  @Get()
  @ApiOperation({ summary: 'Queue counts and oldest waiting time per queue (FR-286)' })
  public async getOverview(): Promise<AdminOverview> {
    return this.overview.getOverview();
  }
}
