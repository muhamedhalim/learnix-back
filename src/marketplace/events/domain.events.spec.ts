import * as DomainEvents from './domain.events';

const EXPECTED_EVENT_NAMES = [
  'marketplace.application.submitted',
  'marketplace.application.approved',
  'marketplace.application.rejected',
  'marketplace.instructor.suspended',
  'marketplace.instructor.reinstated',
  'marketplace.course.submitted',
  'marketplace.course.approved',
  'marketplace.course.rejected',
  'marketplace.course.published',
  'marketplace.course.unpublished',
  'marketplace.course.removed',
  'marketplace.course.completed',
  'marketplace.order.created',
  'marketplace.order.paid',
  'marketplace.order.failed',
  // FR-104 — not in plan.md §7's original list; added during T099 (see
  // tasks.md's discrepancy note) once building the webhook handler
  // surfaced a real need for a notification hook on a verified-but-mismatched capture.
  'marketplace.payment.discrepancy',
  'marketplace.enrollment.granted',
  'marketplace.enrollment.revoked',
  'marketplace.earning.created',
  'marketplace.earning.cleared',
  'marketplace.earning.reversed',
  'marketplace.refund.requested',
  'marketplace.refund.refused',
  'marketplace.refund.completed',
  'marketplace.refund.failed',
  'marketplace.payout.requested',
  'marketplace.payout.approved',
  'marketplace.payout.rejected',
  'marketplace.payout.processing',
  'marketplace.payout.paid',
  'marketplace.payout.failed',
  'marketplace.review.created',
  'marketplace.review.replied',
  'marketplace.review.moderated',
];

function eventClasses(): Array<[string, new (...args: never[]) => object]> {
  return Object.entries(DomainEvents).filter(([name]) => name.endsWith('Event')) as Array<
    [string, new (...args: never[]) => object]
  >;
}

describe('marketplace domain events (plan.md §7)', () => {
  it('defines every event plan.md §7 lists, each with a marketplace.<domain>.<verb> name', () => {
    const names = eventClasses().map(([, Ctor]) => (Ctor as unknown as { EVENT_NAME: string }).EVENT_NAME);
    expect(names.sort()).toEqual(EXPECTED_EVENT_NAMES.sort());
  });

  it('every EVENT_NAME is unique', () => {
    const names = eventClasses().map(([, Ctor]) => (Ctor as unknown as { EVENT_NAME: string }).EVENT_NAME);
    expect(new Set(names).size).toBe(names.length);
  });

  describe('financial events carry the order id, never the amount alone', () => {
    it.each([
      new DomainEvents.MarketplaceOrderPaidEvent('order-1'),
      new DomainEvents.MarketplaceOrderFailedEvent('order-1', 'declined'),
      new DomainEvents.MarketplaceEarningCreatedEvent('earning-1', 'order-1', 'instructor-1'),
      new DomainEvents.MarketplaceEarningClearedEvent('earning-1', 'order-1', 'instructor-1'),
      new DomainEvents.MarketplaceEarningReversedEvent('earning-1', 'order-1', 'instructor-1'),
      new DomainEvents.MarketplaceRefundCompletedEvent('refund-1', 'order-1', 'learner-1', 'instructor-1', false),
    ])('%#: carries orderId and no amount field', (event) => {
      expect((event as unknown as { orderId: string }).orderId).toBe('order-1');
      expect(Object.keys(event)).not.toEqual(
        expect.arrayContaining(['amount', 'amountMinor', 'grossAmountMinor', 'netAmountMinor']),
      );
    });
  });

  it('MarketplaceEnrollmentGrantedEvent distinguishes a paid sale from a free enrollment (FR-275)', () => {
    const paid = new DomainEvents.MarketplaceEnrollmentGrantedEvent('enr-1', 'order-1', 'learner-1', 'course-1', false);
    const free = new DomainEvents.MarketplaceEnrollmentGrantedEvent('enr-2', 'order-2', 'learner-1', 'course-1', true);
    expect(paid.isZeroValue).toBe(false);
    expect(free.isZeroValue).toBe(true);
  });

  it('MarketplaceCourseRemovedEvent is distinct from an ordinary unpublish and carries the FR-054a cause and reason', () => {
    const removed = new DomainEvents.MarketplaceCourseRemovedEvent(
      'course-1',
      'instructor-1',
      'legal_takedown',
      'DMCA notice',
    );
    expect(removed.cause).toBe('legal_takedown');
    expect(removed.reason).toBe('DMCA notice');
    expect(DomainEvents.MarketplaceCourseRemovedEvent.EVENT_NAME).not.toBe(
      DomainEvents.MarketplaceCourseUnpublishedEvent.EVENT_NAME,
    );
  });
});
