import {
  QuestionAnswerKey,
  QuestionContent,
  QuestionResponsePayload,
  QuestionType,
} from '../../entities';
import { QuestionGrade, QuestionTypeDefinition } from '../question-type-definition.interface';
import { isRecord, validateLocalizedText } from '../payload-helpers';

/**
 * True / False.
 *   content   { prompt }
 *   answerKey { value: boolean }
 *   response  { value: boolean }
 */
export const trueFalseDefinition: QuestionTypeDefinition = {
  type: QuestionType.TRUE_FALSE,
  requiresManualGrading: false,
  supportsPartialCredit: false,

  validateAuthoring(content: QuestionContent, answerKey: QuestionAnswerKey): string[] {
    const errors = validateLocalizedText(content['prompt'], 'content.prompt');
    if (typeof answerKey['value'] !== 'boolean') {
      errors.push('answer_key.value must be a boolean');
    }
    return errors;
  },

  validateResponse(response: QuestionResponsePayload): string[] {
    return isRecord(response) && typeof response['value'] === 'boolean'
      ? []
      : ['response.value must be a boolean'];
  },

  grade(response: QuestionResponsePayload | null, answerKey: QuestionAnswerKey): QuestionGrade {
    const value = isRecord(response) ? response['value'] : undefined;
    const isCorrect = typeof value === 'boolean' && value === answerKey['value'];
    return { fraction: isCorrect ? 1 : 0, isCorrect, manualRequired: false };
  },
};
