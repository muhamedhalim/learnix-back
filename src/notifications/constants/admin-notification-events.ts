import { AdminNotificationCategory } from '../entities/admin-notification-category.enum';
import { NotificationPriority } from '../entities/notification-priority.enum';

/**
 * The complete allow-list of events that may notify an admin's personal
 * inbox (`GET /admin/my-notifications`, backed by the per-user
 * `GET /notifications` endpoint).
 *
 * This is the single governance point requested for the admin-notifications
 * cleanup: an admin must see only rows created for one of these events, not
 * every notification a future feature happens to write while the recipient's
 * `user_id` is an admin's. `NotificationsService.findAllForUser` enforces
 * this allow-list whenever the caller is an admin (see `applyAdminInboxScope`
 * for the exact predicate, including how `OPERATIONAL_ALERT` is restricted to
 * business categories and how pre-catalog rows are treated).
 *
 * Every current admin-notification creation path is routed through this
 * catalog:
 *   - `AdminNotificationsService.notifyAdmins()` — the shared, non-
 *     transactional fan-out used by `OperationalAlertService`,
 *     `SettlementsService`, and the `AdminAlertsListener` event handlers.
 *   - `ManualPaymentsService`'s transactional raw insert, which imports
 *     `ADMIN_NOTIFICATION_CATALOG` directly for its priority/category
 *     defaults because it runs inside a DB transaction and cannot go through
 *     `NotificationsService.create()`.
 *
 * Adding a new admin-facing notification means adding a member here first —
 * there is no other way for a row to pass the read-time allow-list.
 */
export enum AdminNotificationEvent {
  /** A registrant requested the teacher role; the account is PENDING approval. */
  TEACHER_REGISTRATION_PENDING = 'teacher_registration_pending',
  /** A teacher published a course/module that is now live and worth reviewing. */
  COURSE_PUBLISHED_FOR_REVIEW = 'course_published_for_review',
  /** An order was paid and entitlement granted. */
  PURCHASE_COMPLETED = 'purchase_completed',
  /** A student submitted manual-payment proof awaiting admin review. */
  MANUAL_PAYMENT_REVIEW_REQUIRED = 'manual_payment_review_required',
  /** A teacher has an unpaid available balance sitting past the payout threshold. */
  PAYOUT_DUE = 'payout_due',
  /**
   * A BUSINESS incident (financial or security) raised by `OperationalAlertService`
   * for a `business`-audience alert. Technical/monitoring alerts are not admin
   * notifications and are rejected by {@link isAdminInboxEligible}.
   */
  OPERATIONAL_ALERT = 'operational_alert',
  /** Marketplace: a professional-instructor application was submitted, awaiting review (FR-268). */
  MARKETPLACE_APPLICATION_SUBMITTED = 'marketplace_application_submitted',
  /** Marketplace: a course was submitted for approval, awaiting review (FR-268). */
  MARKETPLACE_COURSE_SUBMITTED = 'marketplace_course_submitted',
  /** Marketplace: a learner requested a refund (FR-268). */
  MARKETPLACE_REFUND_REQUESTED = 'marketplace_refund_requested',
  /** Marketplace: an instructor requested a payout (FR-268). */
  MARKETPLACE_PAYOUT_REQUESTED = 'marketplace_payout_requested',
}

/**
 * `OPERATIONAL_ALERT` is the one catalogued event that can carry either kind
 * of content, so the event alone does not decide eligibility for the admin
 * inbox. Business incidents (a stuck/quarantined payment or refund, a security
 * incident) need an administrator to act; infrastructure/monitoring signals
 * (component health, thresholds, queue backlog, scheduled-job failures) do not
 * belong here and live on the health console (`/admin/health`), email and the
 * alert webhook instead.
 *
 * The discriminator is the notification `category`, which is derived from the
 * alert's producer key by {@link BUSINESS_ALERT_CATEGORY_PREFIXES} — never from
 * the displayed text.
 */
export const ADMIN_INBOX_OPERATIONAL_CATEGORIES: readonly AdminNotificationCategory[] =
  Object.freeze([AdminNotificationCategory.FINANCIAL, AdminNotificationCategory.SECURITY]);

