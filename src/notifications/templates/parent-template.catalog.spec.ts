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

  /* ---------------------- DEF-006 · periodic reports ----------------------- */

  const REPORT_VARS = {
    studentName: 'Ahmed',
    periodType: 'weekly',
    periodStart: '2026-08-03',
    periodEnd: '2026-08-09',
    timeZone: 'Africa/Cairo',
    report: {
      version: 1,
      study: { sessions: 6, lessons: 4, minutes: 132, completed: 2 },
      attendance: { present: 3, absent: 1, late: 1, excused: 0, total: 5 },
      exams: { graded: 2, averagePercent: 78, passed: 2, failed: 0 },
      homework: { submitted: 3, graded: 2, averagePercent: 91, late: 1 },
      hasActivity: true,
    },
  };

  it('renders a weekly report in English from the stored counts', () => {
    const message = renderFromCatalog(
      ParentEventType.WEEKLY_REPORT,
      PreferredLanguage.EN,
      REPORT_VARS,
    );

    expect(message.templateKey).toBe('weekly_report.en');
    expect(message.body).toContain('Ahmed');
    expect(message.body).toContain('3 August – 9 August 2026');
    expect(message.body).toContain('Lessons: 4 — 132 min');
    expect(message.body).toContain('Completed: 2');
    expect(message.body).toContain('Attendance: 3 present, 1 absent, 1 late');
    expect(message.body).toContain('Exams: 2 — avg 78% (2 passed)');
    expect(message.body).toContain('Homework: 3 submitted, 2 graded — avg 91%');
  });

  it('renders the same report in Arabic from the same stored counts', () => {
    const message = renderFromCatalog(
      ParentEventType.WEEKLY_REPORT,
      PreferredLanguage.AR,
      REPORT_VARS,
    );

    // One aggregation, two languages — this is why the payload carries numbers
    // and never prose.
    expect(message.templateKey).toBe('weekly_report.ar');
    expect(message.body).toContain('الدروس: 4');
    expect(message.body).toContain('دروس مكتملة: 2');
    expect(message.body).toContain('الحضور: 3 حاضر، 1 غائب، 1 متأخر');
    expect(message.body).toContain('الامتحانات: 2');
    expect(message.body).toContain('الواجبات: 3');
  });

  it('labels a monthly period as a month rather than a date range', () => {
    const message = renderFromCatalog(ParentEventType.MONTHLY_REPORT, PreferredLanguage.EN, {
      ...REPORT_VARS,
      periodType: 'monthly',
      periodStart: '2026-07-01',
      periodEnd: '2026-07-31',
    });

    expect(message.templateKey).toBe('monthly_report.en');
    expect(message.body).toContain('July 2026');
    expect(message.body).not.toContain('–');
  });

  it('says the period was quiet instead of printing a wall of zeros', () => {
    const quiet = {
      ...REPORT_VARS,
      report: {
        version: 1,
        study: { sessions: 0, lessons: 0, minutes: 0, completed: 0 },
        attendance: { present: 0, absent: 0, late: 0, excused: 0, total: 0 },
        exams: { graded: 0, averagePercent: null, passed: 0, failed: 0 },
        homework: { submitted: 0, graded: 0, averagePercent: null, late: 0 },
        hasActivity: false,
      },
    };

    expect(
      renderFromCatalog(ParentEventType.WEEKLY_REPORT, PreferredLanguage.EN, quiet).body,
    ).toContain('No recorded activity');
    expect(
      renderFromCatalog(ParentEventType.WEEKLY_REPORT, PreferredLanguage.AR, quiet).body,
    ).toContain('لا يوجد نشاط');
  });

  it('omits sections with nothing in them rather than padding the SMS', () => {
    const message = renderFromCatalog(ParentEventType.WEEKLY_REPORT, PreferredLanguage.EN, {
      ...REPORT_VARS,
      report: {
        ...REPORT_VARS.report,
        attendance: { present: 0, absent: 0, late: 0, excused: 0, total: 0 },
        homework: { submitted: 0, graded: 0, averagePercent: null, late: 0 },
      },
    });

    expect(message.body).not.toContain('Attendance');
    expect(message.body).not.toContain('Homework');
    expect(message.body).toContain('Exams');
  });

  it('distinguishes "nothing graded" from "scored zero"', () => {
    const message = renderFromCatalog(ParentEventType.WEEKLY_REPORT, PreferredLanguage.EN, {
      ...REPORT_VARS,
      report: {
        ...REPORT_VARS.report,
        exams: { graded: 1, averagePercent: null, passed: 0, failed: 0 },
      },
    });

    // A null average means the score is not yet known — printing "avg 0%"
    // would tell a parent their child failed.
    expect(message.body).toContain('Exams: 1 (0 passed)');
    expect(message.body).not.toContain('avg 0%');
  });

  it('keeps the WhatsApp template at its approved three parameters', () => {
    const message = renderFromCatalog(
      ParentEventType.WEEKLY_REPORT,
      PreferredLanguage.AR,
      REPORT_VARS,
    );

    // Meta rejects a parameter-count mismatch at send time, so growing the
    // report must never grow this array.
    expect(message.whatsappTemplate?.name).toBe('parent_report_ar');
    expect(message.whatsappTemplate?.bodyParameters).toHaveLength(3);
    expect(message.whatsappTemplate?.bodyParameters[0]).toBe('Ahmed');
  });

  it('survives a payload written by an older engine version', () => {
    const message = renderFromCatalog(ParentEventType.WEEKLY_REPORT, PreferredLanguage.EN, {
      studentName: 'Ahmed',
      periodType: 'weekly',
      periodStart: '2026-08-03',
      periodEnd: '2026-08-09',
      report: { version: 0, hasActivity: true },
    });

    expect(message.body).not.toContain('undefined');
    expect(message.body).not.toContain('NaN');
  });
});
