import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import { biBody } from '../../i18n/error-translator.util';
import { MarketplaceEnrollmentStatus } from '../common/enums';
import { EnrollmentService } from './enrollment.service';
import type { MarketplaceEnrollment } from './entities';

/**
 * FR-105, FR-110. The one gate every piece of paid marketplace content
 * goes through. Always re-queries `marketplace_enrollments` live — nothing
 * here is ever cached into a JWT/session/token, so a revoked or suspended
 * enrollment loses access on the very next request, not whenever a token
 * happens to expire. Reads only marketplace-owned records; never touches
 * (and has no way to touch) an academic entitlement.
 */
@Injectable()
export class AccessService {
  constructor(private readonly enrollments: EnrollmentService) {}

  /** Throws if the learner has no *currently active* enrollment in this course — a suspended or revoked one is exactly as inaccessible as none at all. */
  public async verifyAccess(learnerId: string, courseId: string): Promise<MarketplaceEnrollment> {
    const enrollment = await this.enrollments.getActiveEnrollment(learnerId, courseId);
    if (!enrollment) {
      throw new ForbiddenException(biBody('You do not have access to this course', 'ليس لديك حق الوصول إلى هذه الدورة'));
    }
    return enrollment;
  }

  public async hasAccess(learnerId: string, courseId: string): Promise<boolean> {
    return (await this.enrollments.getActiveEnrollment(learnerId, courseId)) !== null;
  }

  /**
   * The player/content-serving gate (T125): the caller (learner) names a
   * specific enrollment, not a course — 404 (never revealing whether that
   * id belongs to someone else, matching `LearnerOrdersController`'s own
   * IDOR convention) when it isn't theirs at all, 403 (matching
   * {@link verifyAccess}'s existing behaviour) when it is theirs but no
   * longer active.
   */
  public async verifyAccessByEnrollment(learnerId: string, enrollmentId: string): Promise<MarketplaceEnrollment> {
    const enrollment = await this.enrollments.getOwnEnrollment(learnerId, enrollmentId);
    if (!enrollment) {
      throw new NotFoundException(biBody('Enrollment not found', 'التسجيل غير موجود'));
    }
    if (enrollment.status !== MarketplaceEnrollmentStatus.ACTIVE) {
      throw new ForbiddenException(biBody('You do not have access to this course', 'ليس لديك حق الوصول إلى هذه الدورة'));
    }
    return enrollment;
  }
}
