/**
 * Print layouts for PDF/QR exports.
 * - A4_GRID: dense A4 grid of code + QR cells.
 * - LABELS: adhesive-label sheet (small cells, many per page).
 * - CARDS: larger presentation cards (few per page).
 * - QR_SHEET: QR-first sheet optimised for scanning.
 */
export enum PdfLayout {
  A4_GRID = 'a4_grid',
  LABELS = 'labels',
  CARDS = 'cards',
  QR_SHEET = 'qr_sheet',
}
