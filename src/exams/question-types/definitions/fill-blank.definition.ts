import {
  QuestionAnswerKey,
  QuestionContent,
  QuestionResponsePayload,
  QuestionType,
} from '../../entities';
import { QuestionGrade, QuestionTypeDefinition } from '../question-type-definition.interface';
import {
  asStringArray,
  isNonEmptyString,
  isRecord,
  normalizeText,
  validateLocalizedText,
} from '../payload-helpers';

/**
 * Fill in the blank(s), with per-blank accepted answers and normalization.
 *   content   { prompt (with {{id}} placeholders), blanks: [{ id }] }
 *   answerKey { blanks: [{ id, accepted: string[], caseSensitive? }] }
 *   response  { blanks: [{ id, value }] }
 *
 * Each blank contributes an equal share; a blank is correct when the normalized
 * response matches one of its accepted answers.
 */
interface AnswerBlank {
  id: string;
  accepted: string[];
  caseSensitive: boolean;
}

function readAnswerBlanks(answerKey: QuestionAnswerKey): AnswerBlank[] {
  const blanks = Array.isArray(answerKey['blanks']) ? answerKey['blanks'] : [];
  return blanks
    .filter(isRecord)
    .filter((b) => isNonEmptyString(b['id']))
    .map((b) => ({
      id: b['id'] as string,
      accepted: asStringArray(b['accepted']),
      caseSensitive: b['caseSensitive'] === true,
    }));
}

export const fillBlankDefinition: QuestionTypeDefinition = {
  type: QuestionType.FILL_BLANK,
  requiresManualGrading: false,
  supportsPartialCredit: true,

  validateAuthoring(content: QuestionContent, answerKey: QuestionAnswerKey): string[] {
    const errors = validateLocalizedText(content['prompt'], 'content.prompt');
    const blanks = readAnswerBlanks(answerKey);
    if (blanks.length === 0) {
      errors.push('answer_key.blanks must contain at least one blank');
    }
    blanks.forEach((b, i) => {
      if (b.accepted.length === 0) {
        errors.push(`answer_key.blanks[${String(i)}].accepted must list at least one answer`);
      }
    });
    return errors;
  },

  validateResponse(response: QuestionResponsePayload): string[] {
    return isRecord(response) && Array.isArray(response['blanks'])
      ? []
      : ['response.blanks must be an array'];
  },

  grade(response: QuestionResponsePayload | null, answerKey: QuestionAnswerKey): QuestionGrade {
    const blanks = readAnswerBlanks(answerKey);
    if (blanks.length === 0) {
      return { fraction: 0, isCorrect: false, manualRequired: false };
    }

    const responseBlanks = isRecord(response) && Array.isArray(response['blanks'])
      ? response['blanks']
      : [];
    const responseById = new Map<string, string>();
    for (const rb of responseBlanks) {
      if (isRecord(rb) && isNonEmptyString(rb['id']) && typeof rb['value'] === 'string') {
        responseById.set(rb['id'], rb['value']);
      }
    }

    let correctCount = 0;
    for (const blank of blanks) {
      const value = responseById.get(blank.id);
      if (value === undefined) continue;
      const normalizedValue = normalizeText(value, blank.caseSensitive);
      const matched = blank.accepted.some(
        (accepted) => normalizeText(accepted, blank.caseSensitive) === normalizedValue,
      );
      if (matched) correctCount++;
    }

    const fraction = correctCount / blanks.length;
    return { fraction, isCorrect: correctCount === blanks.length, manualRequired: false };
  },
};
