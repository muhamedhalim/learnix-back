import {
  QuestionAnswerKey,
  QuestionContent,
  QuestionResponsePayload,
  QuestionType,
} from '../../entities';
import { QuestionGrade, QuestionTypeDefinition } from '../question-type-definition.interface';
import {
  isNonEmptyString,
  isRecord,
  optionIds,
  validateLocalizedText,
  validateOptions,
} from '../payload-helpers';

/**
 * Single-choice (one correct option).
 *   content   { prompt: LocalizedText, options: [{ id, text }] }
 *   answerKey { correctOptionId }
 *   response  { optionId }
 */
export const singleChoiceDefinition: QuestionTypeDefinition = {
  type: QuestionType.SINGLE_CHOICE,
  requiresManualGrading: false,
  supportsPartialCredit: false,

  validateAuthoring(content: QuestionContent, answerKey: QuestionAnswerKey): string[] {
    const errors = [
      ...validateLocalizedText(content['prompt'], 'content.prompt'),
      ...validateOptions(content['options']),
    ];
    const ids = optionIds(content);
    if (!isNonEmptyString(answerKey['correctOptionId'])) {
      errors.push('answer_key.correctOptionId is required');
    } else if (!ids.has(answerKey['correctOptionId'])) {
      errors.push('answer_key.correctOptionId must reference an existing option id');
    }
    return errors;
  },

  validateResponse(response: QuestionResponsePayload): string[] {
    return isRecord(response) && isNonEmptyString(response['optionId'])
      ? []
      : ['response.optionId is required'];
  },

  grade(response: QuestionResponsePayload | null, answerKey: QuestionAnswerKey): QuestionGrade {
    const selected = isRecord(response) ? response['optionId'] : undefined;
    const isCorrect = selected === answerKey['correctOptionId'];
    return { fraction: isCorrect ? 1 : 0, isCorrect, manualRequired: false };
  },
};
