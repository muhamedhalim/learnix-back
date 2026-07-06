import {
  QuestionAnswerKey,
  QuestionContent,
  QuestionResponsePayload,
  QuestionType,
} from '../../entities';
import { QuestionGrade, QuestionTypeDefinition } from '../question-type-definition.interface';
import { isNonEmptyString, isRecord, validateLocalizedText } from '../payload-helpers';

/**
 * Free-text essay. Always requires a human decision; the grading pipeline may
 * attach an AI-suggested score (via the AI grading queue) that the teacher
 * accepts or overrides, but this definition never assigns a final score itself.
 *   content   { prompt, maxWords? }
 *   answerKey { modelAnswer?: LocalizedText }   (rubrics arrive in a later phase)
 *   response  { text }
 */
export const essayDefinition: QuestionTypeDefinition = {
  type: QuestionType.ESSAY,
  requiresManualGrading: true,
  supportsPartialCredit: true,

  validateAuthoring(content: QuestionContent, answerKey: QuestionAnswerKey): string[] {
    const errors = validateLocalizedText(content['prompt'], 'content.prompt');
    if (
      content['maxWords'] !== undefined &&
      (typeof content['maxWords'] !== 'number' || content['maxWords'] <= 0)
    ) {
      errors.push('content.maxWords must be a positive number');
    }
    if (answerKey['modelAnswer'] !== undefined && answerKey['modelAnswer'] !== null) {
      errors.push(...validateLocalizedText(answerKey['modelAnswer'], 'answer_key.modelAnswer'));
    }
    return errors;
  },

  validateResponse(response: QuestionResponsePayload): string[] {
    return isRecord(response) && isNonEmptyString(response['text'])
      ? []
      : ['response.text is required'];
  },

  grade(): QuestionGrade {
    // Essays are never auto-scored; they await manual (optionally AI-assisted) grading.
    return { fraction: null, isCorrect: null, manualRequired: true };
  },
};
