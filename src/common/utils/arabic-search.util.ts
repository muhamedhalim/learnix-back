/**
 * Normalizes an Arabic (or mixed) search query so common spelling variants
 * that Arabic speakers routinely use interchangeably don't cause a search
 * to miss otherwise-matching content:
 *
 * - Strips diacritics (tashkeel) — fatha/damma/kasra/sukoon/shadda/tanwin —
 *   which are almost never typed but occasionally appear in pasted text.
 * - Strips tatweel/kashida, a stretching character with no semantic value
 *   that only affects rendering.
 * - Folds hamza-bearing alef forms to bare alef, since users very commonly
 *   type the bare form regardless of the "correct" hamza placement.
 * - Folds alef maksura to yeh and teh marbuta to heh, the two other
 *   spelling pairs Arabic speakers routinely conflate.
 *
 * This deliberately mirrors the PostgreSQL
 * `learnix_normalize_search_text(text)` function introduced by the search
 * foundation migration. Keep the two implementations semantically aligned:
 * public search compares this normalized query with an indexed, normalized
 * generated column rather than applying a function to a table column at query
 * time.
 */
export function normalizeArabicQuery(text: string): string {
  return text
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '') // diacritics + superscript alef + tatweel
    .replace(/[آأإٱ]/g, 'ا') // آ أ إ ٱ -> ا
    .replace(/ى/g, 'ي') // ى -> ي
    .replace(/ة/g, 'ه') // ة -> ه
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
