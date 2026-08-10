import {
  applyHomography,
  clamp01,
  computeHomography,
  distance,
  type Point2D,
} from './geometry.util';

describe('computeHomography / applyHomography', () => {
  it('recovers an identity mapping from identical point sets', () => {
    const pts: [Point2D, Point2D, Point2D, Point2D] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 0, y: 100 },
      { x: 100, y: 100 },
    ];
    const h = computeHomography(pts, pts);
    expect(h).not.toBeNull();
    for (const p of pts) {
      const mapped = applyHomography(h!, p);
      expect(mapped.x).toBeCloseTo(p.x, 6);
      expect(mapped.y).toBeCloseTo(p.y, 6);
    }
  });

  it('maps a pure scale+translate correctly, including interior points', () => {
    const src: [Point2D, Point2D, Point2D, Point2D] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
      { x: 10, y: 10 },
    ];
    // dst = 3*src + (50, 20) — a simple affine transform, well within homography's generality.
    const dst = src.map((p) => ({ x: p.x * 3 + 50, y: p.y * 3 + 20 })) as [
      Point2D,
      Point2D,
      Point2D,
      Point2D,
    ];
    const h = computeHomography(src, dst);
    expect(h).not.toBeNull();

    const interior = { x: 4, y: 7 };
    const mapped = applyHomography(h!, interior);
    expect(mapped.x).toBeCloseTo(4 * 3 + 50, 4);
    expect(mapped.y).toBeCloseTo(7 * 3 + 20, 4);
  });

  it('handles a genuine perspective (non-affine) distortion', () => {
    // A square mapped to a trapezoid — not reproducible by any affine transform.
    const src: [Point2D, Point2D, Point2D, Point2D] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 0, y: 100 },
      { x: 100, y: 100 },
    ];
    const dst: [Point2D, Point2D, Point2D, Point2D] = [
      { x: 20, y: 10 },
      { x: 180, y: 30 },
      { x: 0, y: 200 },
      { x: 200, y: 190 },
    ];
    const h = computeHomography(src, dst);
    expect(h).not.toBeNull();
    for (let i = 0; i < 4; i++) {
      const mapped = applyHomography(h!, src[i]!);
      expect(mapped.x).toBeCloseTo(dst[i]!.x, 3);
      expect(mapped.y).toBeCloseTo(dst[i]!.y, 3);
    }
  });

  it('is numerically stable across wildly different coordinate magnitudes (Hartley normalization)', () => {
    // Photo-pixel-scale src (thousands) vs template-mm-scale dst (tens/hundreds) — the exact
    // mismatch the recognizer produces, and the reason normalization exists at all.
    const src: [Point2D, Point2D, Point2D, Point2D] = [
      { x: 180, y: 210 },
      { x: 2430, y: 195 },
      { x: 165, y: 3120 },
      { x: 2415, y: 3105 },
    ];
    const dst: [Point2D, Point2D, Point2D, Point2D] = [
      { x: 14, y: 14 },
      { x: 196, y: 14 },
      { x: 14, y: 283 },
      { x: 196, y: 283 },
    ];
    const h = computeHomography(src, dst);
    expect(h).not.toBeNull();
    for (let i = 0; i < 4; i++) {
      const mapped = applyHomography(h!, src[i]!);
      expect(mapped.x).toBeCloseTo(dst[i]!.x, 2);
      expect(mapped.y).toBeCloseTo(dst[i]!.y, 2);
    }
  });

  it('returns null for degenerate (collinear) correspondences', () => {
    const collinear: [Point2D, Point2D, Point2D, Point2D] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
      { x: 30, y: 0 },
    ];
    const dst: [Point2D, Point2D, Point2D, Point2D] = [
      { x: 0, y: 0 },
      { x: 10, y: 5 },
      { x: 20, y: 10 },
      { x: 30, y: 15 },
    ];
    expect(computeHomography(collinear, dst)).toBeNull();
  });

  it('returns null for duplicated points', () => {
    const dup: [Point2D, Point2D, Point2D, Point2D] = [
      { x: 5, y: 5 },
      { x: 5, y: 5 },
      { x: 5, y: 5 },
      { x: 5, y: 5 },
    ];
    expect(computeHomography(dup, dup)).toBeNull();
  });
});

describe('distance', () => {
  it('computes Euclidean distance', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBeCloseTo(5, 6);
  });
});

describe('clamp01', () => {
  it('clamps to [0,1] and maps NaN to 0', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(NaN)).toBe(0);
  });
});
