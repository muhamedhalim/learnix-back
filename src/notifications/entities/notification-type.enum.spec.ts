import { NotificationType } from './notification-type.enum';

/** T006: appending MARKETPLACE must be additive only (FR-278). */
describe('NotificationType additivity', () => {
  it('keeps every pre-existing notification type unchanged', () => {
    expect(NotificationType.ATTENDANCE).toBe('attendance');
    expect(NotificationType.EXAM_RESULT).toBe('exam_result');
    expect(NotificationType.EXAM_ASSIGNED).toBe('exam_assigned');
    expect(NotificationType.HOMEWORK).toBe('homework');
    expect(NotificationType.LESSON_EXPIRING).toBe('lesson_expiring');
    expect(NotificationType.PURCHASE).toBe('purchase');
    expect(NotificationType.GAMIFICATION).toBe('gamification');
    expect(NotificationType.CUSTOM).toBe('custom');
  });

  it('adds exactly one new marketplace value', () => {
    expect(NotificationType.MARKETPLACE).toBe('marketplace');
    expect(Object.values(NotificationType)).toHaveLength(9);
  });
});
