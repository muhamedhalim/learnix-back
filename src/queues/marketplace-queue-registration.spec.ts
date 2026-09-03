import { QUEUE_CONFIGS, QUEUE_NAMES } from './queues.constants';

/** T007: registering the marketplace queue must leave every existing registration untouched. */
describe('marketplace queue registration', () => {
  it('registers the marketplace queue name and a matching config entry', () => {
    expect(QUEUE_NAMES.MARKETPLACE).toBe('marketplace');
    expect(QUEUE_CONFIGS[QUEUE_NAMES.MARKETPLACE]).toBeDefined();
    expect(QUEUE_CONFIGS[QUEUE_NAMES.MARKETPLACE].defaultJobOptions.attempts).toBeGreaterThan(0);
  });

  it('leaves every pre-existing queue name unchanged', () => {
    const preExisting: Record<string, string> = {
      EMAIL: 'email',
      BULK_NOTIFICATIONS: 'bulk-notifications',
      IMAGE_PROCESSING: 'image-processing',
      FILE_CLEANUP: 'file-cleanup',
      CODE_GENERATION: 'code-generation',
      CODE_EXPORT: 'code-export',
      EXAM_AUTO_SUBMIT: 'exam-auto-submit',
      EXAM_AI_GRADING: 'exam-ai-grading',
      EXAM_OMR: 'exam-omr',
      EXAM_ANALYTICS: 'exam-analytics',
      GAMIFICATION: 'gamification',
      PARENT_NOTIFICATIONS: 'parent-notifications',
      PARENT_REPORTS: 'parent-reports',
      PUSH_NOTIFICATIONS: 'push-notifications',
      PARENT_NOTIFICATIONS_DLQ: 'parent-notifications-dlq',
      MEETING_PROVISIONING: 'meeting-provisioning',
    };
    for (const [key, value] of Object.entries(preExisting)) {
      expect((QUEUE_NAMES as Record<string, string>)[key]).toBe(value);
      expect(QUEUE_CONFIGS[value as keyof typeof QUEUE_CONFIGS]).toBeDefined();
    }
  });
});
