/**
 * Marketplace domain events (plan.md §7), emitted through the existing
 * `@nestjs/event-emitter` after the triggering transaction commits.
 * Listeners handle notification and audit fan-out so no service reaches
 * directly into another module.
 *
 * Financial events carry the order id and never the amounts alone — a
 * listener always resolves current truth from the ledger rather than
 * trusting an event payload (plan.md §7).
 */

export class MarketplaceApplicationSubmittedEvent {
  public static readonly EVENT_NAME = 'marketplace.application.submitted';
  constructor(
    public readonly applicationId: string,
    /** Null for a public application: the applicant has no account until approval provisions one. */
    public readonly applicantUserId: string | null,
  ) {}
}

export class MarketplaceApplicationApprovedEvent {
  public static readonly EVENT_NAME = 'marketplace.application.approved';
  constructor(
    public readonly applicationId: string,
    public readonly applicantUserId: string,
    public readonly instructorId: string,
  ) {}
}

export class MarketplaceApplicationRejectedEvent {
  public static readonly EVENT_NAME = 'marketplace.application.rejected';
  constructor(
    public readonly applicationId: string,
    /** Null for a rejected public application: no account was ever provisioned for it. */
    public readonly applicantUserId: string | null,
    public readonly reason: string,
  ) {}
}

export class MarketplaceInstructorSuspendedEvent {
  public static readonly EVENT_NAME = 'marketplace.instructor.suspended';
  constructor(
    public readonly instructorId: string,
    public readonly userId: string,
    public readonly reason: string,
  ) {}
}

export class MarketplaceInstructorReinstatedEvent {
  public static readonly EVENT_NAME = 'marketplace.instructor.reinstated';
  constructor(
    public readonly instructorId: string,
    public readonly userId: string,
  ) {}
}

export class MarketplaceCourseSubmittedEvent {
  public static readonly EVENT_NAME = 'marketplace.course.submitted';
  constructor(
    public readonly courseId: string,
    public readonly instructorId: string,
  ) {}
}

export class MarketplaceCourseApprovedEvent {
  public static readonly EVENT_NAME = 'marketplace.course.approved';
  constructor(
    public readonly courseId: string,
    public readonly instructorId: string,
  ) {}
}

export class MarketplaceCourseRejectedEvent {
  public static readonly EVENT_NAME = 'marketplace.course.rejected';
  constructor(
    public readonly courseId: string,
    public readonly instructorId: string,
    public readonly reasons: string[],
  ) {}
}

export class MarketplaceCoursePublishedEvent {
  public static readonly EVENT_NAME = 'marketplace.course.published';
  constructor(
    public readonly courseId: string,
    public readonly instructorId: string,
    public readonly versionId: string,
  ) {}
}

export class MarketplaceCourseUnpublishedEvent {
  public static readonly EVENT_NAME = 'marketplace.course.unpublished';
  constructor(
    public readonly courseId: string,
    public readonly instructorId: string,
  ) {}
}

/** FR-054a permanent removal — distinct from an ordinary unpublish. */
export class MarketplaceCourseRemovedEvent {
  public static readonly EVENT_NAME = 'marketplace.course.removed';
  constructor(
    public readonly courseId: string,
    public readonly instructorId: string,
    public readonly cause: string,
    public readonly reason: string,
  ) {}
}

export class MarketplaceCourseCompletedEvent {
  public static readonly EVENT_NAME = 'marketplace.course.completed';
  constructor(
    public readonly enrollmentId: string,
    public readonly courseId: string,
    public readonly learnerId: string,
  ) {}
}

export class MarketplaceOrderCreatedEvent {
  public static readonly EVENT_NAME = 'marketplace.order.created';
  constructor(
    public readonly orderId: string,
    public readonly learnerId: string,
    public readonly courseId: string,
  ) {}
}

export class MarketplaceOrderPaidEvent {
  public static readonly EVENT_NAME = 'marketplace.order.paid';
  constructor(public readonly orderId: string) {}
}

export class MarketplaceOrderFailedEvent {
  public static readonly EVENT_NAME = 'marketplace.order.failed';
  constructor(
    public readonly orderId: string,
    public readonly reason: string,
  ) {}
}

export class MarketplaceEnrollmentGrantedEvent {
  public static readonly EVENT_NAME = 'marketplace.enrollment.granted';
  constructor(
    public readonly enrollmentId: string,
    public readonly orderId: string,
    public readonly learnerId: string,
    public readonly courseId: string,
    /** Distinguishes a paid sale from a free enrollment for FR-275's instructor notification. */
    public readonly isZeroValue: boolean,
  ) {}
}

export class MarketplaceEnrollmentRevokedEvent {
  public static readonly EVENT_NAME = 'marketplace.enrollment.revoked';
  constructor(
    public readonly enrollmentId: string,
    public readonly orderId: string,
    public readonly reason: string,
  ) {}
}

export class MarketplaceEarningCreatedEvent {
  public static readonly EVENT_NAME = 'marketplace.earning.created';
  constructor(
    public readonly earningId: string,
    public readonly orderId: string,
    public readonly instructorId: string,
  ) {}
}

export class MarketplaceEarningClearedEvent {
  public static readonly EVENT_NAME = 'marketplace.earning.cleared';
  constructor(
    public readonly earningId: string,
    public readonly orderId: string,
    public readonly instructorId: string,
  ) {}
}

