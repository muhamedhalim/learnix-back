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
    [PreferredLanguage.AR]: {
      whatsappTemplateName: 'parent_report_ar',
      parameters: (v) => [str(v, 'studentName'), str(v, 'periodLabel'), str(v, 'summary')],
      body: (v) =>
        `تقرير ${str(v, 'periodLabel')} لـ ${str(v, 'studentName')}:\n\n${str(v, 'summary')}`,
    },
    [PreferredLanguage.EN]: {
      whatsappTemplateName: 'parent_report_en',
      parameters: (v) => [str(v, 'studentName'), str(v, 'periodLabel'), str(v, 'summary')],
      body: (v) =>
        `${str(v, 'periodLabel')} report for ${str(v, 'studentName')}:\n\n${str(v, 'summary')}`,
    },
  },

  [ParentEventType.MONTHLY_REPORT]: {
    [PreferredLanguage.AR]: {
      whatsappTemplateName: 'parent_report_ar',
      parameters: (v) => [str(v, 'studentName'), str(v, 'periodLabel'), str(v, 'summary')],
      body: (v) =>
        `تقرير ${str(v, 'periodLabel')} لـ ${str(v, 'studentName')}:\n\n${str(v, 'summary')}`,
    },
    [PreferredLanguage.EN]: {
      whatsappTemplateName: 'parent_report_en',
      parameters: (v) => [str(v, 'studentName'), str(v, 'periodLabel'), str(v, 'summary')],
      body: (v) =>
        `${str(v, 'periodLabel')} report for ${str(v, 'studentName')}:\n\n${str(v, 'summary')}`,
    },
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
