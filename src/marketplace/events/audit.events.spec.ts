import { AuditEvent } from '../../activity-logs/events/audit.events';
import {
  MarketplaceApplicationApprovedEvent,
  MarketplaceApplicationAttemptsResetEvent,
  MarketplaceApplicationRejectedEvent,
  MarketplaceCommissionRateChangedEvent,
  MarketplaceCourseApprovedEvent,
  MarketplaceCourseRejectedEvent,
  MarketplaceCourseRemovedEvent,
  MarketplaceCourseUnpublishedEvent,
  MarketplaceInstructorProfileChangesDecisionEvent,
  MarketplaceInstructorReinstatedEvent,
  MarketplaceInstructorSuspendedEvent,
  MarketplaceLedgerAdjustmentEvent,
  MarketplacePayoutDecisionEvent,
  MarketplaceRefundDecisionEvent,
} from './audit.events';

describe('marketplace audit events', () => {
  it('every event extends the existing AuditEvent base class — no new audit table (FR-290)', () => {
    const application = new MarketplaceApplicationApprovedEvent('admin-1', 'app-1', {
      applicantUserId: 'user-1',
      applicantName: 'Nour',
    });
    expect(application).toBeInstanceOf(AuditEvent);
  });

  it.each([
    [
      new MarketplaceApplicationApprovedEvent('admin-1', 'app-1', {
        applicantUserId: 'user-1',
        applicantName: 'Nour',
      }),
      'marketplace_application_approved',
      'marketplace_instructor_application',
    ],
    [
      new MarketplaceApplicationRejectedEvent('admin-1', 'app-1', {
        applicantUserId: 'user-1',
        applicantName: 'Nour',
        reason: 'Incomplete portfolio',
      }),
      'marketplace_application_rejected',
      'marketplace_instructor_application',
    ],
    [
      new MarketplaceApplicationAttemptsResetEvent('admin-1', 'user-1', {
        reason: 'Circumstances have changed since the third rejection',
      }),
      'marketplace_application_attempts_reset',
      'marketplace_applicant',
    ],
    [
      new MarketplaceInstructorSuspendedEvent('admin-1', 'instr-1', {
        instructorName: 'Nour',
        reason: 'Policy violation',
      }),
      'marketplace_instructor_suspended',
      'marketplace_instructor',
    ],
    [
      new MarketplaceInstructorReinstatedEvent('admin-1', 'instr-1', { instructorName: 'Nour' }),
      'marketplace_instructor_reinstated',
      'marketplace_instructor',
    ],
    [
      new MarketplaceInstructorProfileChangesDecisionEvent('admin-1', 'instr-1', {
        instructorName: 'Nour',
        decision: 'approved',
        fields: ['display_name', 'headline'],
      }),
      'marketplace_instructor_profile_changes_decision',
      'marketplace_instructor',
    ],
    [
      new MarketplaceCourseApprovedEvent('admin-1', 'course-1', { courseTitle: 'React Basics' }),
      'marketplace_course_approved',
      'marketplace_course',
    ],
    [
      new MarketplaceCourseRejectedEvent('admin-1', 'course-1', {
        courseTitle: 'React Basics',
        reasons: ['Missing curriculum'],
      }),
      'marketplace_course_rejected',
      'marketplace_course',
    ],
    [
      new MarketplaceCourseUnpublishedEvent('admin-1', 'course-1', {
        courseTitle: 'React Basics',
        reason: 'Outdated content pending instructor revision',
      }),
      'marketplace_course_unpublished',
      'marketplace_course',
    ],
    [
      new MarketplaceCourseRemovedEvent('admin-1', 'course-1', {
        courseTitle: 'React Basics',
        cause: 'legal_takedown',
        reason: 'DMCA notice',
      }),
      'marketplace_course_removed',
      'marketplace_course',
    ],
    [
      new MarketplaceRefundDecisionEvent('admin-1', 'refund-1', {
        orderId: 'order-1',
        decision: 'approved',
        discretionary: false,
      }),
      'marketplace_refund_decision',
      'marketplace_refund_request',
    ],
    [
      new MarketplacePayoutDecisionEvent('admin-1', 'payout-1', {
        instructorId: 'instr-1',
        decision: 'paid',
        payoutReference: 'REF-123',
      }),
      'marketplace_payout_decision',
      'marketplace_payout_request',
    ],
    [
      new MarketplaceCommissionRateChangedEvent('admin-1', 'commission-1', {
        previousRateBps: 3000,
        newRateBps: 2500,
        scope: 'platform',
      }),
      'marketplace_commission_rate_changed',
      'marketplace_commission_setting',
    ],
    [
      new MarketplaceLedgerAdjustmentEvent('admin-1', 'ledger-1', {
        instructorId: 'instr-1',
        amountMinor: 500,
        currency: 'EGP',
        reason: 'Goodwill credit',
      }),
      'marketplace_ledger_adjustment',
      'marketplace_ledger_entry',
    ],
  ])('%#: carries the correct action and targetType', (event, action, targetType) => {
    expect(event.action).toBe(action);
    expect(event.targetType).toBe(targetType);
    expect(event.adminId).toBe('admin-1');
  });
});
