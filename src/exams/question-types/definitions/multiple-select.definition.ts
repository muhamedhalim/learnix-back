import {
  QuestionAnswerKey,
  QuestionContent,
  QuestionResponsePayload,
  QuestionType,
} from '../../entities';
import { QuestionGrade, QuestionTypeDefinition } from '../question-type-definition.interface';
import {
  asStringArray,
  isRecord,
  optionIds,
  validateLocalizedText,
  validateOptions,
} from '../payload-helpers';

/**
 * Multiple-select (one or more correct options) with partial credit.
 *   content   { prompt, options: [{ id, text }] }
 *   answerKey { correctOptionIds: string[] }
 *   response  { optionIds: string[] }
 *
 * Partial credit = (correctly selected − incorrectly selected) / total correct,
 * clamped to [0, 1]. Fully correct only when the selection equals the key.
 */
export const multipleSelectDefinition: QuestionTypeDefinition = {
  type: QuestionType.MULTIPLE_SELECT,
  requiresManualGrading: false,
  supportsPartialCredit: true,

  validateAuthoring(content: QuestionContent, answerKey: QuestionAnswerKey): string[] {
    const errors = [
      ...validateLocalizedText(content['prompt'], 'content.prompt'),
      ...validateOptions(content['options']),
    ];
    const ids = optionIds(content);
    const correct = asStringArray(answerKey['correctOptionIds']);
    if (correct.length === 0) {
      errors.push('answer_key.correctOptionIds must contain at least one option id');
    } else if (!correct.every((id) => ids.has(id))) {
      errors.push('answer_key.correctOptionIds must all reference existing option ids');
    }
    return errors;
  },

  validateResponse(response: QuestionResponsePayload): string[] {
    return isRecord(response) && Array.isArray(response['optionIds'])
      ? []
      : ['response.optionIds must be an array'];
  },

  grade(response: QuestionResponsePayload | null, answerKey: QuestionAnswerKey): QuestionGrade {
    const correct = new Set(asStringArray(answerKey['correctOptionIds']));
    const selected = new Set(isRecord(response) ? asStringArray(response['optionIds']) : []);

    let correctlySelected = 0;
    let incorrectlySelected = 0;
    for (const id of selected) {
      if (correct.has(id)) correctlySelected++;
      else incorrectlySelected++;
    }

    const raw = correct.size === 0 ? 0 : (correctlySelected - incorrectlySelected) / correct.size;
    const fraction = Math.max(0, Math.min(1, raw));
    const isCorrect = correctlySelected === correct.size && incorrectlySelected === 0;
    return { fraction, isCorrect, manualRequired: false };
  },
};
