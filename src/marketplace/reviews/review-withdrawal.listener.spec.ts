import { MarketplaceEnrollmentRevokedEvent } from '../events/domain.events';
import { ReviewWithdrawalListener } from './review-withdrawal.listener';

describe('ReviewWithdrawalListener (T153, FR-263)', () => {
  it('resolves the enrollment to (course, learner) and withdraws the review', async () => {
    const enrollments = { findOne: jest.fn().mockResolvedValue({ id: 'enrollment-1', course_id: 'course-1', learner_id: 'learner-1' }) };
    const reviews = { withdrawForEnrollment: jest.fn().mockResolvedValue(undefined) };
    const listener = new ReviewWithdrawalListener(enrollments as never, reviews as never);

    await listener.handleEnrollmentRevoked(new MarketplaceEnrollmentRevokedEvent('enrollment-1', 'order-1', 'Suspended for cause'));

    expect(reviews.withdrawForEnrollment).toHaveBeenCalledWith('course-1', 'learner-1');
  });

  it('is a no-op if the enrollment is somehow gone', async () => {
    const enrollments = { findOne: jest.fn().mockResolvedValue(null) };
    const reviews = { withdrawForEnrollment: jest.fn() };
    const listener = new ReviewWithdrawalListener(enrollments as never, reviews as never);

    await listener.handleEnrollmentRevoked(new MarketplaceEnrollmentRevokedEvent('enrollment-1', 'order-1', 'x'));

    expect(reviews.withdrawForEnrollment).not.toHaveBeenCalled();
  });

  it('never throws even if withdrawal fails', async () => {
    const enrollments = { findOne: jest.fn().mockResolvedValue({ id: 'enrollment-1', course_id: 'course-1', learner_id: 'learner-1' }) };
    const reviews = { withdrawForEnrollment: jest.fn().mockRejectedValue(new Error('boom')) };
    const listener = new ReviewWithdrawalListener(enrollments as never, reviews as never);

    await expect(
      listener.handleEnrollmentRevoked(new MarketplaceEnrollmentRevokedEvent('enrollment-1', 'order-1', 'x')),
    ).resolves.toBeUndefined();
  });
});
