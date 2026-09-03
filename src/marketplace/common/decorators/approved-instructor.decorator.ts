import { applyDecorators, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { ApprovedInstructorGuard } from '../guards/approved-instructor.guard';

/**
 * Marks a handler or controller as instructor-only. Composes authentication
 * with the capability check so every route that needs one gets both —
 * `@ApprovedInstructor()` is the single decorator instructor endpoints use.
 */
export function ApprovedInstructor(): ClassDecorator & MethodDecorator {
  return applyDecorators(UseGuards(JwtAuthGuard, ApprovedInstructorGuard));
}
