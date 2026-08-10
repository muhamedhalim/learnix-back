import {
  MARKER_MAX_ASPECT_RATIO,
  MARKER_MIN_DARK_PIXELS,
  MARKER_MIN_FILL_DENSITY,
  MARKER_SIZE_TOLERANCE_HIGH,
  MARKER_SIZE_TOLERANCE_LOW,
} from './constants';
import { clamp01, type Point2D } from './geometry.util';

export interface DetectedMarker {
  center: Point2D;
  bboxWidth: number;
  bboxHeight: number;
  confidence: number;
}

export interface SearchWindow {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Find a solid dark square fiducial marker within a search window via a
 * dark-pixel centroid — deliberately simple (no connected-component
 * labelling) because these are printed, high-contrast, isolated marks on
 * white paper with generous surrounding whitespace by template design.
 *
 * The centroid alone is not enough: a naive "average position of every dark
 * pixel in the window" always returns SOME point (dust, a staple hole, a
 * stray pen mark), so every candidate is validated against the marker's
 * expected geometry before being trusted — that's what turns "no real
 * marker here" into a clean rejection instead of a false-confident position.
 */
export function detectFiducialMarker(
  gray: Uint8ClampedArray,
  width: number,
  height: number,
  window: SearchWindow,
  darkThreshold: number,
  expectedSizePx: number,
): DetectedMarker | null {
  const x0 = Math.max(0, Math.floor(window.x0));
  const y0 = Math.max(0, Math.floor(window.y0));
  const x1 = Math.min(width - 1, Math.ceil(window.x1));
  const y1 = Math.min(height - 1, Math.ceil(window.y1));
  if (x1 <= x0 || y1 <= y0) return null;

  let count = 0;
  let sumX = 0;
  let sumY = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (let y = y0; y <= y1; y++) {
    const rowOffset = y * width;
    for (let x = x0; x <= x1; x++) {
      if (gray[rowOffset + x]! >= darkThreshold) continue;
      count++;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (count < MARKER_MIN_DARK_PIXELS) return null;

  const bboxWidth = maxX - minX + 1;
  const bboxHeight = maxY - minY + 1;
  const aspect = bboxWidth > bboxHeight ? bboxWidth / bboxHeight : bboxHeight / bboxWidth;
  if (aspect > MARKER_MAX_ASPECT_RATIO) return null;

  const bboxArea = bboxWidth * bboxHeight;
  const fillDensity = count / bboxArea;
  if (fillDensity < MARKER_MIN_FILL_DENSITY) return null;

  const avgSize = (bboxWidth + bboxHeight) / 2;
  if (
    avgSize < expectedSizePx * MARKER_SIZE_TOLERANCE_LOW ||
    avgSize > expectedSizePx * MARKER_SIZE_TOLERANCE_HIGH
  ) {
    return null;
  }

  return {
    center: { x: sumX / count, y: sumY / count },
    bboxWidth,
    bboxHeight,
    confidence: clamp01(fillDensity),
  };
}
