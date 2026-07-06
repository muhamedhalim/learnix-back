/**
 * Question types supported by the exam engine.
 *
 * Each value maps 1:1 to a {@link QuestionTypeDefinition} registered in the
 * question-type registry. Adding a new type means: add a value here + register
 * one definition module — no changes to services, controllers, or the schema.
 *
 * Phase 1 ships the objective set + essay. Future phases add matching, ordering,
 * media-stimulus, coding, formula, etc. purely by extending the registry.
 */
export enum QuestionType {
  SINGLE_CHOICE = 'single_choice',
  MULTIPLE_SELECT = 'multiple_select',
  TRUE_FALSE = 'true_false',
  FILL_BLANK = 'fill_blank',
  NUMERIC = 'numeric',
  ESSAY = 'essay',
}
