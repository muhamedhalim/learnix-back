import { MarketplaceCourseCompletedEvent, MarketplaceEnrollmentRevokedEvent } from '../events/domain.events';
import { MarketplaceCertificateIssuanceService } from './certificate-issuance.service';

function buildService(opts: {
  course?: Record<string, unknown> | null;
  student?: Record<string, unknown> | null;
  enrollment?: Record<string, unknown> | null;
  existingCertificate?: Record<string, unknown> | null;
} = {}) {
  const course = 'course' in opts ? opts.course : { id: 'course-1', title: 'React Basics', certificate_enabled: true, instructor: { display_name: 'Nour Ahmed' } };
  const student = 'student' in opts ? opts.student : { id: 'learner-1', name: 'Ada Lovelace' };
  const enrollment = 'enrollment' in opts ? opts.enrollment : { id: 'enrollment-1', learner_id: 'learner-1', course_id: 'course-1' };
  const existingCertificate = 'existingCertificate' in opts ? opts.existingCertificate : { id: 'cert-1' };

  const certificates = {
    issueMarketplaceCertificate: jest.fn().mockResolvedValue({ id: 'cert-1' }),
    getMarketplaceCertificateForCourse: jest.fn().mockResolvedValue(existingCertificate),
    revokeCertificate: jest.fn().mockResolvedValue({ id: 'cert-1' }),
  };
  const courses = { findOne: jest.fn().mockResolvedValue(course) };
  const enrollments = { findOne: jest.fn().mockResolvedValue(enrollment) };
  const users = { findOne: jest.fn().mockResolvedValue(student) };

  const service = new MarketplaceCertificateIssuanceService(certificates as never, courses as never, enrollments as never, users as never);
  return { service, certificates, courses, enrollments, users };
}

describe('MarketplaceCertificateIssuanceService (T126, T127)', () => {
  describe('handleCourseCompleted', () => {
    it('issues a certificate for a certificate-enabled course (FR-248)', async () => {
      const { service, certificates } = buildService();
      await service.handleCourseCompleted(new MarketplaceCourseCompletedEvent('enrollment-1', 'course-1', 'learner-1'));

      expect(certificates.issueMarketplaceCertificate).toHaveBeenCalledWith({
        studentId: 'learner-1',
        studentName: 'Ada Lovelace',
        courseTitle: 'React Basics',
        instructorName: 'Nour Ahmed',
        marketplaceCourseId: 'course-1',
      });
    });

    it('does nothing when the course does not have certificates enabled', async () => {
      const { service, certificates } = buildService({
        course: { id: 'course-1', title: 'React Basics', certificate_enabled: false, instructor: { display_name: 'Nour Ahmed' } },
      });
      await service.handleCourseCompleted(new MarketplaceCourseCompletedEvent('enrollment-1', 'course-1', 'learner-1'));

      expect(certificates.issueMarketplaceCertificate).not.toHaveBeenCalled();
    });

    it('never throws even if issuance fails — a best-effort side effect, not the completion write', async () => {
      const { service, certificates } = buildService();
      certificates.issueMarketplaceCertificate.mockRejectedValue(new Error('boom'));

      await expect(
        service.handleCourseCompleted(new MarketplaceCourseCompletedEvent('enrollment-1', 'course-1', 'learner-1')),
      ).resolves.toBeUndefined();
    });

    it('is a no-op if the course or the student is somehow gone', async () => {
      const { service, certificates } = buildService({ course: null });
      await service.handleCourseCompleted(new MarketplaceCourseCompletedEvent('enrollment-1', 'course-1', 'learner-1'));
      expect(certificates.issueMarketplaceCertificate).not.toHaveBeenCalled();
    });
  });

  describe('handleEnrollmentRevoked', () => {
    it('revokes the certificate tied to the revoked enrollment (FR-251)', async () => {
      const { service, certificates } = buildService();
      await service.handleEnrollmentRevoked(new MarketplaceEnrollmentRevokedEvent('enrollment-1', 'order-1', 'Refund completed'));

      expect(certificates.getMarketplaceCertificateForCourse).toHaveBeenCalledWith('learner-1', 'course-1');
      expect(certificates.revokeCertificate).toHaveBeenCalledWith('cert-1', 'Refund completed');
    });

    it('does nothing when no certificate was ever issued for this course', async () => {
      const { service, certificates } = buildService({ existingCertificate: null });
      await service.handleEnrollmentRevoked(new MarketplaceEnrollmentRevokedEvent('enrollment-1', 'order-1', 'Refund completed'));
      expect(certificates.revokeCertificate).not.toHaveBeenCalled();
    });

    it('never throws even if revocation fails', async () => {
      const { service, certificates } = buildService();
      certificates.revokeCertificate.mockRejectedValue(new Error('boom'));
      await expect(
        service.handleEnrollmentRevoked(new MarketplaceEnrollmentRevokedEvent('enrollment-1', 'order-1', 'reason')),
      ).resolves.toBeUndefined();
    });

    it('is a no-op if the enrollment itself cannot be found', async () => {
      const { service, certificates } = buildService({ enrollment: null });
      await service.handleEnrollmentRevoked(new MarketplaceEnrollmentRevokedEvent('enrollment-1', 'order-1', 'reason'));
      expect(certificates.getMarketplaceCertificateForCourse).not.toHaveBeenCalled();
    });
  });
});
