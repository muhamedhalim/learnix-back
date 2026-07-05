/**
 * Supported export/download formats for attendance codes.
 * PDF additionally honours a {@link PdfLayout}.
 */
export enum CodeExportFormat {
  CSV = 'csv',
  EXCEL = 'excel',
  PDF = 'pdf',
  JSON = 'json',
  /** A ZIP-free printable PDF sheet of QR codes (PDF under the hood). */
  QR = 'qr',
}
