import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { PaginatedResponse } from '../../../common/interfaces/pagination.interface';
import { ApprovedInstructor } from '../../common/decorators/approved-instructor.decorator';
import { CurrentInstructor } from '../../common/decorators/current-instructor.decorator';
import type { MarketplaceInstructor } from '../../instructors/entities/marketplace-instructor.entity';
import { LedgerQueryDto } from '../dto/earnings-query.dto';
import type { MarketplaceLedgerEntry } from '../entities/marketplace-ledger-entry.entity';
import { LedgerService } from '../ledger.service';

/** FR-291: entries are viewable and filterable here, but this controller exposes no write route at all — the immutability trigger is the backstop, this is the front door that simply doesn't offer a way in (T172). */
@ApiTags('Marketplace / Instructor Ledger')
@Controller('marketplace/instructor/ledger')
@ApprovedInstructor()
@ApiBearerAuth('JWT-auth')
export class InstructorLedgerController {
  constructor(private readonly ledger: LedgerService) {}

  @Get()
  @ApiOperation({ summary: 'Own append-only ledger entries, filterable by entry type/currency (FR-291)' })
  public async list(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Query() query: LedgerQueryDto,
  ): Promise<PaginatedResponse<MarketplaceLedgerEntry>> {
    return this.ledger.listEntries(instructor.id, {
      ...(query.entry_type !== undefined && { entryType: query.entry_type }),
      ...(query.currency !== undefined && { currency: query.currency }),
      ...(query.page !== undefined && { page: query.page }),
      ...(query.limit !== undefined && { limit: query.limit }),
    });
  }
}
