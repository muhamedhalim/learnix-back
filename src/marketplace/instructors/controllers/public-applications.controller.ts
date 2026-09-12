import { Body, Controller, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { THROTTLE } from '../../../common/constants';
import { SubmitPublicInstructorApplicationDto } from '../dto';
import { InstructorApplicationService } from '../instructor-application.service';

/**
 * The independent entry point into the instructor system: an application from
 * someone who has no platform account at all.
 *
 * It is a separate controller from `ApplicationsController` precisely because
 * the auth posture differs — that one is class-level `JwtAuthGuard` for an
 * applicant acting as themselves, this one is unauthenticated by design, and
 * mixing the two behind per-method overrides would make it easy to
 * accidentally expose an owner-scoped route. The routes do not overlap.
 *
 * Nothing here grants anything: the row is stored awaiting review, and only an
 * administrator's approval provisions an account and the instructor
 * capability. The applicant never chooses a role, a password or a status, so
 * this endpoint cannot be used to escalate into any academic role.
 *
 * CSRF is handled exactly as for `POST /auth/register` — the global double
 * submit guard applies, with no exemption.
 */
@ApiTags('Marketplace / Instructor Applications (public)')
@Controller('marketplace/applications')
export class PublicApplicationsController {
  constructor(private readonly applications: InstructorApplicationService) {}

  @Post('public')
  @Throttle({ default: THROTTLE.STRICT })
  @ApiOperation({
    summary:
      'Apply to teach without an account (FR-009). Approval provisions the account; 409 if the contact details already belong to one.',
  })
  @ApiResponse({ status: 201, description: 'Application received and queued for review' })
  @ApiResponse({
    status: 409,
    description: 'An account or an open application already uses these details',
  })
  @ApiResponse({ status: 422, description: 'Lists each missing mandatory field (FR-011)' })
  public async submitPublic(
    @Body() dto: SubmitPublicInstructorApplicationDto,
  ): Promise<{ id: string; status: string }> {
    const { applicant_email, applicant_phone, ...fields } = dto;
    const saved = await this.applications.submitPublic(
      { email: applicant_email, phone: applicant_phone },
      fields,
    );

    // Deliberately minimal: an unauthenticated caller gets back only what it
    // needs to reference its own submission, never the stored record (which
    // carries admin-only fields such as `internal_notes`).
    return { id: saved.id, status: saved.status };
  }
}
