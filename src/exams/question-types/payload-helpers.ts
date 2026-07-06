import { LocalizedText } from '../entities';

/** Type guard for a non-null plain object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Type guard for a non-empty string. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Validate a LocalizedText value (English required). Returns error messages. */
export function validateLocalizedText(value: unknown, label: string): string[] {
  if (!isRecord(value) || !isNonEmptyString(value['en'])) {
    return [`${label}: English text is required`];
  }
  if (value['ar'] !== undefined && value['ar'] !== null && typeof value['ar'] !== 'string') {
    return [`${label}: Arabic text must be a string`];
  }
  return [];
}

/** Read a string array field, returning [] when absent/invalid. */
export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

/**
 * Normalize a free-text answer for comparison: trims, collapses internal
 * whitespace, and (unless case-sensitive) lowercases.
 */
export function normalizeText(value: string, caseSensitive: boolean): string {
  const collapsed = value.trim().replace(/\s+/g, ' ');
  return caseSensitive ? collapsed : collapsed.toLowerCase();
}

/** Shape of a choice option shared by choice-based question types. */
export interface ChoiceOption {
  id: string;
  text: LocalizedText;
}

/** Validate a choice `options` array (2+ options, unique non-empty ids, valid text). */
export function validateOptions(options: unknown): string[] {
  if (!Array.isArray(options) || options.length < 2) {
    return ['content.options: at least 2 options are required'];
  }
  const errors: string[] = [];
  const ids = new Set<string>();
  options.forEach((opt, i) => {
    if (!isRecord(opt) || !isNonEmptyString(opt['id'])) {
      errors.push(`content.options[${String(i)}]: a non-empty "id" is required`);
      return;
    }
    if (ids.has(opt['id'])) {
      errors.push(`content.options[${String(i)}]: duplicate id "${opt['id']}"`);
    }
    ids.add(opt['id']);
    errors.push(...validateLocalizedText(opt['text'], `content.options[${String(i)}].text`));
  });
  return errors;
}

/** Extract the set of valid option ids from a content payload. */
export function optionIds(content: Record<string, unknown>): Set<string> {
  const options = Array.isArray(content['options']) ? content['options'] : [];
  const ids = new Set<string>();
  for (const opt of options) {
    if (isRecord(opt) && isNonEmptyString(opt['id'])) {
      ids.add(opt['id']);
    }
  }
  return ids;
}
