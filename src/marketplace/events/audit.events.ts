import { AuditEvent } from '../../activity-logs/events/audit.events';

/**
 * Marketplace audit events (FR-290, FR-291) — every privileged decision an
 * administrator makes, plus the one instructor action (a manual ledger
 * adjustment is admin-only; instructor self-service actions like
 * submitting an application are not privileged actions and are not
 * audited here). All extend the existing `AuditEvent` base class, so the
 * existing `ActivityLogListener` persists them into `audit_logs` exactly as
 * it does every other module's events — no new audit table (FR-290).
 */

export class MarketplaceApplicationApprovedEvent extends AuditEvent {
  constructor(
    adminId: string,
    applicationId: string,
    details: { applicantUserId: string; applicantName: string },
    ipAddress?: string,
  ) {
    super(
      adminId,
      'marketplace_application_approved',
      'marketplace_instructor_application',
      applicationId,
      details.applicantName,
      details,
      ipAddress ?? null,
    );
  }
}

export class MarketplaceApplicationRejectedEvent extends AuditEvent {
  constructor(
    adminId: string,
    applicationId: string,
    details: { applicantUserId: string | null; applicantName: string; reason: string },
    ipAddress?: string,
  ) {
    super(
      adminId,
      'marketplace_application_rejected',
      'marketplace_instructor_application',
      applicationId,
      details.applicantName,
      details,
      ipAddress ?? null,
    );
  }
}

/** FR-016 — an admin lifts the 3-application resubmission block for one applicant. */
export class MarketplaceApplicationAttemptsResetEvent extends AuditEvent {
  constructor(
    adminId: string,
    applicantUserId: string,
    details: { reason: string },
    ipAddress?: string,
  ) {
    super(
      adminId,
      'marketplace_application_attempts_reset',
      'marketplace_applicant',
      applicantUserId,
      null,
      details,
      ipAddress ?? null,
    );
  }
}

/** An administrator re-sent the password-setup link of an account provisioned from a public application. */
export class MarketplaceInstructorSetupLinkResentEvent extends AuditEvent {
  constructor(adminId: string, instructorId: string, details: { instructorName: string }, ipAddress?: string) {
    super(
      adminId,
      'marketplace_instructor_setup_link_resent',
      'marketplace_instructor',
      instructorId,
      details.instructorName,
      details,
      ipAddress ?? null,
    );
  }
}

export class MarketplaceInstructorSuspendedEvent extends AuditEvent {
  constructor(
    adminId: string,
    instructorId: string,
    details: { instructorName: string; reason: string },
    ipAddress?: string,
  ) {
    super(
      adminId,
      'marketplace_instructor_suspended',
      'marketplace_instructor',
      instructorId,
      details.instructorName,
      details,
      ipAddress ?? null,
    );
  }
}

export class MarketplaceInstructorReinstatedEvent extends AuditEvent {
  constructor(
    adminId: string,
    instructorId: string,
    details: { instructorName: string },
    ipAddress?: string,
  ) {
    super(
      adminId,
      'marketplace_instructor_reinstated',
      'marketplace_instructor',
      instructorId,
      details.instructorName,
      details,
      ipAddress ?? null,
    );
  }
}

/**
 * FR-029 — an admin's decision on an instructor's pending profile edits
 * (display name, photo, headline, bio, links, portfolio, certifications,
 * education, work experience). Approving applies every queued field at
 * once; rejecting discards them and the previously approved values stay
 * live either way until this decision is made.
 */
export class MarketplaceInstructorProfileChangesDecisionEvent extends AuditEvent {
  constructor(
    adminId: string,
    instructorId: string,
    details: { instructorName: string; decision: 'approved' | 'rejected'; fields: string[]; reason?: string },
    ipAddress?: string,
  ) {
    super(
      adminId,
      'marketplace_instructor_profile_changes_decision',
      'marketplace_instructor',
      instructorId,
      details.instructorName,
      details,
      ipAddress ?? null,
    );
  }
}

export class MarketplaceCourseApprovedEvent extends AuditEvent {
  constructor(adminId: string, courseId: string, details: { courseTitle: string }, ipAddress?: string) {
    super(
      adminId,
      'marketplace_course_approved',
      'marketplace_course',
      courseId,
      details.courseTitle,
      details,
      ipAddress ?? null,
    );
  }
}

export class MarketplaceCourseRejectedEvent extends AuditEvent {
  constructor(
    adminId: string,
    courseId: string,
    details: { courseTitle: string; reasons: string[] },
    ipAddress?: string,
  ) {
    super(
      adminId,
      'marketplace_course_rejected',
      'marketplace_course',
      courseId,
      details.courseTitle,
      details,
      ipAddress ?? null,
    );
  }
}

