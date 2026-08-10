import { detectFiducialMarker } from './fiducial-detection.util';

const WINDOW: { x0: number; y0: number; x1: number; y1: number } = { x0: 0, y0: 0, x1: 99, y1: 99 };
const DARK_THRESHOLD = 128;
const EXPECTED_SIZE_PX = 20;

function makeGrayBuffer(width: number, height: number, background = 250): Uint8ClampedArray {
  return new Uint8ClampedArray(width * height).fill(background);
}

function drawSquare(
  gray: Uint8ClampedArray,
  width: number,
  centerX: number,
  centerY: number,
  size: number,
  value = 10,
): void {
  const half = Math.floor(size / 2);
  for (let y = centerY - half; y < centerY + half; y++) {
    for (let x = centerX - half; x < centerX + half; x++) {
      gray[y * width + x] = value;
    }
  }
}

describe('detectFiducialMarker', () => {
  it('finds a clean solid square marker and returns its centroid', () => {
    const gray = makeGrayBuffer(100, 100);
    drawSquare(gray, 100, 50, 50, EXPECTED_SIZE_PX);

    const marker = detectFiducialMarker(gray, 100, 100, WINDOW, DARK_THRESHOLD, EXPECTED_SIZE_PX);
    expect(marker).not.toBeNull();
    expect(marker!.center.x).toBeCloseTo(49.5, 0);
    expect(marker!.center.y).toBeCloseTo(49.5, 0);
    expect(marker!.confidence).toBeGreaterThan(0.8);
  });

  it('returns null when the window has no dark pixels at all', () => {
    const gray = makeGrayBuffer(100, 100);
    expect(
      detectFiducialMarker(gray, 100, 100, WINDOW, DARK_THRESHOLD, EXPECTED_SIZE_PX),
    ).toBeNull();
  });

  it('rejects a cluster too small to be a real marker (noise floor)', () => {
    const gray = makeGrayBuffer(100, 100);
    drawSquare(gray, 100, 50, 50, 3); // well under MARKER_MIN_DARK_PIXELS
    expect(
      detectFiducialMarker(gray, 100, 100, WINDOW, DARK_THRESHOLD, EXPECTED_SIZE_PX),
    ).toBeNull();
  });

  it('rejects an elongated shape (aspect ratio too extreme for a square marker)', () => {
    const gray = makeGrayBuffer(100, 100);
    // A thin dark line/streak: 60 wide, 2 tall.
    for (let x = 10; x < 70; x++) {
      gray[50 * 100 + x] = 10;
      gray[51 * 100 + x] = 10;
    }
    expect(
      detectFiducialMarker(gray, 100, 100, WINDOW, DARK_THRESHOLD, EXPECTED_SIZE_PX),
    ).toBeNull();
  });

  it('rejects a sparse/scattered pattern spanning a large bbox at low fill density', () => {
    const gray = makeGrayBuffer(100, 100);
    // Diagonal scatter of isolated dark pixels — large bbox, tiny fill density.
    for (let i = 0; i < 25; i++) {
      gray[i * 100 + i] = 10;
    }
    expect(
      detectFiducialMarker(gray, 100, 100, WINDOW, DARK_THRESHOLD, EXPECTED_SIZE_PX),
    ).toBeNull();
  });

  it('rejects a marker far outside the expected size range (too large)', () => {
    const gray = makeGrayBuffer(100, 100);
    drawSquare(gray, 100, 50, 50, 90); // way beyond MARKER_SIZE_TOLERANCE_HIGH * expectedSizePx
    expect(
      detectFiducialMarker(gray, 100, 100, WINDOW, DARK_THRESHOLD, EXPECTED_SIZE_PX),
    ).toBeNull();
  });

  it('rejects a marker far outside the expected size range (too small)', () => {
    const gray = makeGrayBuffer(100, 100);
    drawSquare(gray, 100, 50, 50, 4); // below MARKER_SIZE_TOLERANCE_LOW * expectedSizePx, and near the pixel-count floor
    expect(
      detectFiducialMarker(gray, 100, 100, WINDOW, DARK_THRESHOLD, EXPECTED_SIZE_PX),
    ).toBeNull();
  });

  it('clips the search window to the image bounds instead of throwing', () => {
    const gray = makeGrayBuffer(20, 20);
    drawSquare(gray, 20, 10, 10, EXPECTED_SIZE_PX > 20 ? 18 : EXPECTED_SIZE_PX);
    const outOfBoundsWindow = { x0: -50, y0: -50, x1: 200, y1: 200 };
    expect(() =>
      detectFiducialMarker(gray, 20, 20, outOfBoundsWindow, DARK_THRESHOLD, EXPECTED_SIZE_PX),
    ).not.toThrow();
  });
});
