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
 * this allow-list whenever the caller is an admin (falling back to
 * `origin = OPERATIONAL` too, so pre-existing operational-alert rows whose
 * `source_event` predates this catalog are not hidden).
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
  /** A financial/system/security incident raised by `OperationalAlertService`. */
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
