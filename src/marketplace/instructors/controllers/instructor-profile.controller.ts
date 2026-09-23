import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { InvalidatesCache } from '../../../common/cache/cache-invalidation.decorator';
import { GetUser } from '../../../common/decorators/get-user.decorator';
import type { JwtPayload } from '../../../common/interfaces/user-request.interface';
import { ApprovedInstructor } from '../../common/decorators/approved-instructor.decorator';
import { UpdateInstructorProfileDto } from '../dto';
import type { MarketplaceInstructor } from '../entities';
import { InstructorProfileService } from '../instructor-profile.service';

/** Contracts §3 — scoped to the caller's own instructor row, never by a role check (FR-300). */
@ApiTags('Marketplace / Instructor Profile')
@Controller('marketplace/instructor/profile')
@ApprovedInstructor()
@ApiBearerAuth('JWT-auth')
export class InstructorProfileController {
  constructor(private readonly profile: InstructorProfileService) {}

  @Get()
  @ApiOperation({ summary: "Read own profile; response includes any edits awaiting re-review (FR-029)" })
  public async getProfile(@GetUser() user: JwtPayload): Promise<MarketplaceInstructor> {
    return this.profile.getProfile(user.userId);
  }

  @Patch()
  // Writes `marketplace_instructors` only (live fields apply immediately, review-required ones queue in
  // `pending_profile_changes`); no audit log, no `users` write. Read by `marketplace_catalog` (T031).
  @InvalidatesCache(['marketplace_catalog'])
  @ApiOperation({ summary: 'Edit own profile; public-facing fields queue for administrative re-review (FR-029)' })
  public async updateProfile(
    @GetUser() user: JwtPayload,
    @Body() dto: UpdateInstructorProfileDto,
  ): Promise<MarketplaceInstructor> {
    return this.profile.updateProfile(user.userId, dto);
  }
}