export class MarketplaceEarningReversedEvent {
  public static readonly EVENT_NAME = 'marketplace.earning.reversed';
  constructor(
    public readonly earningId: string,
    public readonly orderId: string,
    public readonly instructorId: string,
  ) {}
}

export class MarketplaceRefundRequestedEvent {
  public static readonly EVENT_NAME = 'marketplace.refund.requested';
  constructor(
    public readonly refundRequestId: string,
    public readonly orderId: string,
    public readonly learnerId: string,
  ) {}
}

export class MarketplaceRefundRefusedEvent {
  public static readonly EVENT_NAME = 'marketplace.refund.refused';
  constructor(
    public readonly refundRequestId: string,
    public readonly orderId: string,
    public readonly failedCondition: string,
  ) {}
}

export class MarketplaceRefundCompletedEvent {
  public static readonly EVENT_NAME = 'marketplace.refund.completed';
  constructor(
    public readonly refundRequestId: string,
    public readonly orderId: string,
    public readonly learnerId: string,
    public readonly instructorId: string,
    public readonly isRemovalDriven: boolean,
  ) {}
}

/**
 * The refund was approved, but the payment gateway has no refund API, so an administrator has to pay
 * it back by hand and record it (`RefundProcessingService.completeManually`). Not a failure: nothing
 * went wrong, and the learner should not be told one did.
 */
export class MarketplaceRefundAwaitingPayoutEvent {
  public static readonly EVENT_NAME = 'marketplace.refund.awaiting_payout';
  constructor(
    public readonly refundRequestId: string,
    public readonly orderId: string,
  ) {}
}

export class MarketplaceRefundFailedEvent {
  public static readonly EVENT_NAME = 'marketplace.refund.failed';
  constructor(
    public readonly refundRequestId: string,
    public readonly orderId: string,
    public readonly reason: string,
  ) {}
}

export class MarketplacePayoutRequestedEvent {
  public static readonly EVENT_NAME = 'marketplace.payout.requested';
  constructor(
    public readonly payoutRequestId: string,
    public readonly instructorId: string,
  ) {}
}

export class MarketplacePayoutApprovedEvent {
  public static readonly EVENT_NAME = 'marketplace.payout.approved';
  constructor(
    public readonly payoutRequestId: string,
    public readonly instructorId: string,
  ) {}
}

export class MarketplacePayoutRejectedEvent {
  public static readonly EVENT_NAME = 'marketplace.payout.rejected';
  constructor(
    public readonly payoutRequestId: string,
    public readonly instructorId: string,
    public readonly reason: string,
  ) {}
}

export class MarketplacePayoutProcessingEvent {
  public static readonly EVENT_NAME = 'marketplace.payout.processing';
  constructor(
    public readonly payoutRequestId: string,
    public readonly instructorId: string,
  ) {}
}

export class MarketplacePayoutPaidEvent {
  public static readonly EVENT_NAME = 'marketplace.payout.paid';
  constructor(
    public readonly payoutRequestId: string,
    public readonly instructorId: string,
    public readonly payoutReference: string,
  ) {}
}

export class MarketplacePayoutFailedEvent {
  public static readonly EVENT_NAME = 'marketplace.payout.failed';
  constructor(
    public readonly payoutRequestId: string,
    public readonly instructorId: string,
    public readonly reason: string,
  ) {}
}

export class MarketplaceReviewCreatedEvent {
  public static readonly EVENT_NAME = 'marketplace.review.created';
  constructor(
    public readonly reviewId: string,
    public readonly courseId: string,
    public readonly instructorId: string,
  ) {}
}

export class MarketplaceReviewRepliedEvent {
  public static readonly EVENT_NAME = 'marketplace.review.replied';
  constructor(
    public readonly reviewId: string,
    public readonly courseId: string,
  ) {}
}

export class MarketplaceReviewModeratedEvent {
  public static readonly EVENT_NAME = 'marketplace.review.moderated';
  constructor(
    public readonly reviewId: string,
    public readonly status: string,
  ) {}
}

/**
 * FR-104 — a webhook-verified capture whose amount or currency does not
 * match the order's own snapshot. No human actor triggers this (it is
 * system-detected during webhook processing), so it is a domain event, not
 * an `AuditEvent` (`AuditEvent.adminId` is a required real actor id — see
 * `events/audit.events.ts`'s own doc comment). The mismatch itself is
 * recorded on the shared `Payment` row (`reconciliation_status`, same
 * field the academic fulfillment-compensation path already uses) so it
 * surfaces through whatever reconciliation tooling already watches that
 * column — this event exists purely so a notification listener (T119's
 * marketplace notifications submodule, not yet built) can alert the
 * learner and administrators without `MarketplaceSettlementService` itself
 * taking a dependency on that submodule ahead of its own task.
 */
export class MarketplacePaymentDiscrepancyEvent {
  public static readonly EVENT_NAME = 'marketplace.payment.discrepancy';
  constructor(
    public readonly orderId: string,
    public readonly paymentId: string,
    public readonly learnerId: string,
    public readonly reason: 'amount_mismatch' | 'currency_mismatch',
  ) {}
}
