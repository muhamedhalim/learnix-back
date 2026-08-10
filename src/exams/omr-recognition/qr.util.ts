import jsQR from 'jsqr';

import type { Point2D } from './geometry.util';

export interface QrDetection {
  /** Decoded text — expected to be a sheet identity token, see `encodeSheetQrPayload`. */
  data: string;
  topLeftCorner: Point2D;
  topRightCorner: Point2D;
  bottomLeftCorner: Point2D;
  bottomRightCorner: Point2D;
}

const QR_PAYLOAD_PREFIX = 'lnx-omr:';

/** Encode a sheet's identity into the exact string printed in its QR code. */
export function encodeSheetQrPayload(sheetId: string): string {
  return `${QR_PAYLOAD_PREFIX}${sheetId}`;
}

/** Decode a sheet id back out of a QR payload string, or null if it isn't ours. */
export function decodeSheetIdFromQrPayload(payload: string): string | null {
  return payload.startsWith(QR_PAYLOAD_PREFIX) ? payload.slice(QR_PAYLOAD_PREFIX.length) : null;
}

/** Locate + decode a QR code in an RGBA raster. jsQR requires exactly 4 channels. */
export function detectQr(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): QrDetection | null {
  const result = jsQR(rgba, width, height, { inversionAttempts: 'attemptBoth' });
  if (!result) return null;
  return {
    data: result.data,
    topLeftCorner: result.location.topLeftCorner,
    topRightCorner: result.location.topRightCorner,
    bottomLeftCorner: result.location.bottomLeftCorner,
    bottomRightCorner: result.location.bottomRightCorner,
  };
}

/**
 * How many degrees clockwise the PHOTO's content is rotated relative to
 * upright, inferred from the QR's own topLeft→topRight direction (which
 * should point in +x/rightward when upright — template space always places
 * the QR's top edge horizontal). Snapped to the nearest 90°: this pipeline
 * only corrects whole-page rotation, not fine skew (homography handles the
 * residual perspective/skew after this coarse correction).
 */
export function estimatePhotoRotationDegrees(qr: QrDetection): 0 | 90 | 180 | 270 {
  const dx = qr.topRightCorner.x - qr.topLeftCorner.x;
  const dy = qr.topRightCorner.y - qr.topLeftCorner.y;
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI; // image coords: +x right, +y down
  const normalized = ((angle % 360) + 360) % 360;
  const snapped = (Math.round(normalized / 90) * 90) % 360;
  return snapped as 0 | 90 | 180 | 270;
}

/** The clockwise rotation to APPLY to the image to undo `estimatePhotoRotationDegrees`'s finding. */
export function rotationCorrectionForPhotoRotation(
  photoRotationDegrees: 0 | 90 | 180 | 270,
): 0 | 90 | 180 | 270 {
  return ((360 - photoRotationDegrees) % 360) as 0 | 90 | 180 | 270;
}
