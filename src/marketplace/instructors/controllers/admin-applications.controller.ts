import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { InvalidatesCache } from '../../../common/cache/cache-invalidation.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { GetUser } from '../../../common/decorators/get-user.decorator';
import type { JwtPayload } from '../../../common/interfaces/user-request.interface';
import { MarketplaceReasonDto } from '../../common/dto/reason.dto';
import { ApplicationDocumentsService } from '../application-documents.service';
import { ApplicationQueueQueryDto } from '../dto';
import type { InstructorApplication } from '../entities';
import { InstructorApplicationService } from '../instructor-application.service';
import { InstructorService } from '../instructor.service';

/**
 * Contracts §5 — the admin-facing side of application review, plus the
 * FR-016 resubmission-attempts reset. Instructor capability actions
 * (suspend/reinstate, profile-change decisions) live in `AdminInstructorsController`
 * (Phase 12, T192), not here — this controller is applications and applicants only.
 */
@ApiTags('Marketplace / Admin — Instructor Applications')
@Controller('marketplace/admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@ApiBearerAuth('JWT-auth')
export class AdminApplicationsController {
  constructor(
    private readonly applications: InstructorApplicationService,
    private readonly instructors: InstructorService,
    private readonly documents: ApplicationDocumentsService,
  ) {}

  @Get('applications')
  @ApiOperation({ summary: 'Application queue, filterable, ordered by waiting time (FR-017)' })
  public async listQueue(
    @Query() query: ApplicationQueueQueryDto,
  ): Promise<{ items: InstructorApplication[]; total: number }> {
    return this.applications.listQueue({ ...(query.status ? { status: query.status } : {}), page: query.page, limit: query.limit });
  }

  @Get('applications/:id')
  @ApiOperation({ summary: 'Full dossier with signed document links; opening it starts review (submitted → under_review)' })
  public async getDossier(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InstructorApplication & { documents: { key: string; url: string }[] }> {
    const application = await this.applications.getDossier(id);
    const documents = await Promise.all(
      (application.document_keys ?? []).map(async (key) => ({
        key,
        url: await this.documents.getSignedDocumentUrl(application.id, key, application.user_id, true),
      })),
    );
    return { ...application, documents };
  }

  @Post('applications/:id/approve')
  // Writes `marketplace_instructor_applications`, `marketplace_instructors`, `audit_logs`, and — for a
  // public applicant with no account — inserts a `users` row (role NULL). `admin_dashboard` reads audit
  // logs and counts `users` (new_accounts); `platform_report` counts `users` (totalUsers/newUsers) (T031).
  @InvalidatesCache(['marketplace_catalog', 'admin_dashboard', 'platform_report'])
  @ApiOperation({ summary: 'Grant the instructor capability (FR-019)' })
  public async approve(@Param('id', ParseUUIDPipe) id: string, @GetUser() admin: JwtPayload): Promise<unknown> {
    return this.instructors.approveApplication(id, admin.userId);
  }

  @Post('applications/:id/reject')
  // Writes `marketplace_instructor_applications` (read by no family) and `audit_logs` (read by
  // `admin_dashboard`); no users/instructors/catalogue row is touched (T031).
  @InvalidatesCache(['admin_dashboard'])
  @ApiOperation({ summary: 'Reject the application; reason mandatory (FR-018, FR-020)' })
  public async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MarketplaceReasonDto,
    @GetUser() admin: JwtPayload,
  ): Promise<void> {
    await this.instructors.rejectApplication(id, admin.userId, dto.reason);
  }

  @Post('applicants/:userId/reset-attempts')
  // Writes `audit_logs` only (the FR-016 reset watermark); `admin_dashboard` reads audit logs (T031).
  @InvalidatesCache(['admin_dashboard'])
  @ApiOperation({ summary: 'Lift the FR-016 3-application resubmission block; reason mandatory' })
  public async resetAttempts(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: MarketplaceReasonDto,
    @GetUser() admin: JwtPayload,
  ): Promise<void> {
    await this.applications.resetAttempts(userId, admin.userId, dto.reason);
  }
}
