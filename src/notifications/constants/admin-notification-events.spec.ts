import { AdminNotificationCategory } from '../entities/admin-notification-category.enum';
import {
  ADMIN_INBOX_ALWAYS_ELIGIBLE_EVENTS,
  ADMIN_NOTIFICATION_CATALOG,
  AdminNotificationEvent,
  BUSINESS_ALERT_CATEGORY_PREFIXES,
  isAdminInboxEligible,
} from './admin-notification-events';

describe('admin inbox eligibility', () => {
  it('admits every catalogued business event whatever its category', () => {
    for (const event of ADMIN_INBOX_ALWAYS_ELIGIBLE_EVENTS) {
      for (const category of Object.values(AdminNotificationCategory)) {
        expect(isAdminInboxEligible(event, category)).toBe(true);
      }
    }
  });

  it('admits an operational alert only for a financial or security category', () => {
    const event = AdminNotificationEvent.OPERATIONAL_ALERT;
    expect(isAdminInboxEligible(event, AdminNotificationCategory.FINANCIAL)).toBe(true);
    expect(isAdminInboxEligible(event, AdminNotificationCategory.SECURITY)).toBe(true);
    expect(isAdminInboxEligible(event, AdminNotificationCategory.SYSTEM)).toBe(false);
    expect(isAdminInboxEligible(event, AdminNotificationCategory.CONTENT_REVIEW)).toBe(false);
    expect(isAdminInboxEligible(event, AdminNotificationCategory.PAYOUT)).toBe(false);
    expect(isAdminInboxEligible(event, AdminNotificationCategory.INSTRUCTOR_APPROVAL)).toBe(false);
    expect(isAdminInboxEligible(event, null)).toBe(false);
    expect(isAdminInboxEligible(event, undefined)).toBe(false);
  });

  it('keeps operational_alert out of the always-eligible list', () => {
    expect(ADMIN_INBOX_ALWAYS_ELIGIBLE_EVENTS).not.toContain(
      AdminNotificationEvent.OPERATIONAL_ALERT,
    );
    expect(ADMIN_INBOX_ALWAYS_ELIGIBLE_EVENTS.length).toBe(
      Object.values(AdminNotificationEvent).length - 1,
    );
  });

  it('rejects an operational alert that only falls back to the catalog default category', () => {
    const { category } = ADMIN_NOTIFICATION_CATALOG[AdminNotificationEvent.OPERATIONAL_ALERT];
    expect(isAdminInboxEligible(AdminNotificationEvent.OPERATIONAL_ALERT, category)).toBe(false);
  });

  it('maps only payment/refund/finance/security/auth alert keys to business categories', () => {
    expect(BUSINESS_ALERT_CATEGORY_PREFIXES.map(([prefix]) => prefix)).toEqual([
      'payment.',
      'refund.',
      'finance.',
      'security.',
      'auth.',
    ]);
    for (const technicalKey of [
      'health-rule:component-degraded:postgresql',
      'scheduled_job.repeated_failure:cleanup',
      'queue.backlog:mail',
    ]) {
      expect(
        BUSINESS_ALERT_CATEGORY_PREFIXES.some(([prefix]) => technicalKey.startsWith(prefix)),
      ).toBe(false);
    }
  });
});
