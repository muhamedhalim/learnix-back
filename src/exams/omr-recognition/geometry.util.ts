/**
 * Homography (projective transform) estimation from 4 point correspondences,
 * via the classic Direct Linear Transform (DLT). No external CV dependency —
 * this is ~120 lines of well-understood linear algebra.
 *
 * Two numerical-stability measures are load-bearing here, not optional
 * polish: mixing raw photo-pixel coordinates (thousands) with template
 * millimetre coordinates (tens/hundreds) in one un-normalized 8×8 solve is
 * poorly conditioned, so both point sets are Hartley-normalized (translated
 * to centroid, scaled to unit RMS distance) before solving; the linear solve
 * itself uses partial pivoting.
 */

export interface Point2D {
  x: number;
  y: number;
}

/** 3×3 matrix, row-major, 9 elements. */
export type Mat3 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export interface Homography {
  m: Mat3;
}

function mat3Multiply(a: Mat3, b: Mat3): Mat3 {
  const r = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += a[i * 3 + k]! * b[k * 3 + j]!;
      r[i * 3 + j] = sum;
    }
  }
  return r as unknown as Mat3;
}

/** Solve A·x = b via Gaussian elimination with partial pivoting. Null if (near-)singular. */
function solveLinearSystem(matrixA: number[][], vectorB: number[]): number[] | null {
  const n = matrixA.length;
  const augmented = matrixA.map((row, i) => [...row, vectorB[i]!]);

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let maxAbs = Math.abs(augmented[col]![col]!);
    for (let row = col + 1; row < n; row++) {
      const value = Math.abs(augmented[row]![col]!);
      if (value > maxAbs) {
        maxAbs = value;
        pivotRow = row;
      }
    }
    if (maxAbs < 1e-10) return null; // singular / degenerate correspondences

    if (pivotRow !== col) {
      const tmp = augmented[col]!;
      augmented[col] = augmented[pivotRow]!;
      augmented[pivotRow] = tmp;
    }

    const pivotRowVals = augmented[col]!;
    for (let row = col + 1; row < n; row++) {
      const targetRow = augmented[row]!;
      const factor = targetRow[col]! / pivotRowVals[col]!;
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) targetRow[c] = targetRow[c]! - factor * pivotRowVals[c]!;
    }
  }

  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    const rowVals = augmented[row]!;
    let sum = rowVals[n]!;
    for (let c = row + 1; c < n; c++) sum -= rowVals[c]! * x[c]!;
    x[row] = sum / rowVals[row]!;
  }
  return x;
}

interface SimilarityTransform {
  scale: number;
  cx: number;
  cy: number;
}

function computeNormalization(points: readonly Point2D[]): SimilarityTransform {
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
  const meanDist = points.reduce((s, p) => s + Math.hypot(p.x - cx, p.y - cy), 0) / points.length;
  const scale = meanDist > 1e-9 ? Math.SQRT2 / meanDist : 1;
  return { scale, cx, cy };
}

function normalizePoint(t: SimilarityTransform, p: Point2D): Point2D {
  return { x: (p.x - t.cx) * t.scale, y: (p.y - t.cy) * t.scale };
}

/** 3×3 matrix mapping an ORIGINAL point to its normalized coordinates. */
function forwardMatrix(t: SimilarityTransform): Mat3 {
  return [t.scale, 0, -t.scale * t.cx, 0, t.scale, -t.scale * t.cy, 0, 0, 1];
}

/** 3×3 matrix mapping a NORMALIZED point back to original coordinates (analytic inverse of a similarity transform). */
function inverseMatrix(t: SimilarityTransform): Mat3 {
  const invScale = 1 / t.scale;
  return [invScale, 0, t.cx, 0, invScale, t.cy, 0, 0, 1];
}

/**
 * Estimate the homography H such that `dst_i ~ H · src_i` (homogeneous, up to
 * scale) for 4 point correspondences. Returns null if the points are
 * degenerate (collinear / duplicated — no valid perspective transform).
 */
export function computeHomography(
  src: readonly [Point2D, Point2D, Point2D, Point2D],
  dst: readonly [Point2D, Point2D, Point2D, Point2D],
): Homography | null {
  const tSrc = computeNormalization(src);
  const tDst = computeNormalization(dst);
  const srcN = src.map((p) => normalizePoint(tSrc, p));
  const dstN = dst.map((p) => normalizePoint(tDst, p));

  // Fix h33 = 1 (8 DOF); 2 equations per correspondence × 4 points = 8×8 system.
  const matrixA: number[][] = [];
  const vectorB: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = srcN[i]!;
    const { x: xp, y: yp } = dstN[i]!;
    matrixA.push([x, y, 1, 0, 0, 0, -x * xp, -y * xp]);
    vectorB.push(xp);
    matrixA.push([0, 0, 0, x, y, 1, -x * yp, -y * yp]);
    vectorB.push(yp);
  }

  const solved = solveLinearSystem(matrixA, vectorB);
  if (!solved) return null;
  const [h11, h12, h13, h21, h22, h23, h31, h32] = solved as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const hNorm: Mat3 = [h11, h12, h13, h21, h22, h23, h31, h32, 1];

  // Denormalize: H = Tdst⁻¹ · Hnorm · Tsrc.
  const denormalized = mat3Multiply(inverseMatrix(tDst), mat3Multiply(hNorm, forwardMatrix(tSrc)));
  const scale = denormalized[8];
  if (Math.abs(scale) < 1e-10) return null; // degenerate after denormalization

  const normalized = denormalized.map((v) => v / scale) as unknown as Mat3;
  return { m: normalized };
}

/** Apply a homography to a point (perspective divide included). */
export function applyHomography(h: Homography, p: Point2D): Point2D {
  const [h11, h12, h13, h21, h22, h23, h31, h32, h33] = h.m;
  const w = h31 * p.x + h32 * p.y + h33;
  if (Math.abs(w) < 1e-10) return { x: NaN, y: NaN };
  return {
    x: (h11 * p.x + h12 * p.y + h13) / w,
    y: (h21 * p.x + h22 * p.y + h23) / w,
  };
}

export function distance(a: Point2D, b: Point2D): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
