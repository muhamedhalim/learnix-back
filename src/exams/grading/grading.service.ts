import { Injectable } from '@nestjs/common';

import { QuestionTypeRegistry } from '../question-types/question-type-registry';
import { AnswerGradeResult, GradeAnswerParams } from './grading.types';

/** Marks deducted for a wrong objective answer under negative marking = 25% of the question's marks. */
const NEGATIVE_MARK_FRACTION = 0.25;

/** Round to 2 decimal places (matches the numeric(_,2) score columns). */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The grading engine. Turns a question-type strategy's marks-fraction into an
 * absolute score, applying the exam's marks / negative-marking policy. It is
 * pure (no persistence) so it is trivially unit-testable; the AttemptService
 * calls it per answer during submission and persists + aggregates the results.
 *
 * Weighting and bonus handling live at the attempt-total level (they concern how
 * a question contributes to the exam total, not how one answer is scored).
 */
@Injectable()
export class GradingService {
  constructor(private readonly registry: QuestionTypeRegistry) {}

  /**
   * Grade a single answer. Objective types are scored immediately; manual types
   * (essay/file) return a pending result (`manualRequired`, score 0) to be
   * finalised by a teacher (optionally AI-assisted).
   */
  public gradeAnswer(params: GradeAnswerParams): AnswerGradeResult {
    const { type, answerKey, response, marks, negativeMarking } = params;
    const definition = this.registry.require(type);
    const grade = definition.grade(response, answerKey);

    // Manual grading required (essay, file upload, ...).
    if (grade.manualRequired || grade.fraction === null) {
      return {
        score: 0,
        maxScore: marks,
        isCorrect: null,
        autoGraded: false,
        manualRequired: true,
      };
    }

    const answered = response !== null;
    let score: number;

    if (grade.fraction === 0 && negativeMarking && answered) {
      // Penalise wrong (but attempted) objective answers; blanks are never penalised.
      score = -round2(marks * NEGATIVE_MARK_FRACTION);
    } else {
      score = round2(grade.fraction * marks);
    }

    return {
      score,
      maxScore: marks,
      isCorrect: grade.isCorrect,
      autoGraded: true,
      manualRequired: false,
    };
  }
}
