import { QuestionAnswerKey, QuestionResponsePayload, QuestionType } from '../entities';

/** Inputs required to grade one answer (sourced from the exam-question snapshot). */
export interface GradeAnswerParams {
  type: QuestionType;
  answerKey: QuestionAnswerKey;
  /** The student's response, or null when unanswered. */
  response: QuestionResponsePayload | null;
  /** Marks configured for this question in this exam. */
  marks: number;
  /** Whether the exam applies negative marking to wrong objective answers. */
  negativeMarking: boolean;
}

/** Outcome of grading one answer, ready to persist onto an attempt answer row. */
export interface AnswerGradeResult {
  /** Absolute marks awarded. May be negative when negative marking applies. */
  score: number;
  /** Maximum marks this question can contribute. */
  maxScore: number;
  /** Objective correctness for analytics; null for manual/partial-only types. */
  isCorrect: boolean | null;
  /** True when graded automatically (objective types). */
  autoGraded: boolean;
  /** True when a human grade is still required (essay / file upload). */
  manualRequired: boolean;
}
