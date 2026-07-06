import {
  QuestionAnswerKey,
  QuestionContent,
  QuestionResponsePayload,
} from '../entities';
import { QuestionType } from '../entities';

/**
 * Result of grading a single response against an answer key. Framework-agnostic
 * and marks-agnostic: strategies return a *fraction* of the question's marks
 * (0..1) plus flags; the GradingService turns that into an absolute score using
 * the exam question's marks / weight / bonus / negative-marking policy.
 */
export interface QuestionGrade {
  /** Fraction of the question's marks earned, in [0, 1]. Null ⇒ manual grading. */
  fraction: number | null;
  /** Objective correctness (for analytics). Null for manual or partial-only types. */
  isCorrect: boolean | null;
  /** True when a human decision is required before this answer has a final score. */
  manualRequired: boolean;
}

/**
 * The contract every question type implements. Registering one of these in the
 * {@link QuestionTypeRegistry} is the ONLY change required to add a new type —
 * services, controllers, and the schema are untouched (Open/Closed Principle).
 *
 * Payloads are the opaque JSONB records from the entities; each definition
 * narrows them to its own concrete shape and validates them at runtime (this is
 * where polymorphic JSON that class-validator can't express is validated).
 */
export interface QuestionTypeDefinition {
  /** The type this definition grades/validates. */
  readonly type: QuestionType;

  /** Whether answers of this type always require a human grade (e.g. essay). */
  readonly requiresManualGrading: boolean;

  /** Whether grading can award a partial fraction (e.g. multiple-select). */
  readonly supportsPartialCredit: boolean;

  /**
   * Validate the authoring payloads (`content` + `answer_key`). Returns a list
   * of human-readable error messages; an empty array means valid.
   */
  validateAuthoring(
    content: QuestionContent,
    answerKey: QuestionAnswerKey,
  ): string[];

  /**
   * Validate a student's `response` payload shape. Returns error messages;
   * empty means valid. A missing/unanswered response is represented as `null`
   * by the caller and is not passed here.
   */
  validateResponse(response: QuestionResponsePayload): string[];

  /**
   * Grade a response (or `null` when unanswered) against the answer key. Must be
   * pure and deterministic for objective types.
   */
  grade(
    response: QuestionResponsePayload | null,
    answerKey: QuestionAnswerKey,
  ): QuestionGrade;
}
