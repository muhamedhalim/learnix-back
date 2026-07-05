import * as QRCode from 'qrcode';

/**
 * Shared QR-code generation. Kept isolated so every exporter (PDF, QR sheet) and
 * any future single-code QR endpoint render identical, consistent QR images.
 */

/** Build the payload encoded in a code's QR (a redeem URL when a base is set). */
export function buildQrPayload(code: string, redeemBaseUrl?: string): string {
  if (redeemBaseUrl && redeemBaseUrl.length > 0) {
    const sep = redeemBaseUrl.includes('?') ? '&' : '?';
    return `${redeemBaseUrl}${sep}code=${encodeURIComponent(code)}`;
  }
  return code;
}

/** PNG buffer for embedding in PDFs. */
export async function generateQrPngBuffer(code: string, redeemBaseUrl?: string): Promise<Buffer> {
  return QRCode.toBuffer(buildQrPayload(code, redeemBaseUrl), {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 256,
    type: 'png',
  });
}

/** Data-URL (used by JSON export / API responses). */
export async function generateQrDataUrl(code: string, redeemBaseUrl?: string): Promise<string> {
  return QRCode.toDataURL(buildQrPayload(code, redeemBaseUrl), {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 256,
  });
}
