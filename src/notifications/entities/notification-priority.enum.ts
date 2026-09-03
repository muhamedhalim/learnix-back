/**
 * How urgently a notification needs a human to look at it. Currently
 * populated only for admin-facing notifications (see `AdminNotificationEvent`
 * / `ADMIN_NOTIFICATION_CATALOG`) — every other notification leaves this
 * column `null`.
 */
export enum NotificationPriority {
  CRITICAL = 'critical',
  HIGH = 'high',
  MEDIUM = 'medium',
}
