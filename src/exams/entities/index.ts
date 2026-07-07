// Enums
export { QuestionType } from './question-type.enum';
export { Difficulty } from './difficulty.enum';
export { BloomLevel } from './bloom-level.enum';
export { ExamStatus } from './exam-status.enum';
export { AttemptState } from './attempt-state.enum';
export { ReviewPolicy } from './review-policy.enum';

// Shared payload contracts + config
export type {
  LocalizedText,
  QuestionContent,
  QuestionAnswerKey,
  QuestionResponsePayload,
} from './content.types';
export type { ExamConfig } from './exam-config.interface';
export { DEFAULT_EXAM_CONFIG } from './exam-config.interface';

// Entities
export { Question } from './question.entity';
export { QuestionVersion } from './question-version.entity';
export { Exam } from './exam.entity';
export { ExamSection } from './exam-section.entity';
export { ExamQuestion } from './exam-question.entity';
export { ExamAttempt } from './exam-attempt.entity';
export { ExamAttemptAnswer } from './exam-attempt-answer.entity';
export { OmrSheet } from './omr-sheet.entity';
export type { OmrDetectedAnswer } from './omr-sheet.entity';
export { OmrSheetStatus } from './omr-sheet-status.enum';
