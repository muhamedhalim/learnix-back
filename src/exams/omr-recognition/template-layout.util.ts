import { createHash } from 'node:crypto';

import type { ExamQuestion } from '../entities/exam-question.entity';
import { QuestionType } from '../entities/question-type.enum';
import type {
  OmrBubbleSpec,
  OmrQuestionLayout,
  OmrQuestionType,
  OmrTemplateLayout,
} from '../entities/omr-template.types';
import {
  BUBBLE_RADIUS_MM,
  BUBBLE_SPACING_MM,
  HEADER_HEIGHT_MM,
  LABEL_COLUMN_WIDTH_MM,
  MARKER_SIZE_MM,
  MAX_OPTIONS_PER_QUESTION,
  PAGE_HEIGHT_MM,
  PAGE_MARGIN_MM,
  PAGE_WIDTH_MM,
  QR_SIZE_MM,
  ROW_HEIGHT_MM,
} from './constants';

const OMR_ELIGIBLE_TYPES = new Set<QuestionType>([
  QuestionType.SINGLE_CHOICE,
  QuestionType.TRUE_FALSE,
  QuestionType.MULTIPLE_SELECT,
]);

/**
 * Question types that a bubble sheet fundamentally cannot capture and that
 * ALSO have no recourse elsewhere in the app if silently excluded:
 * `numeric`/`fill_blank` auto-grade a missing response straight to zero, and
 * `TeacherGradingService.gradeAnswer` explicitly refuses to let a teacher
 * touch `AUTO_GRADED_TYPES` afterward. `essay` is fine to coexist — it
 * always requires manual grading through the existing flow regardless of
 * how its response arrives, so leaving it off the sheet is a genuine no-op
 * for that question, not a silent zero.
 */
export const OMR_BLOCKING_TYPES = new Set<QuestionType>([
  QuestionType.NUMERIC,
  QuestionType.FILL_BLANK,
]);

export class OmrLayoutError extends Error {}

/** How many question rows fit on a single answer-sheet page, given the fixed row geometry. */
export function maxQuestionsPerTemplate(): number {
  const top = PAGE_MARGIN_MM + HEADER_HEIGHT_MM;
  const bottom = PAGE_HEIGHT_MM - PAGE_MARGIN_MM - MARKER_SIZE_MM;
  return Math.max(0, Math.floor((bottom - top) / ROW_HEIGHT_MM));
}

interface OptionsContent {
  options?: unknown;
}

function optionIdsInOrder(content: unknown): string[] {
  const options = (content as OptionsContent | undefined)?.options;
  if (!Array.isArray(options)) return [];
  return options
    .map((o) =>
      o && typeof o === 'object' && 'id' in o ? String((o as { id: unknown }).id) : null,
    )
    .filter((id): id is string => id !== null);
}

function bubblesForQuestion(type: OmrQuestionType, content: unknown): OmrBubbleSpec[] {
  if (type === QuestionType.TRUE_FALSE) {
    return [
      { kind: 'boolean', value: true, x: 0, y: 0 },
      { kind: 'boolean', value: false, x: 0, y: 0 },
    ];
  }
  return optionIdsInOrder(content).map((optionId) => ({ kind: 'option', optionId, x: 0, y: 0 }));
}

/**
 * Deterministic answer-sheet layout for an exam's OMR-eligible questions.
 * Pure function of the exam's snapshotted question set — same input always
 * produces the same geometry, independent of `shuffle_choices` (which only
 * ever affects the *online* rendering path, never storage/grading/printing;
 * a printed sheet always reflects `content_snapshot.options` in stored
 * array order).
 *
 * Scope: single answer-sheet page (see `maxQuestionsPerTemplate`) — this
 * keeps bubble spacing generous and reliable to scan. An exam with more
 * OMR-eligible questions than fit is rejected outright rather than shrinking
 * bubbles to an unreliable size or splitting across pages (which would need
 * per-page markers/QR/identity and a multi-image upload flow).
 */
