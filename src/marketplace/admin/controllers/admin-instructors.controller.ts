import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { InvalidatesCache } from '../../../common/cache/cache-invalidation.decorator';
import { GetUser } from '../../../common/decorators/get-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../../common/interfaces/user-request.interface';
import { PaginatedResponse } from '../../../common/interfaces/pagination.interface';
import { MarketplaceReasonDto } from '../../common/dto/reason.dto';
import { MarketplaceInstructorStatus } from '../../common/enums';
import type { MarketplaceInstructor } from '../../instructors/entities';
import { InstructorProfileService } from '../../instructors/instructor-profile.service';
import { InstructorService } from '../../instructors/instructor.service';
import { InstructorRosterQueryDto } from '../dto/report-query.dto';
import { InstructorAdminService, InstructorFullRecord, InstructorRosterRow } from '../instructor-admin.service';

/**
 * Contracts §5. `GET /:id` (full record) is not itself named in the
 * contract's route table — only the roster GET is — but FR-283's own text
 * explicitly requires viewing "any instructor's full record"; resolved in
 * favor of the FR (the authoritative requirement) by adding this route.
 */
@ApiTags('Marketplace / Admin / Instructors')
@Controller('marketplace/admin/instructors')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@ApiBearerAuth('JWT-auth')
export class AdminInstructorsController {
  constructor(
    private readonly instructorAdmin: InstructorAdminService,
    private readonly instructors: InstructorService,
    private readonly profile: InstructorProfileService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Roster including a financial summary per instructor (FR-283)' })
  public async roster(@Query() query: InstructorRosterQueryDto): Promise<PaginatedResponse<InstructorRosterRow>> {
    return this.instructorAdmin.listRoster(
      query.status as MarketplaceInstructorStatus | undefined,
      query.page,
      query.limit,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: "One instructor's full record: application, profile, courses, learners, earnings, ledger, balances, payouts (FR-283)" })
  public async getFullRecord(@Param('id', ParseUUIDPipe) id: string): Promise<InstructorFullRecord> {
    return this.instructorAdmin.getFullRecord(id);
  }

  @Post(':id/suspend')
  // Writes `marketplace_instructors` (status; the catalogue hides a suspended instructor's courses) and
  // `audit_logs`; `admin_dashboard` reads audit logs (T031).
  @InvalidatesCache(['marketplace_catalog', 'admin_dashboard'])
  @ApiOperation({ summary: 'Suspend an instructor; reason mandatory (FR-021)' })
  public async suspend(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MarketplaceReasonDto,
    @GetUser() admin: JwtPayload,
  ): Promise<MarketplaceInstructor> {
    return this.instructors.suspend(id, admin.userId, dto.reason);
  }

  /**
   * An account provisioned from a public application has no password until the applicant uses the emailed
   * link, and "Forgot password" ignores such accounts, so a lost first email would lock the instructor out.
   */
  @Post(':id/resend-setup-link')
  // Writes `users` (the single-use setup token) and `audit_logs`; `admin_dashboard` reads audit logs (T031).
  @InvalidatesCache(['admin_dashboard'])
  @ApiOperation({ summary: 'Re-send the password-setup link to an instructor who has not set a password' })
  public async resendSetupLink(
    @Param('id', ParseUUIDPipe) id: string,
    @GetUser() admin: JwtPayload,
  ): Promise<{ sent: true }> {
    return this.instructors.resendSetupLink(id, admin.userId);
  }

  @Post(':id/reinstate')
  // Same write set as suspend: `marketplace_instructors` + `audit_logs` (T031).
  @InvalidatesCache(['marketplace_catalog', 'admin_dashboard'])
  @ApiOperation({ summary: 'Reinstate a suspended instructor (FR-021)' })
  public async reinstate(
    @Param('id', ParseUUIDPipe) id: string,
    @GetUser() admin: JwtPayload,
  ): Promise<MarketplaceInstructor> {
    return this.instructors.reinstate(id, admin.userId);
  }

  @Post(':id/profile-changes/approve')
  // Writes `marketplace_instructors` (queued profile edits go live) and `audit_logs` (T031).
  @InvalidatesCache(['marketplace_catalog', 'admin_dashboard'])
  @ApiOperation({ summary: "Apply every currently queued FR-029 profile edit at once" })
  public async approveProfileChanges(
    @Param('id', ParseUUIDPipe) id: string,
    @GetUser() admin: JwtPayload,
  ): Promise<MarketplaceInstructor> {
    return this.profile.approvePendingChanges(id, admin.userId);
  }

  @Post(':id/profile-changes/reject')
  // Writes `marketplace_instructors` (clears the pending queue) and `audit_logs` (T031).
  @InvalidatesCache(['marketplace_catalog', 'admin_dashboard'])
  @ApiOperation({ summary: 'Discard every currently queued FR-029 profile edit; live values untouched; reason mandatory' })
  public async rejectProfileChanges(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MarketplaceReasonDto,
    @GetUser() admin: JwtPayload,
  ): Promise<MarketplaceInstructor> {
    return this.profile.rejectPendingChanges(id, admin.userId, dto.reason);
  }
}
