import { PreferredLanguage } from '../guardians/entities/preferred-language.enum';

/**
 * Resolves a localized content field that follows the project's parallel-column
 * convention (`title` / `title_ar`, `description` / `description_ar`, …).
 *
 * English is the canonical/base column; the `_ar` sibling is optional. The
 * fallback rule is intentional and uniform across the platform: **whenever the
 * Arabic value is null/empty, fall back to English** — a course, subject, or
 * certificate never renders blank because its Arabic copy hasn't been authored
 * yet. This mirrors the read-side contract the audit committed to and keeps the
 * whole backend language-agnostic: callers pass a locale, they never branch on
 * one.
 *
 * @param entity  Any object carrying `<base>` and (optionally) `<base>_ar`.
 * @param base    The base (English) field name, e.g. `'title'`.
 * @param locale  The requester's resolved locale; `null`/`undefined` → English.
 */
export function pickLocalized<T extends Record<string, unknown>>(
  entity: T,
  base: Extract<keyof T, string>,
  locale: PreferredLanguage | null | undefined,
): string {
  const english = normalize(entity[base]);

  if (locale !== PreferredLanguage.AR) {
    return english;
  }

  const arabic = normalize(entity[`${base}_ar` as keyof T]);
  return arabic !== '' ? arabic : english;
}

/**
 * Array variant for parallel-column list fields (e.g. `requirements` /
 * `requirements_ar`). Falls back element-wise to English when the Arabic
 * array is null or empty.
 */
export function pickLocalizedArray<T extends Record<string, unknown>>(
  entity: T,
  base: Extract<keyof T, string>,
  locale: PreferredLanguage | null | undefined,
): string[] {
  const english = normalizeArray(entity[base]);

  if (locale !== PreferredLanguage.AR) {
    return english;
  }

  const arabic = normalizeArray(entity[`${base}_ar` as keyof T]);
  return arabic.length > 0 ? arabic : english;
}

/** Resolves a user's stored preference to a concrete locale (null → English). */
export function resolveLocale(
  preferred: PreferredLanguage | null | undefined,
): PreferredLanguage {
  return preferred === PreferredLanguage.AR ? PreferredLanguage.AR : PreferredLanguage.EN;
}

function normalize(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

function normalizeArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(normalize).filter((v) => v !== '') : [];
}
