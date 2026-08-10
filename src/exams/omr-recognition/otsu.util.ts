/**
 * Otsu's method over a small set of continuous samples (not a fixed-bin
 * histogram — with only tens to a couple hundred bubble fill-ratios per
 * sheet, sorting and scanning adjacent-gap split points directly is simpler
 * and exact, no binning-resolution tradeoff to tune).
 *
 * Used twice in the recognition pipeline, on two different input sets: once
 * globally (a luminance sample of the whole photo, to threshold "ink" vs
 * "paper" for fiducial-marker search) and once per-sheet (every bubble's
 * fill ratio, to get one lighting-adaptive threshold for classification —
 * this replaces a hardcoded absolute threshold, which is fragile under the
 * uneven lighting a hand-held phone photo introduces).
 */
export function otsuThreshold(values: readonly number[]): number {
  if (values.length === 0) return 0.5;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 1) return sorted[0]!;

  const total = sorted.reduce((s, v) => s + v, 0);
  let sumBelow = 0;
  let bestSplit = -1;
  let bestVariance = -1;

  for (let i = 0; i < n - 1; i++) {
    sumBelow += sorted[i]!;
    const countBelow = i + 1;
    const countAbove = n - countBelow;
    // Skip ties: a threshold between two equal values isn't a real split.
    if (sorted[i]! === sorted[i + 1]!) continue;

    const sumAbove = total - sumBelow;
    const meanBelow = sumBelow / countBelow;
    const meanAbove = sumAbove / countAbove;
    const between = countBelow * countAbove * (meanBelow - meanAbove) ** 2;

    if (between > bestVariance) {
      bestVariance = between;
      bestSplit = i;
    }
  }

  if (bestSplit === -1) return (sorted[0]! + sorted[n - 1]!) / 2;
  return (sorted[bestSplit]! + sorted[bestSplit + 1]!) / 2;
}
