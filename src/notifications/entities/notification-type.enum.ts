export enum NotificationType {
  ATTENDANCE = 'attendance',
  EXAM_RESULT = 'exam_result',
  EXAM_ASSIGNED = 'exam_assigned',
  HOMEWORK = 'homework',
  LESSON_EXPIRING = 'lesson_expiring',
  PURCHASE = 'purchase',
  GAMIFICATION = 'gamification',
  CUSTOM = 'custom',
  /**
   * Every Professional Courses Marketplace notification (FR-267 – FR-277) —
   * application status, course review, purchase/enrollment, refund
   * milestones, earnings and payout events. One umbrella value, matching
   * the granularity `PURCHASE` and `ATTENDANCE` already use for their own
   * academic domains; the specific event is carried in the notification's
   * title/body, not a further enum split. Additive only — FR-278 requires
   * no existing notification's routing or content to change.
   */
  MARKETPLACE = 'marketplace',
}
