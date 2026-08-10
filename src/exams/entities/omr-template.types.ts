import type { QuestionType } from './question-type.enum';

/**
 * Deterministic per-sheet layout, shared by the PDF renderer and the
 * recognizer so both agree on exactly where every marker/bubble sits.
 * Coordinates are in millimetres, origin at the page's top-left — a plain
 * geometric space independent of any particular rendering/imaging library.
 */

/** One choice bubble (single_choice / multiple_select) tied to a specific option id. */
export interface OmrOptionBubble {
  kind: 'option';
  optionId: string;
  x: number;
  y: number;
}

/** One boolean bubble (true_false has no options array — see the layout generator). */
export interface OmrBooleanBubble {
  kind: 'boolean';
  value: boolean;
  x: number;
  y: number;
}

export type OmrBubbleSpec = OmrOptionBubble | OmrBooleanBubble;

/** OMR-coverable question types — the only ones a bubble sheet can capture. */
export type OmrQuestionType =
  | QuestionType.SINGLE_CHOICE
  | QuestionType.TRUE_FALSE
  | QuestionType.MULTIPLE_SELECT;

export interface OmrQuestionLayout {
  examQuestionId: string;
  orderIndex: number;
  type: OmrQuestionType;
  /** 1-based printed question number (matches on-sheet labelling). */
  label: number;
  bubbles: OmrBubbleSpec[];
}

export interface OmrMarkerSpec {
  x: number;
  y: number;
  sizeMm: number;
}

export interface OmrQrSpec {
  x: number;
  y: number;
  sizeMm: number;
}

/** The complete deterministic geometry for one generated template version. */
export interface OmrTemplateLayout {
  layoutVersion: 1;
  pageWidthMm: number;
  pageHeightMm: number;
  bubbleRadiusMm: number;
  markers: {
    topLeft: OmrMarkerSpec;
    topRight: OmrMarkerSpec;
    bottomLeft: OmrMarkerSpec;
    bottomRight: OmrMarkerSpec;
  };
  qr: OmrQrSpec;
  questions: OmrQuestionLayout[];
}

/** Per-question recognition outcome, before any teacher review. */
export type OmrMarkStatus = 'confident' | 'low_confidence' | 'multiple_marks' | 'blank';

/** A CV-derived answer: audit/debug trail, kept separate from the confirmed `detected_answers`. */
export interface OmrRecognizedAnswer {
  exam_question_id: string;
  status: OmrMarkStatus;
  /** 0..1 — how confident the classifier is in `detected`. */
  confidence: number;
  /** Best-guess value in the same shape `saveAnswers` expects, or null (blank/ambiguous). */
  detected: Record<string, unknown> | null;
  /** Raw per-bubble metadata for debugging/audit — never shown to teachers directly. */
  raw: {
    fillRatios: number[];
    threshold: number;
    margin: number | null;
  };
}

/** Whether a recognized answer requires teacher review before it can be confirmed. */
export function markNeedsReview(mark: OmrRecognizedAnswer): boolean {
  return mark.status === 'low_confidence' || mark.status === 'multiple_marks';
}