/**
 * Alert-key prefix → category for alerts that are business incidents. An alert
 * key that matches none of these is a technical/monitoring signal.
 */
export const BUSINESS_ALERT_CATEGORY_PREFIXES: ReadonlyArray<
  readonly [prefix: string, category: AdminNotificationCategory]
> = Object.freeze([
  ['payment.', AdminNotificationCategory.FINANCIAL],
  ['refund.', AdminNotificationCategory.FINANCIAL],
  ['finance.', AdminNotificationCategory.FINANCIAL],
  ['security.', AdminNotificationCategory.SECURITY],
  ['auth.', AdminNotificationCategory.SECURITY],
] as const);

/** Events that always belong in the admin inbox, whatever their category. */
export const ADMIN_INBOX_ALWAYS_ELIGIBLE_EVENTS: readonly AdminNotificationEvent[] = Object.freeze(
  Object.values(AdminNotificationEvent).filter(
    (event) => event !== AdminNotificationEvent.OPERATIONAL_ALERT,
  ),
);

/**
 * The single eligibility rule for "this is a business notification an admin
 * must see". Used when a notification is created (`AdminNotificationsService`)
 * and mirrored in SQL by `adminInboxScope` for reads, so the two boundaries
 * cannot disagree.
 */
export function isAdminInboxEligible(
  event: AdminNotificationEvent,
  category: AdminNotificationCategory | null | undefined,
): boolean {
  if (event !== AdminNotificationEvent.OPERATIONAL_ALERT) return true;
  return (
    category !== null &&
    category !== undefined &&
    ADMIN_INBOX_OPERATIONAL_CATEGORIES.includes(category)
  );
}

export interface AdminNotificationDefaults {
  priority: NotificationPriority;
  category: AdminNotificationCategory;
}

/** Default priority/category per event; individual call sites may override. */
export const ADMIN_NOTIFICATION_CATALOG: Readonly<
  Record<AdminNotificationEvent, AdminNotificationDefaults>
> = Object.freeze({
  [AdminNotificationEvent.TEACHER_REGISTRATION_PENDING]: {
    priority: NotificationPriority.HIGH,
    category: AdminNotificationCategory.INSTRUCTOR_APPROVAL,
  },
  [AdminNotificationEvent.COURSE_PUBLISHED_FOR_REVIEW]: {
    priority: NotificationPriority.MEDIUM,
    category: AdminNotificationCategory.CONTENT_REVIEW,
  },
  [AdminNotificationEvent.PURCHASE_COMPLETED]: {
    priority: NotificationPriority.MEDIUM,
    category: AdminNotificationCategory.FINANCIAL,
  },
  [AdminNotificationEvent.MANUAL_PAYMENT_REVIEW_REQUIRED]: {
    priority: NotificationPriority.HIGH,
    category: AdminNotificationCategory.FINANCIAL,
  },
  [AdminNotificationEvent.PAYOUT_DUE]: {
    priority: NotificationPriority.MEDIUM,
    category: AdminNotificationCategory.PAYOUT,
  },
  // Deliberately `SYSTEM`: not an inbox-eligible category, so a caller that does
  // not pass an explicit business category is rejected rather than silently
  // filed as a business notification.
  [AdminNotificationEvent.OPERATIONAL_ALERT]: {
    priority: NotificationPriority.HIGH,
    category: AdminNotificationCategory.SYSTEM,
  },
  [AdminNotificationEvent.MARKETPLACE_APPLICATION_SUBMITTED]: {
    priority: NotificationPriority.MEDIUM,
    category: AdminNotificationCategory.INSTRUCTOR_APPROVAL,
  },
  [AdminNotificationEvent.MARKETPLACE_COURSE_SUBMITTED]: {
    priority: NotificationPriority.MEDIUM,
    category: AdminNotificationCategory.CONTENT_REVIEW,
  },
  [AdminNotificationEvent.MARKETPLACE_REFUND_REQUESTED]: {
    priority: NotificationPriority.MEDIUM,
    category: AdminNotificationCategory.FINANCIAL,
  },
  [AdminNotificationEvent.MARKETPLACE_PAYOUT_REQUESTED]: {
    priority: NotificationPriority.MEDIUM,
    category: AdminNotificationCategory.PAYOUT,
  },
});
