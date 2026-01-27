import type { QuestionType } from './question-type.enum';

/**
 * Question interface for JSONB storage in exams.questions
 *
 * MCQ questions require: choices, correct_answer
 * Essay questions do NOT have: choices, correct_answer
 */
export interface Question {
  type: QuestionType;
  question: string;
  question_ar: string;
  choices?: string[]; // Only for MCQ (2-6 options)
  correct_answer?: string; // Only for MCQ (must be in choices)
  marks: number;
}

/**
 * Answer interface for JSONB storage in exam_attempts.answers
 *
 * MCQ answers have: is_correct (auto-graded)
 * Essay answers have: feedback (from teacher)
 */
export interface Answer {
  question_index: number; // 0-based index into exam.questions
  answer: string; // Student's answer text
  score?: number | null; // Marks awarded (null for ungraded essays)
  is_correct?: boolean; // Only for MCQ (auto-calculated)
  feedback?: string | null; // Only for essays (from teacher)
}
