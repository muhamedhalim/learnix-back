import sharp from 'sharp';

/**
 * Sharp-backed raster decode. `rgba` feeds jsQR (which requires 4
 * channels — sharp's raw output is RGB unless `.ensureAlpha()` is chained
 * first); `gray` is derived from the SAME decode so nothing is decoded twice.
 *
 * Deliberately never calls the no-arg `sharp().rotate()` (EXIF auto-orient)
 * anywhere in this module — the recognition pipeline's rotation correction is
 * driven entirely by the identity QR's own content-based orientation
 * (`qr.util.ts`), which is more robust than EXIF (frequently wrong or
 * stripped) and must be the *only* source of rotation logic; mixing in
 * EXIF auto-orientation upstream would silently fight it and double-rotate.
 */
export interface RasterImage {
  rgba: Uint8ClampedArray;
  gray: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Decode image bytes to raw pixels, optionally downscaled (longest edge capped, aspect preserved). */
export async function decodeToRaster(buffer: Buffer, maxDimension?: number): Promise<RasterImage> {
  let pipeline = sharp(buffer);
  if (maxDimension !== undefined) {
    pipeline = pipeline.resize({
      width: maxDimension,
      height: maxDimension,
      fit: 'inside',
      withoutEnlargement: true,
    });
  }
  const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  const rgba = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
  const { width, height } = info;
  return { rgba, gray: toGrayscale(rgba, width, height), width, height };
}

/** Rotate the ORIGINAL bytes by a multiple of 90° clockwise, re-encoded as PNG (lossless — this
 *  buffer is about to be re-decoded, so avoid JPEG re-compression artifacts on the correction step). */
export async function rotateImageBuffer(buffer: Buffer, angleCwDegrees: number): Promise<Buffer> {
  const normalized = ((angleCwDegrees % 360) + 360) % 360;
  if (normalized === 0) return buffer;
  return sharp(buffer).rotate(normalized).png().toBuffer();
}

function toGrayscale(rgba: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const gray = new Uint8ClampedArray(width * height);
  const pixelCount = width * height;
  for (let i = 0; i < pixelCount; i++) {
    const o = i * 4;
    // Standard luma weights (Rec. 601) — good enough for a black-ink-on-white-paper threshold.
    gray[i] = Math.round(0.299 * rgba[o]! + 0.587 * rgba[o + 1]! + 0.114 * rgba[o + 2]!);
  }
  return gray;
}
