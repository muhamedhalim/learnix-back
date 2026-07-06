import {
  QuestionAnswerKey,
  QuestionContent,
  QuestionResponsePayload,
  QuestionType,
} from '../../entities';
import { QuestionGrade, QuestionTypeDefinition } from '../question-type-definition.interface';
import { isRecord, validateLocalizedText } from '../payload-helpers';

/**
 * Numeric answer with optional absolute tolerance.
 *   content   { prompt }
 *   answerKey { value: number, tolerance?: number }
 *   response  { value: number }
 */
export const numericDefinition: QuestionTypeDefinition = {
  type: QuestionType.NUMERIC,
  requiresManualGrading: false,
  supportsPartialCredit: false,

  validateAuthoring(content: QuestionContent, answerKey: QuestionAnswerKey): string[] {
    const errors = validateLocalizedText(content['prompt'], 'content.prompt');
    if (typeof answerKey['value'] !== 'number' || !Number.isFinite(answerKey['value'])) {
      errors.push('answer_key.value must be a finite number');
    }
    if (
      answerKey['tolerance'] !== undefined &&
      (typeof answerKey['tolerance'] !== 'number' || answerKey['tolerance'] < 0)
    ) {
      errors.push('answer_key.tolerance must be a non-negative number');
    }
    return errors;
  },

  validateResponse(response: QuestionResponsePayload): string[] {
    return isRecord(response) && typeof response['value'] === 'number' && Number.isFinite(response['value'])
      ? []
      : ['response.value must be a finite number'];
  },

  grade(response: QuestionResponsePayload | null, answerKey: QuestionAnswerKey): QuestionGrade {
    const expected = typeof answerKey['value'] === 'number' ? answerKey['value'] : Number.NaN;
    const tolerance = typeof answerKey['tolerance'] === 'number' ? answerKey['tolerance'] : 0;
    const actual = isRecord(response) && typeof response['value'] === 'number'
      ? response['value']
      : Number.NaN;
    const isCorrect = Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
    return { fraction: isCorrect ? 1 : 0, isCorrect, manualRequired: false };
  },
};