export function generateOmrTemplateLayout(
  examQuestions: readonly ExamQuestion[],
): OmrTemplateLayout {
  const ordered = [...examQuestions].sort((a, b) => a.order_index - b.order_index);

  const blocking = ordered.filter((eq) => OMR_BLOCKING_TYPES.has(eq.type_snapshot));
  if (blocking.length > 0) {
    throw new OmrLayoutError(
      `This exam has ${String(blocking.length)} question(s) that cannot be captured by an OMR sheet ` +
        `and have no manual-grading fallback (numeric/fill-in-the-blank): ` +
        blocking.map((eq) => eq.id).join(', '),
    );
  }

  // Label = 1-based position among ALL exam questions (including essays), so
  // printed numbers match whatever question paper the teacher hands out
  // alongside the sheet — essay questions are simply not printed as a row.
  const eligible: { eq: ExamQuestion; label: number }[] = [];
  ordered.forEach((eq, index) => {
    if (OMR_ELIGIBLE_TYPES.has(eq.type_snapshot)) {
      eligible.push({ eq, label: index + 1 });
    }
  });

  if (eligible.length === 0) {
    throw new OmrLayoutError(
      'This exam has no single-choice, true/false, or multiple-select questions.',
    );
  }
  const capacity = maxQuestionsPerTemplate();
  if (eligible.length > capacity) {
    throw new OmrLayoutError(
      `This exam has ${String(eligible.length)} OMR-eligible questions, which exceeds the single-page ` +
        `limit of ${String(capacity)}.`,
    );
  }
  const tooManyOptions = eligible.find(
    ({ eq }) =>
      bubblesForQuestion(eq.type_snapshot as OmrQuestionType, eq.content_snapshot).length >
      MAX_OPTIONS_PER_QUESTION,
  );
  if (tooManyOptions) {
    throw new OmrLayoutError(
      `Question ${tooManyOptions.eq.id} has more than ${String(MAX_OPTIONS_PER_QUESTION)} options, which an OMR sheet cannot lay out.`,
    );
  }

  const bubbleColumnStartX = PAGE_MARGIN_MM + LABEL_COLUMN_WIDTH_MM;
  const questions: OmrQuestionLayout[] = eligible.map(({ eq, label }, rowIndex) => {
    const rowY = PAGE_MARGIN_MM + HEADER_HEIGHT_MM + rowIndex * ROW_HEIGHT_MM + ROW_HEIGHT_MM / 2;
    const bubbles = bubblesForQuestion(
      eq.type_snapshot as OmrQuestionType,
      eq.content_snapshot,
    ).map((bubble, i) => ({
      ...bubble,
      x: bubbleColumnStartX + i * BUBBLE_SPACING_MM + BUBBLE_SPACING_MM / 2,
      y: rowY,
    }));
    return {
      examQuestionId: eq.id,
      orderIndex: eq.order_index,
      type: eq.type_snapshot as OmrQuestionType,
      label,
      bubbles,
    };
  });

  const markerInset = MARKER_SIZE_MM / 2;
  return {
    layoutVersion: 1,
    pageWidthMm: PAGE_WIDTH_MM,
    pageHeightMm: PAGE_HEIGHT_MM,
    bubbleRadiusMm: BUBBLE_RADIUS_MM,
    markers: {
      topLeft: { x: PAGE_MARGIN_MM, y: PAGE_MARGIN_MM, sizeMm: MARKER_SIZE_MM },
      topRight: { x: PAGE_WIDTH_MM - PAGE_MARGIN_MM, y: PAGE_MARGIN_MM, sizeMm: MARKER_SIZE_MM },
      bottomLeft: { x: PAGE_MARGIN_MM, y: PAGE_HEIGHT_MM - PAGE_MARGIN_MM, sizeMm: MARKER_SIZE_MM },
      bottomRight: {
        x: PAGE_WIDTH_MM - PAGE_MARGIN_MM,
        y: PAGE_HEIGHT_MM - PAGE_MARGIN_MM,
        sizeMm: MARKER_SIZE_MM,
      },
    },
    qr: {
      x: PAGE_WIDTH_MM / 2 - QR_SIZE_MM / 2,
      y: PAGE_MARGIN_MM + markerInset + 2,
      sizeMm: QR_SIZE_MM,
    },
    questions,
  };
}

/**
 * Fingerprint of exactly the fields that determine sheet geometry/mapping —
 * NOT question wording (which never appears on the bubble-only answer
 * sheet). A change here means `OmrTemplatesService` must generate a new
 * template version; wording-only edits don't.
 */
export function computeOmrContentHash(examQuestions: readonly ExamQuestion[]): string {
  const ordered = [...examQuestions].sort((a, b) => a.order_index - b.order_index);
  const fingerprint = ordered.map((eq) => ({
    id: eq.id,
    type: eq.type_snapshot,
    eligible: OMR_ELIGIBLE_TYPES.has(eq.type_snapshot),
    optionIds: OMR_ELIGIBLE_TYPES.has(eq.type_snapshot)
      ? optionIdsInOrder(eq.content_snapshot)
      : undefined,
  }));
  return createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex');
}
