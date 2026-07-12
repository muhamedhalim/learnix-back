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
 * NOTE: this only normalizes the *query* side. `ILIKE` comparisons against
 * stored titles/names are not normalized, so a query still won't match
 * stored content that itself uses a different hamza/teh-marbuta spelling
 * than what's on record — closing that gap fully would need the same
 * folding applied to the compared column (e.g. via a generated column or
 * `unaccent`-style Postgres function), which is a larger follow-up.
 */
export function normalizeArabicQuery(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[ً-ْٰـ]/g, '') // diacritics (ً-ْ) + superscript alef (ٰ) + tatweel (ـ)
    .replace(/[آأإٱ]/g, 'ا') // آ أ إ ٱ -> ا
    .replace(/ى/g, 'ي') // ى -> ي
    .replace(/ة/g, 'ه') // ة -> ه
    .replace(/\s+/g, ' ')
    .trim();
}
