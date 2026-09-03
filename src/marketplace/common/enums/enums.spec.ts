import {
  CourseLevel,
  CourseRemovalCause,
  CourseReviewDecisionValue,
  CourseReviewStatus,
  InstructorApplicationStatus,
  InstructorEarningStatus,
  LessonContentType,
  MarketplaceCommissionScope,
  MarketplaceCourseStatus,
  MarketplaceEnrollmentStatus,
  MarketplaceInstructorStatus,
  MarketplaceLedgerDirection,
  MarketplaceLedgerEntryStatus,
  MarketplaceLedgerEntryType,
  MarketplaceOrderStatus,
  PayoutAccountVerificationStatus,
  PayoutRequestStatus,
  RefundRequestStatus,
} from './index';

describe('marketplace state enums', () => {
  it('InstructorApplicationStatus matches the six-state application lifecycle (FR-012)', () => {
    expect(Object.values(InstructorApplicationStatus).sort()).toEqual(
      ['draft', 'submitted', 'under_review', 'approved', 'rejected', 'withdrawn'].sort(),
    );
  });

  it('MarketplaceInstructorStatus matches the capability record lifecycle', () => {
    expect(Object.values(MarketplaceInstructorStatus).sort()).toEqual(
      ['approved', 'suspended', 'withdrawn'].sort(),
    );
  });

  it('MarketplaceCourseStatus has exactly the six states of FR-059/FR-060, no seventh', () => {
    expect(Object.values(MarketplaceCourseStatus)).toHaveLength(6);
    expect(Object.values(MarketplaceCourseStatus).sort()).toEqual(
      ['draft', 'submitted_for_review', 'approved', 'rejected', 'published', 'unpublished'].sort(),
    );
  });

  it('CourseLevel matches FR-043', () => {
    expect(Object.values(CourseLevel).sort()).toEqual(
      ['beginner', 'intermediate', 'advanced', 'all_levels'].sort(),
    );
  });

  it('LessonContentType has exactly three content kinds', () => {
    expect(Object.values(LessonContentType).sort()).toEqual(['video', 'text', 'attachment'].sort());
  });

  it('CourseRemovalCause matches FR-054a', () => {
    expect(Object.values(CourseRemovalCause).sort()).toEqual(
      ['legal_takedown', 'policy_violation', 'instructor_departure'].sort(),
    );
  });

  it('CourseReviewDecisionValue is a binary admin ruling', () => {
    expect(Object.values(CourseReviewDecisionValue).sort()).toEqual(
      ['approved', 'rejected'].sort(),
    );
  });

  it('MarketplaceOrderStatus matches the order state machine', () => {
    expect(Object.values(MarketplaceOrderStatus).sort()).toEqual(
      ['awaiting_payment', 'paid', 'failed', 'expired', 'cancelled', 'refunded'].sort(),
    );
  });

  it('MarketplaceEnrollmentStatus has no expired value (FR-106)', () => {
    expect(Object.values(MarketplaceEnrollmentStatus).sort()).toEqual(
      ['active', 'suspended', 'revoked'].sort(),
    );
    expect(Object.values(MarketplaceEnrollmentStatus)).not.toContain('expired');
  });

  it('MarketplaceCommissionScope reserves instructor/course/category for later (FR-133)', () => {
    expect(Object.values(MarketplaceCommissionScope).sort()).toEqual(
      ['platform', 'instructor', 'course', 'category'].sort(),
    );
  });

  it('InstructorEarningStatus has exactly the seven states of FR-142/FR-144', () => {
    expect(Object.values(InstructorEarningStatus)).toHaveLength(7);
    expect(Object.values(InstructorEarningStatus).sort()).toEqual(
      [
        'pending_earnings',
        'refund_clearance',
        'available_balance',
        'payout_requested',
        'processing',
        'paid_out',
        'reversed',
      ].sort(),
    );
  });

  it('MarketplaceLedgerEntryType has exactly the eight entry types of FR-159 (extended by T139/FR-195)', () => {
    expect(Object.values(MarketplaceLedgerEntryType)).toHaveLength(8);
    expect(Object.values(MarketplaceLedgerEntryType).sort()).toEqual(
      [
        'course_sale',
        'platform_commission',
        'refund',
        'refund_commission_reversal',
        'payout',
        'payout_reversal',
        'manual_adjustment',
        'refund_shortfall',
      ].sort(),
    );
  });

  it('MarketplaceLedgerDirection is explicit credit/debit (FR-161)', () => {
    expect(Object.values(MarketplaceLedgerDirection).sort()).toEqual(['credit', 'debit'].sort());
  });

  it('MarketplaceLedgerEntryStatus is posted/reversed', () => {
    expect(Object.values(MarketplaceLedgerEntryStatus).sort()).toEqual(
      ['posted', 'reversed'].sort(),
    );
  });

  it('RefundRequestStatus has exactly the six states of FR-184', () => {
    expect(Object.values(RefundRequestStatus)).toHaveLength(6);
    expect(Object.values(RefundRequestStatus).sort()).toEqual(
      ['requested', 'approved', 'rejected', 'processing', 'completed', 'failed'].sort(),
    );
  });

  it('PayoutRequestStatus has exactly the seven states of FR-212', () => {
    expect(Object.values(PayoutRequestStatus)).toHaveLength(7);
    expect(Object.values(PayoutRequestStatus).sort()).toEqual(
      ['requested', 'approved', 'rejected', 'processing', 'paid', 'cancelled', 'failed'].sort(),
    );
  });

  it('PayoutAccountVerificationStatus is pending/verified/rejected', () => {
    expect(Object.values(PayoutAccountVerificationStatus).sort()).toEqual(
      ['pending', 'verified', 'rejected'].sort(),
    );
  });

  it('CourseReviewStatus reuses the approved/flagged/rejected vocabulary', () => {
    expect(Object.values(CourseReviewStatus).sort()).toEqual(
      ['approved', 'flagged', 'rejected'].sort(),
    );
  });
});
