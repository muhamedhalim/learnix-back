import { Injectable } from '@nestjs/common';

import { EntityManager } from 'typeorm';

import {
  AttemptState,
  ExamAttempt,
  ExamAttemptAnswer,
  ExamQuestion,
} from '../entities';
import { GradingService } from '../grading/grading.service';

/**
 * Orchestrates grading for an attempt: auto-grades objective answers on submit,
 * and recomputes the attempt totals + state transition after any grade change
 * (submit or a teacher's manual grade). The per-answer scoring itself is
 * delegated to the pure {@link GradingService}.
 */
@Injectable()
export class AttemptGradingService {
  constructor(private readonly grading: GradingService) {}

  /**
   * Auto-grade every objective answer of an attempt in place, flagging manual
   * (essay/file) answers as pending. Persists the answer rows.
   */
  public async applyObjectiveGrades(
    manager: EntityManager,
    answers: ExamAttemptAnswer[],
    examQuestionsById: Map<string, ExamQuestion>,
    negativeMarking: boolean,
  ): Promise<void> {
    for (const answer of answers) {
      const examQuestion = examQuestionsById.get(answer.exam_question_id);
      if (!examQuestion) continue;

      const result = this.grading.gradeAnswer({
        type: examQuestion.type_snapshot,
        answerKey: examQuestion.answer_key_snapshot,
        response: answer.response ?? null,
        marks: examQuestion.marks,
        negativeMarking,
      });

      if (result.manualRequired) {
        answer.manual_required = true;
        answer.auto_graded = false;
        answer.score = null;
        answer.is_correct = null;
      } else {
        answer.manual_required = false;
        answer.auto_graded = true;
        answer.score = result.score;
        answer.is_correct = result.isCorrect;
      }
    }
    await manager.save(ExamAttemptAnswer, answers);
  }

  /**
   * Recompute attempt score buckets + state from its answer rows and persist.
   * Transitions to GRADED only when no answer is still awaiting manual grading.
   */
  public async recomputeAndPersist(
    manager: EntityManager,
    attempt: ExamAttempt,
    answers: ExamAttemptAnswer[],
    passingMarks: number,
    options: { autoSubmitted?: boolean } = {},
  ): Promise<ExamAttempt> {
    let scoreAuto = 0;
    let scoreManual = 0;
    let total = 0;
    let anyPending = false;

    for (const answer of answers) {
      if (answer.manual_required) {
        anyPending = true;
        continue;
      }
      const score = answer.score ?? 0;
      total += score;
      if (answer.auto_graded) scoreAuto += score;
      else scoreManual += score;
    }

    attempt.score_auto = Math.round(scoreAuto * 100) / 100;
    attempt.score_manual = Math.round(scoreManual * 100) / 100;

    if (anyPending) {
      attempt.state = AttemptState.GRADING;
      attempt.score_total = null;
      attempt.passed = null;
      attempt.graded_at = null;
    } else {
      const clamped = Math.max(0, Math.round(total * 100) / 100);
      attempt.state = AttemptState.GRADED;
      attempt.score_total = clamped;
      attempt.passed = clamped >= passingMarks;
      attempt.graded_at = new Date();
    }

    if (options.autoSubmitted === true) attempt.auto_submitted = true;

    return manager.save(ExamAttempt, attempt);
  }
}
