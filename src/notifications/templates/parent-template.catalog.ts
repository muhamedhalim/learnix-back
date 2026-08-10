import { ParentEventType } from '../../common/events/parent-event-type.enum';
import { PreferredLanguage } from '../../guardians/entities';
import type { RenderedMessage } from './template.types';

/**
 * The message catalogue.
 *
 * Every string a guardian can receive lives here, in both languages. Business
 * services never build message text — they emit a domain event carrying typed
 * variables, and this file decides how it reads. Adding a language is adding a
 * column; adding an event is adding a row.
 *
 * `whatsappTemplateName` must match a template approved in Meta Business
 * Manager, and `bodyParameters` must match its `{{1}}…{{n}}` placeholders in
 * order. Keep the two in lockstep — Meta rejects a count mismatch at send time.
 */

type Vars = Record<string, unknown>;

const str = (variables: Vars, key: string, fallback = ''): string => {
  const value = variables[key];
  return value === null || value === undefined ? fallback : String(value);
};

const num = (variables: Vars, key: string): number => {
  const value = Number(variables[key]);
  return Number.isFinite(value) ? value : 0;
};

interface CatalogEntry {
  /** Approved Meta template name; omit when the event has no WhatsApp template. */
  whatsappTemplateName?: string;
  /** Ordered positional parameters for the Meta template. */
  parameters: (variables: Vars) => string[];
  /** Plain-text body (SMS + audit trail). */
  body: (variables: Vars) => string;
}

type Catalog = Record<ParentEventType, Record<PreferredLanguage, CatalogEntry>>;

/** `5 / 120` — omitted entirely when the rank could not be computed. */
function rankLine(variables: Vars, label: string): string {
  const rank = variables['rank'];
  const cohort = variables['cohortSize'];
  if (rank === null || rank === undefined || cohort === null || cohort === undefined) return '';
  return `\n${label}: ${String(rank)} / ${String(cohort)}`;
}

function notesLine(variables: Vars, label: string): string {
  const notes = str(variables, 'teacherNotes').trim();
  return notes === '' ? '' : `\n${label}: ${notes}`;
}

/* ------------------------- Periodic report wording ------------------------- */

/**
 * Weekly and monthly reports share one pair of entries.
 *
 * The report engine stores *counts only* (`parent_reports.payload`) and never
 * any prose — so all wording, in both languages, is decided here, from the same
 * stored row. That is what lets one aggregation serve a father who reads Arabic
 * and a mother who reads English without computing anything twice.
 *
 * The Meta template `parent_report_{ar,en}` takes three positional parameters
 * (name, period, summary) and the summary is assembled below, so adding a
 * metric to the report never requires re-approving a WhatsApp template.
 *
 * Sections with nothing in them are omitted rather than printed as zeros:
 * these bodies also go out over SMS, where Arabic is UCS-2 at 70 characters per
 * segment and every suppressed "Exams: 0" line is real money.
 */

/** Section reader tolerant of a payload written by an older engine version. */
function section(variables: Vars, name: string): Vars {
  const report = variables['report'];
  if (typeof report !== 'object' || report === null) return {};
  const part = (report as Record<string, unknown>)[name];
  if (typeof part !== 'object' || part === null) return {};
  return part as Vars;
}

function count(variables: Vars, sectionName: string, key: string): number {
  return num(section(variables, sectionName), key);
}

