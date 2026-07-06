/**
 * Shared JSONB payload contracts for the exam engine.
 *
 * The *shape* of these payloads is question-type specific and validated by the
 * question-type registry (not by class-validator, which can't validate
 * polymorphic JSON). At the storage layer they are opaque records; the registry
 * casts them to concrete per-type interfaces.
 */

/** Bilingual text. English is required; Arabic is optional (rendered in RTL). */
export interface LocalizedText {
  en: string;
  ar?: string | null;
}

/** Presentation payload shown to the student (never contains the answer). */
export type QuestionContent = Record<string, unknown>;

/** Correct-answer + grading parameters. NEVER sent to students during an attempt. */
export type QuestionAnswerKey = Record<string, unknown>;

/** A student's response to a question. Type-specific shape. */
export type QuestionResponsePayload = Record<string, unknown>;
