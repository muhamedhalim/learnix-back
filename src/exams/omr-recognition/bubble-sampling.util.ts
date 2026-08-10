import { INDEPENDENT_MARGIN_BAND, MIN_CONFIDENT_MARGIN } from './constants';
import { clamp01, type Point2D } from './geometry.util';
import type { OmrMarkStatus } from '../entities/omr-template.types';

/** Fraction of dark pixels within a circular sample region around `center`. */
export function sampleBubbleFillRatio(
  gray: Uint8ClampedArray,
  width: number,
  height: number,
  center: Point2D,
  radiusPx: number,
  darkThreshold: number,
): number {
  const x0 = Math.max(0, Math.floor(center.x - radiusPx));
  const x1 = Math.min(width - 1, Math.ceil(center.x + radiusPx));
  const y0 = Math.max(0, Math.floor(center.y - radiusPx));
  const y1 = Math.min(height - 1, Math.ceil(center.y + radiusPx));
  if (x1 < x0 || y1 < y0) return 0;

  const r2 = radiusPx * radiusPx;
  let dark = 0;
  let total = 0;
  for (let y = y0; y <= y1; y++) {
    const dy = y - center.y;
    const rowOffset = y * width;
    for (let x = x0; x <= x1; x++) {
      const dx = x - center.x;
      if (dx * dx + dy * dy > r2) continue;
      total++;
      if (gray[rowOffset + x]! < darkThreshold) dark++;
    }
  }
  return total === 0 ? 0 : dark / total;
}

export interface ExclusiveClassification {
  status: OmrMarkStatus;
  /** Index into the input `fillRatios` array, or null (blank / multiple_marks — no single winner). */
  selectedIndex: number | null;
  confidence: number;
  margin: number;
}

/**
 * Classify a mutually-exclusive bubble row (single_choice / true_false):
 * exactly one bubble is expected to be marked. Uses the highest-vs-second-
 * highest MARGIN rather than an absolute level — inherently robust to
 * uneven lighting because it compares bubbles physically close together on
 * the same sheet, on top of the per-sheet adaptive `threshold` already
 * normalizing for the photo's overall lighting.
 */
export function classifyExclusiveMark(
  fillRatios: readonly number[],
  threshold: number,
): ExclusiveClassification {
  const ranked = fillRatios
    .map((ratio, index) => ({ ratio, index }))
    .sort((a, b) => b.ratio - a.ratio);
  const top = ranked[0]!;
  const second = ranked[1];
  const margin = second ? top.ratio - second.ratio : top.ratio;

  if (top.ratio < threshold) {
    return {
      status: 'blank',
      selectedIndex: null,
      confidence: clamp01((threshold - top.ratio) / Math.max(threshold, 1e-6)),
      margin,
    };
  }

  if (second && second.ratio >= threshold) {
    const bothClearBy = Math.min(top.ratio, second.ratio) - threshold;
    return {
      status: 'multiple_marks',
      selectedIndex: null,
      confidence: clamp01(bothClearBy / Math.max(1 - threshold, 1e-6)),
      margin,
    };
  }

  const normalizedMargin = clamp01(margin / Math.max(top.ratio, 1e-6));
  return {
    status: margin >= MIN_CONFIDENT_MARGIN ? 'confident' : 'low_confidence',
    selectedIndex: top.index,
    confidence: normalizedMargin,
    margin,
  };
}

export interface IndependentClassification {
  status: OmrMarkStatus;
  selected: boolean[];
  confidence: number;
}

/**
 * Classify a multiple_select bubble row: each bubble is thresholded
 * independently (no mutual exclusion). Flagged for review if any bubble's
 * fill ratio sits in the indeterminate band around the threshold — a close
 * call on ANY option makes the whole question's answer set uncertain.
 */
export function classifyIndependentMarks(
  fillRatios: readonly number[],
  threshold: number,
): IndependentClassification {
  const selected = fillRatios.map((r) => r >= threshold);
  const distances = fillRatios.map((r) => Math.abs(r - threshold));
  const closest = Math.min(...distances);
  const ambiguous = closest < INDEPENDENT_MARGIN_BAND;

  return {
    status: ambiguous ? 'low_confidence' : selected.every((s) => !s) ? 'blank' : 'confident',
    selected,
    confidence: clamp01(closest / INDEPENDENT_MARGIN_BAND),
  };
}