/** Null-safe percentage: `null` means "nothing was graded", not "scored 0". */
function percent(variables: Vars, sectionName: string): number | null {
  const value = section(variables, sectionName)['averagePercent'];
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function hasActivity(variables: Vars): boolean {
  const report = variables['report'];
  if (typeof report !== 'object' || report === null) return false;
  return (report as Record<string, unknown>)['hasActivity'] === true;
}

/** `YYYY-MM-DD` → a date at UTC noon, immune to either-way day slippage. */
function atNoonUtc(dateString: string): Date {
  return new Date(`${dateString}T12:00:00.000Z`);
}

function periodLabel(variables: Vars, locale: 'ar-EG' | 'en-GB'): string {
  const start = str(variables, 'periodStart');
  const end = str(variables, 'periodEnd');
  if (start === '' || end === '') return '';

  if (str(variables, 'periodType') === 'monthly') {
    return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(
      atNoonUtc(start),
    );
  }

  const dayMonth = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long' });
  const dayMonthYear = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  return `${dayMonth.format(atNoonUtc(start))} – ${dayMonthYear.format(atNoonUtc(end))}`;
}

function reportSummaryAr(v: Vars): string {
  if (!hasActivity(v)) {
    return 'لا يوجد نشاط مسجَّل خلال هذه الفترة.';
  }

  const lines: string[] = [];

  const minutes = count(v, 'study', 'minutes');
  const lessons = count(v, 'study', 'lessons');
  if (lessons > 0 || minutes > 0) {
    lines.push(`الدروس: ${String(lessons)} — ${String(minutes)} دقيقة`);
  }

  const completed = count(v, 'study', 'completed');
  if (completed > 0) lines.push(`دروس مكتملة: ${String(completed)}`);

  const present = count(v, 'attendance', 'present');
  const absent = count(v, 'attendance', 'absent');
  const late = count(v, 'attendance', 'late');
  if (count(v, 'attendance', 'total') > 0) {
    lines.push(`الحضور: ${String(present)} حاضر، ${String(absent)} غائب، ${String(late)} متأخر`);
  }

  const examsGraded = count(v, 'exams', 'graded');
  if (examsGraded > 0) {
    const average = percent(v, 'exams');
    lines.push(
      `الامتحانات: ${String(examsGraded)}` +
        (average === null ? '' : ` — المتوسط ${String(average)}%`) +
        ` (ناجح ${String(count(v, 'exams', 'passed'))})`,
    );
  }

  const submitted = count(v, 'homework', 'submitted');
  const graded = count(v, 'homework', 'graded');
  if (submitted > 0 || graded > 0) {
    const average = percent(v, 'homework');
    lines.push(
      `الواجبات: ${String(submitted)} مُسلَّم` +
        (graded > 0 ? `، ${String(graded)} مُصحَّح` : '') +
        (average === null ? '' : ` — المتوسط ${String(average)}%`),
    );
  }

  return lines.join('\n');
}

function reportSummaryEn(v: Vars): string {
  if (!hasActivity(v)) {
    return 'No recorded activity during this period.';
  }

  const lines: string[] = [];

  const minutes = count(v, 'study', 'minutes');
  const lessons = count(v, 'study', 'lessons');
  if (lessons > 0 || minutes > 0) {
    lines.push(`Lessons: ${String(lessons)} — ${String(minutes)} min`);
  }

  const completed = count(v, 'study', 'completed');
  if (completed > 0) lines.push(`Completed: ${String(completed)}`);

  if (count(v, 'attendance', 'total') > 0) {
    lines.push(
      `Attendance: ${String(count(v, 'attendance', 'present'))} present, ` +
        `${String(count(v, 'attendance', 'absent'))} absent, ` +
        `${String(count(v, 'attendance', 'late'))} late`,
    );
  }

  const examsGraded = count(v, 'exams', 'graded');
  if (examsGraded > 0) {
    const average = percent(v, 'exams');
    lines.push(
      `Exams: ${String(examsGraded)}` +
        (average === null ? '' : ` — avg ${String(average)}%`) +
        ` (${String(count(v, 'exams', 'passed'))} passed)`,
    );
  }

  const submitted = count(v, 'homework', 'submitted');
  const graded = count(v, 'homework', 'graded');
  if (submitted > 0 || graded > 0) {
    const average = percent(v, 'homework');
    lines.push(
      `Homework: ${String(submitted)} submitted` +
        (graded > 0 ? `, ${String(graded)} graded` : '') +
        (average === null ? '' : ` — avg ${String(average)}%`),
    );
  }

  return lines.join('\n');
}

const REPORT_ENTRY_AR: CatalogEntry = {
  whatsappTemplateName: 'parent_report_ar',
  parameters: (v) => [str(v, 'studentName'), periodLabel(v, 'ar-EG'), reportSummaryAr(v)],
  body: (v) =>
    `تقرير ${periodLabel(v, 'ar-EG')} لـ ${str(v, 'studentName')}:\n\n${reportSummaryAr(v)}`,
};

const REPORT_ENTRY_EN: CatalogEntry = {
  whatsappTemplateName: 'parent_report_en',
  parameters: (v) => [str(v, 'studentName'), periodLabel(v, 'en-GB'), reportSummaryEn(v)],
  body: (v) =>
    `${periodLabel(v, 'en-GB')} report for ${str(v, 'studentName')}:\n\n${reportSummaryEn(v)}`,
};

export const PARENT_TEMPLATE_CATALOG: Catalog = {
  [ParentEventType.EXAM_GRADED]: {
    [PreferredLanguage.AR]: {
      whatsappTemplateName: 'exam_graded_ar',
      parameters: (v) => [
        str(v, 'studentName'),
        str(v, 'examName'),
        `${String(num(v, 'score'))}/${String(num(v, 'totalMarks'))}`,
        `${String(num(v, 'percentage'))}%`,
        String(num(v, 'correctAnswers')),
        String(num(v, 'wrongAnswers')),
      ],
      body: (v) =>
        `أتمّ ${str(v, 'studentName')} امتحان "${str(v, 'examName')}".\n` +
        `الدرجة: ${String(num(v, 'score'))}/${String(num(v, 'totalMarks'))} (${String(num(v, 'percentage'))}%)\n` +
        `الحالة: ${v['passed'] === true ? 'ناجح' : 'غير ناجح'}\n` +
        `التاريخ: ${str(v, 'gradedAt')}\n` +
        `الإجابات الصحيحة: ${String(num(v, 'correctAnswers'))}\n` +
        `الإجابات الخاطئة: ${String(num(v, 'wrongAnswers'))}` +
        rankLine(v, 'الترتيب') +
        notesLine(v, 'ملاحظات المعلم') +
        (v['passed'] === true
          ? '\nأداء ممتاز. واصل تشجيع ابنك.'
          : '\nنتمنى له التوفيق في المرة القادمة.'),
    },
    [PreferredLanguage.EN]: {
      whatsappTemplateName: 'exam_graded_en',
      parameters: (v) => [
        str(v, 'studentName'),
        str(v, 'examName'),
        `${String(num(v, 'score'))}/${String(num(v, 'totalMarks'))}`,
        `${String(num(v, 'percentage'))}%`,
        String(num(v, 'correctAnswers')),
        String(num(v, 'wrongAnswers')),
      ],
      body: (v) =>
        `${str(v, 'studentName')} completed the "${str(v, 'examName')}" exam.\n` +
        `Score: ${String(num(v, 'score'))}/${String(num(v, 'totalMarks'))} (${String(num(v, 'percentage'))}%)\n` +
        `Status: ${v['passed'] === true ? 'Passed' : 'Failed'}\n` +
        `Date: ${str(v, 'gradedAt')}\n` +
        `Correct answers: ${String(num(v, 'correctAnswers'))}\n` +
        `Incorrect answers: ${String(num(v, 'wrongAnswers'))}` +
        rankLine(v, 'Rank') +
        notesLine(v, "Teacher's notes") +
        (v['passed'] === true
          ? '\nExcellent performance. Keep encouraging your child.'
          : '\nWe wish them better luck next time.'),
    },
  },

  [ParentEventType.ATTENDANCE_MARKED]: {
    [PreferredLanguage.AR]: {
      whatsappTemplateName: 'attendance_marked_ar',
      parameters: (v) => [str(v, 'studentName'), str(v, 'lessonName'), str(v, 'markedAt')],
      body: (v) =>
        `تم تسجيل حضور ${str(v, 'studentName')} في درس "${str(v, 'lessonName')}" بتاريخ ${str(v, 'markedAt')}.`,
    },
    [PreferredLanguage.EN]: {
      whatsappTemplateName: 'attendance_marked_en',
      parameters: (v) => [str(v, 'studentName'), str(v, 'lessonName'), str(v, 'markedAt')],
      body: (v) =>
        `${str(v, 'studentName')} was marked present for "${str(v, 'lessonName')}" on ${str(v, 'markedAt')}.`,
    },
  },

  [ParentEventType.HOMEWORK_ASSIGNED]: {
    [PreferredLanguage.AR]: {
      whatsappTemplateName: 'homework_assigned_ar',
      parameters: (v) => [
        str(v, 'studentName'),
        str(v, 'homeworkTitle'),
        str(v, 'dueAt', 'غير محدد'),
      ],
      body: (v) =>
        `تم إسناد واجب جديد إلى ${str(v, 'studentName')}: "${str(v, 'homeworkTitle')}" ` +
        `في درس "${str(v, 'lessonName')}".\nموعد التسليم: ${str(v, 'dueAt', 'غير محدد')}`,
    },
    [PreferredLanguage.EN]: {
      whatsappTemplateName: 'homework_assigned_en',
      parameters: (v) => [
        str(v, 'studentName'),
        str(v, 'homeworkTitle'),
        str(v, 'dueAt', 'not set'),
      ],
      body: (v) =>
        `${str(v, 'studentName')} has new homework: "${str(v, 'homeworkTitle')}" ` +
        `in "${str(v, 'lessonName')}".\nDue: ${str(v, 'dueAt', 'not set')}`,
    },
  },

  [ParentEventType.LESSON_COMPLETED]: {
    [PreferredLanguage.AR]: {
      whatsappTemplateName: 'lesson_completed_ar',
      parameters: (v) => [str(v, 'studentName'), str(v, 'lessonName')],
      body: (v) => `أكمل ${str(v, 'studentName')} درس "${str(v, 'lessonName')}".`,
    },
    [PreferredLanguage.EN]: {
      whatsappTemplateName: 'lesson_completed_en',
      parameters: (v) => [str(v, 'studentName'), str(v, 'lessonName')],
      body: (v) => `${str(v, 'studentName')} completed the lesson "${str(v, 'lessonName')}".`,
    },
  },

  [ParentEventType.COURSE_PURCHASED]: {
    [PreferredLanguage.AR]: {
      whatsappTemplateName: 'course_purchased_ar',
      parameters: (v) => [
        str(v, 'studentName'),
        str(v, 'itemName'),
        `${String(num(v, 'amount'))} ${str(v, 'currency', 'EGP')}`,
      ],
      body: (v) =>
        `تم تفعيل "${str(v, 'itemName')}" لحساب ${str(v, 'studentName')}.\n` +
        `المبلغ: ${String(num(v, 'amount'))} ${str(v, 'currency', 'EGP')}`,
    },
    [PreferredLanguage.EN]: {
      whatsappTemplateName: 'course_purchased_en',
      parameters: (v) => [
        str(v, 'studentName'),
        str(v, 'itemName'),
        `${String(num(v, 'amount'))} ${str(v, 'currency', 'EGP')}`,
      ],
      body: (v) =>
        `"${str(v, 'itemName')}" was activated for ${str(v, 'studentName')}.\n` +
        `Amount: ${String(num(v, 'amount'))} ${str(v, 'currency', 'EGP')}`,
    },
  },

  [ParentEventType.WEEKLY_REPORT]: {
    [PreferredLanguage.AR]: REPORT_ENTRY_AR,
    [PreferredLanguage.EN]: REPORT_ENTRY_EN,
  },

  [ParentEventType.MONTHLY_REPORT]: {
    [PreferredLanguage.AR]: REPORT_ENTRY_AR,
    [PreferredLanguage.EN]: REPORT_ENTRY_EN,
  },

  [ParentEventType.TEACHER_MESSAGE]: {
    [PreferredLanguage.AR]: {
      whatsappTemplateName: 'teacher_message_ar',
      parameters: (v) => [str(v, 'teacherName'), str(v, 'studentName'), str(v, 'message')],
      body: (v) =>
        `رسالة من المعلم ${str(v, 'teacherName')} بخصوص ${str(v, 'studentName')}:\n\n${str(v, 'message')}`,
    },
    [PreferredLanguage.EN]: {
      whatsappTemplateName: 'teacher_message_en',
      parameters: (v) => [str(v, 'teacherName'), str(v, 'studentName'), str(v, 'message')],
      body: (v) =>
        `Message from ${str(v, 'teacherName')} about ${str(v, 'studentName')}:\n\n${str(v, 'message')}`,
    },
  },

  [ParentEventType.GUARDIAN_VERIFICATION]: {
    [PreferredLanguage.AR]: {
      whatsappTemplateName: 'guardian_verification_ar',
      parameters: (v) => [str(v, 'code'), String(num(v, 'ttlMinutes'))],
      body: (v) =>
        `رمز التحقق الخاص بك هو ${str(v, 'code')}. صالح لمدة ${String(num(v, 'ttlMinutes'))} دقائق.\n` +
        `لا تشارك هذا الرمز مع أي شخص.`,
    },
    [PreferredLanguage.EN]: {
      whatsappTemplateName: 'guardian_verification_en',
      parameters: (v) => [str(v, 'code'), String(num(v, 'ttlMinutes'))],
      body: (v) =>
        `Your verification code is ${str(v, 'code')}. It expires in ${String(num(v, 'ttlMinutes'))} minutes.\n` +
        `Do not share this code with anyone.`,
    },
  },
};

export function renderFromCatalog(
  eventType: ParentEventType,
  language: PreferredLanguage,
  variables: Vars,
): RenderedMessage {
  const entry = PARENT_TEMPLATE_CATALOG[eventType][language];
  const templateKey = `${eventType}.${language}`;

  const rendered: RenderedMessage = {
    templateKey,
    body: entry.body(variables),
  };

  if (entry.whatsappTemplateName !== undefined) {
    rendered.whatsappTemplate = {
      name: entry.whatsappTemplateName,
      language,
      bodyParameters: entry.parameters(variables),
    };
  }

  return rendered;
}
