import { ParentEventType } from '../../common/events/parent-event-type.enum';
import { PreferredLanguage } from '../../guardians/entities';
import { PARENT_TEMPLATE_CATALOG, renderFromCatalog } from './parent-template.catalog';

const EXAM_VARS = {
  studentName: 'Ahmed',
  examName: 'Mathematics',
  score: 46,
  totalMarks: 50,
  percentage: 92,
  passed: true,
  status: 'passed',
  gradedAt: '2026-07-17T12:00:00.000Z',
  correctAnswers: 46,
  wrongAnswers: 4,
  rank: 5,
  cohortSize: 120,
  teacherNotes: 'Strong algebra.',
};

describe('parent template catalog', () => {
  it('covers every event type in every language', () => {
    for (const eventType of Object.values(ParentEventType)) {
      for (const language of Object.values(PreferredLanguage)) {
        expect(PARENT_TEMPLATE_CATALOG[eventType][language]).toBeDefined();
      }
    }
  });

  it('renders the exam result with score, rank, and answer counts', () => {
    const message = renderFromCatalog(ParentEventType.EXAM_GRADED, PreferredLanguage.EN, EXAM_VARS);

    expect(message.templateKey).toBe('exam_graded.en');
    expect(message.body).toContain('Ahmed');
    expect(message.body).toContain('Mathematics');
    expect(message.body).toContain('46/50');
    expect(message.body).toContain('92%');
    expect(message.body).toContain('Status: Passed');
    expect(message.body).toContain('Date: 2026-07-17T12:00:00.000Z');
    expect(message.body).toContain('Rank: 5 / 120');
    expect(message.body).toContain('Correct answers: 46');
    expect(message.body).toContain('Incorrect answers: 4');
    expect(message.body).toContain('Strong algebra.');
    expect(message.body).toContain('Excellent performance');
  });

  it('renders Arabic with the same facts', () => {
    const message = renderFromCatalog(ParentEventType.EXAM_GRADED, PreferredLanguage.AR, EXAM_VARS);

    expect(message.templateKey).toBe('exam_graded.ar');
    expect(message.body).toContain('Ahmed');
    expect(message.body).toContain('46/50');
    expect(message.body).toContain('الترتيب: 5 / 120');
  });

  it('omits the rank line entirely when the rank is unknown', () => {
    const message = renderFromCatalog(ParentEventType.EXAM_GRADED, PreferredLanguage.EN, {
      ...EXAM_VARS,
      rank: null,
      cohortSize: null,
    });

    expect(message.body).not.toContain('Rank');
    expect(message.body).toContain('92%');
  });

  it('omits the teacher-notes line when there are none', () => {
    const message = renderFromCatalog(ParentEventType.EXAM_GRADED, PreferredLanguage.EN, {
      ...EXAM_VARS,
      teacherNotes: '   ',
    });

    expect(message.body).not.toContain("Teacher's notes");
  });

  it('uses encouraging wording on a fail rather than congratulating', () => {
    const message = renderFromCatalog(ParentEventType.EXAM_GRADED, PreferredLanguage.EN, {
      ...EXAM_VARS,
      passed: false,
    });

    expect(message.body).not.toContain('Excellent performance');
    expect(message.body).toContain('next time');
  });

  it('supplies a WhatsApp template with positional parameters', () => {
    const message = renderFromCatalog(ParentEventType.EXAM_GRADED, PreferredLanguage.AR, EXAM_VARS);

    expect(message.whatsappTemplate).toEqual({
      name: 'exam_graded_ar',
      language: 'ar',
      bodyParameters: ['Ahmed', 'Mathematics', '46/50', '92%', '46', '4'],
    });
  });

  it('renders an OTP without leaking it into the template key', () => {
    const message = renderFromCatalog(ParentEventType.GUARDIAN_VERIFICATION, PreferredLanguage.EN, {
      code: '482913',
      ttlMinutes: 10,
    });

    expect(message.body).toContain('482913');
    expect(message.body).toContain('10 minutes');
    expect(message.templateKey).toBe('guardian_verification.en');
  });

  it('degrades gracefully when a variable is missing rather than printing undefined', () => {
    const message = renderFromCatalog(ParentEventType.EXAM_GRADED, PreferredLanguage.EN, {});

    expect(message.body).not.toContain('undefined');
    expect(message.body).not.toContain('NaN');
    expect(message.body).toContain('0/0');
  });
});
