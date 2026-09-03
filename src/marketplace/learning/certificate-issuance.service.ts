import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CertificatesService } from '../../certificates/certificates.service';
import type { Certificate } from '../../certificates/entities/certificate.entity';
import { User } from '../../users/entities/user.entity';
import { MarketplaceEnrollment } from '../commerce/entities';
import { MarketplaceCourseCompletedEvent, MarketplaceEnrollmentRevokedEvent } from '../events/domain.events';
import { MarketplaceCourse } from '../catalog/entities';

/**
 * T126, T127, FR-248, FR-251, FR-324. Everything this service reads to
 * decide *whether* to issue is marketplace-owned
 * (`marketplace_enrollments`/`marketplace_courses`) — it never opens
 * `CertificateEligibilityService` or any academic entity. Issuance and
 * revocation themselves delegate to `CertificatesService`'s
 * subject-agnostic write path (`issueMarketplaceCertificate()`,
 * `revokeCertificate()`), reused rather than reimplemented for template
 * resolution, code generation, snapshotting and the notification it
 * already emits on issuance.
 */
@Injectable()
export class MarketplaceCertificateIssuanceService {
  private readonly logger = new Logger(MarketplaceCertificateIssuanceService.name);

  constructor(
    private readonly certificates: CertificatesService,
    @InjectRepository(MarketplaceCourse)
    private readonly courses: Repository<MarketplaceCourse>,
    @InjectRepository(MarketplaceEnrollment)
    private readonly enrollments: Repository<MarketplaceEnrollment>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
  ) {}

  /** FR-248: exactly one certificate per completed enrollment, paid or free — `certificate_enabled` gates whether one is due at all. */
  @OnEvent(MarketplaceCourseCompletedEvent.EVENT_NAME)
  public async handleCourseCompleted(event: MarketplaceCourseCompletedEvent): Promise<void> {
    try {
      const course = await this.courses.findOne({ where: { id: event.courseId }, relations: ['instructor'] });
      if (!course || !course.certificate_enabled) return;

      const student = await this.users.findOne({ where: { id: event.learnerId } });
      if (!student) return;

      await this.certificates.issueMarketplaceCertificate({
        studentId: event.learnerId,
        studentName: student.name,
        courseTitle: course.title,
        instructorName: course.instructor?.display_name ?? null,
        marketplaceCourseId: event.courseId,
      });
    } catch (error) {
      this.logger.error(
        `Marketplace certificate issuance failed for enrollment ${event.enrollmentId}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  /** FR-251: revoking access revokes whatever certificate it produced — visible on public verification via the existing, unmodified verification surface. */
  @OnEvent(MarketplaceEnrollmentRevokedEvent.EVENT_NAME)
  public async handleEnrollmentRevoked(event: MarketplaceEnrollmentRevokedEvent): Promise<void> {
    try {
      const enrollment = await this.enrollments.findOne({ where: { id: event.enrollmentId } });
      if (!enrollment) return;

      const certificate: Certificate | null = await this.certificates.getMarketplaceCertificateForCourse(
        enrollment.learner_id,
        enrollment.course_id,
      );
      if (!certificate) return;

      await this.certificates.revokeCertificate(certificate.id, event.reason);
    } catch (error) {
      this.logger.error(
        `Marketplace certificate revocation failed for enrollment ${event.enrollmentId}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
}
