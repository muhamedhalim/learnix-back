import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { biBody } from '../../../i18n/error-translator.util';
import type { PublicInstructorProfile } from '../public-instructor-profile.service';
import { PublicInstructorProfileService } from '../public-instructor-profile.service';

/**
 * Contracts §1 — no auth. FR-032: a suspended, withdrawn or nonexistent
 * instructor all resolve to the same 404, never a 403 that would leak
 * which case it was.
 */
@ApiTags('Marketplace / Public')
@Controller('marketplace/instructors')
export class PublicInstructorController {
  constructor(private readonly profiles: PublicInstructorProfileService) {}

  @Get(':slug')
  @ApiOperation({ summary: 'Public instructor profile with published courses (FR-026, FR-027)' })
  public async getProfile(@Param('slug') slug: string): Promise<PublicInstructorProfile> {
    const profile = await this.profiles.getBySlug(slug);
    if (!profile) {
      throw new NotFoundException(biBody('Instructor not found', 'المدرّب غير موجود'));
    }
    return profile;
  }
}
