// Neither package publishes TypeScript type declarations.
/* eslint-disable @typescript-eslint/no-require-imports */
const { ArabicShaper } = require('arabic-persian-reshaper') as {
  ArabicShaper: { convertArabic(text: string): string };
};
const bidiFactory = require('bidi-js') as () => {
  getEmbeddingLevels(text: string, direction?: 'ltr' | 'rtl'): unknown;
  getReorderSegments(text: string, embeddingLevels: unknown): [number, number][];
};
/* eslint-enable @typescript-eslint/no-require-imports */

const bidi = bidiFactory();

/**
 * PDFKit (via fontkit) draws whatever character codes it is given, left to
 * right, using each glyph's isolated form — it does not perform Arabic
 * contextual shaping (initial/medial/final/isolated letter joining) or
 * bidirectional reordering. Both must be done here, in JS, before the text
 * ever reaches `doc.text()`:
 *
 * 1. `ArabicShaper.convertArabic` maps each Arabic letter (in logical/reading
 *    order) to its correct joined presentation-form glyph based on its
 *    neighbours — this MUST happen before reordering, since joining depends
 *    on logical adjacency, not visual adjacency.
 * 2. `bidi-js` then computes which runs of the (already-shaped) string need
 *    to be visually reversed so a right-to-left reader sees them in the
 *    correct order — this mirrors what a browser's bidi algorithm does
 *    automatically for `dir="rtl"` HTML, which PDFKit has no equivalent of.
 *
 * Latin text, digits, and punctuation embedded in an Arabic string (course
 * codes, numbers) are left untouched by both steps and end up in the correct
 * position via the bidi algorithm's embedding-level rules.
 */
export function shapeArabicForPdf(text: string): string {
  const shaped = ArabicShaper.convertArabic(text);

  const embeddingLevels = bidi.getEmbeddingLevels(shaped, 'rtl');
  const flips = bidi.getReorderSegments(shaped, embeddingLevels);

  const chars = Array.from(shaped);
  for (const [start, end] of flips) {
    let i = start;
    let j = end;
    while (i < j) {
      const tmp = chars[i]!;
      chars[i] = chars[j]!;
      chars[j] = tmp;
      i += 1;
      j -= 1;
    }
  }

  return chars.join('');
}

const ARABIC_SCRIPT_PATTERN = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

/** True if the string contains any Arabic-script codepoint. */
export function containsArabic(text: string): boolean {
  return ARABIC_SCRIPT_PATTERN.test(text);
}