/** An administrator's decision on a material edit to an already-published course (FR-071). */
export class MarketplaceCoursePendingEditApprovedEvent extends AuditEvent {
  constructor(adminId: string, courseId: string, details: { courseTitle: string }, ipAddress?: string) {
    super(
      adminId,
      'marketplace_course_pending_edit_approved',
      'marketplace_course',
      courseId,
      details.courseTitle,
      details,
      ipAddress ?? null,
    );
  }
}

export class MarketplaceCoursePendingEditRejectedEvent extends AuditEvent {
  constructor(
    adminId: string,
    courseId: string,
    details: { courseTitle: string; reasons: string[] },
    ipAddress?: string,
  ) {
    super(
      adminId,
      'marketplace_course_pending_edit_rejected',
      'marketplace_course',
      courseId,
      details.courseTitle,
      details,
      ipAddress ?? null,
    );
  }
}

/**
 * FR-068 — an *administrator's* unpublish, with its mandatory reason; a
 * plain instructor unpublish (FR-069, their own choice, no reason) is a
 * self-service action and is not audited here, matching the same
 * privileged-vs-self-service line the applications events draw.
 */
export class MarketplaceCourseUnpublishedEvent extends AuditEvent {
  constructor(adminId: string, courseId: string, details: { courseTitle: string; reason: string }, ipAddress?: string) {
    super(
      adminId,
      'marketplace_course_unpublished',
      'marketplace_course',
      courseId,
      details.courseTitle,
      details,
      ipAddress ?? null,
    );
  }
}

/** FR-054a permanent removal — distinct from an ordinary unpublish. */
export class MarketplaceCourseRemovedEvent extends AuditEvent {
  constructor(
    adminId: string,
    courseId: string,
    details: { courseTitle: string; cause: string; reason: string },
    ipAddress?: string,
  ) {
    super(
      adminId,
      'marketplace_course_removed',
      'marketplace_course',
      courseId,
      details.courseTitle,
      details,
      ipAddress ?? null,
    );
  }
}

/** An administrator recorded a refund they paid back outside the gateway API (D1). */
export class MarketplaceRefundManuallyCompletedEvent extends AuditEvent {
  constructor(
    adminId: string,
    refundRequestId: string,
    details: { orderId: string; refundReference: string; amountMinor: number; currency: string },
    ipAddress?: string,
  ) {
    super(
      adminId,
      'marketplace_refund_manually_completed',
      'marketplace_refund_request',
      refundRequestId,
      null,
      details,
      ipAddress ?? null,
    );
  }
}

export class MarketplaceRefundDecisionEvent extends AuditEvent {
  constructor(
    adminId: string,
    refundRequestId: string,
    details: { orderId: string; decision: 'approved' | 'rejected'; discretionary: boolean; reason?: string },
    ipAddress?: string,
  ) {
    super(
      adminId,
      'marketplace_refund_decision',
      'marketplace_refund_request',
      refundRequestId,
      null,
      details,
      ipAddress ?? null,
    );
  }
}

export class MarketplacePayoutDecisionEvent extends AuditEvent {
  constructor(
    adminId: string,
    payoutRequestId: string,
    details: {
      instructorId: string;
      decision: 'approved' | 'rejected' | 'processing' | 'paid' | 'failed';
      reason?: string;
      payoutReference?: string;
    },
    ipAddress?: string,
  ) {
    super(
      adminId,
      'marketplace_payout_decision',
      'marketplace_payout_request',
      payoutRequestId,
      null,
      details,
      ipAddress ?? null,
    );
  }
}

export class MarketplaceCommissionRateChangedEvent extends AuditEvent {
  constructor(
    adminId: string,
    commissionSettingId: string,
    details: { previousRateBps: number | null; newRateBps: number; scope: string },
    ipAddress?: string,
  ) {
    super(
      adminId,
      'marketplace_commission_rate_changed',
      'marketplace_commission_setting',
      commissionSettingId,
      null,
      details,
      ipAddress ?? null,
    );
  }
}

/** A manual ledger adjustment always carries a mandatory reason (FR-168, FR-288). */
export class MarketplaceLedgerAdjustmentEvent extends AuditEvent {
  constructor(
    adminId: string,
    ledgerEntryId: string,
    details: { instructorId: string; amountMinor: number; currency: string; reason: string },
    ipAddress?: string,
  ) {
    super(
      adminId,
      'marketplace_ledger_adjustment',
      'marketplace_ledger_entry',
      ledgerEntryId,
      null,
      details,
      ipAddress ?? null,
    );
  }
}
