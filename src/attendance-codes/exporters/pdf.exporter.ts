import { createWriteStream } from 'node:fs';
import { once } from 'node:events';

import PDFDocument from 'pdfkit';

import { PdfLayout } from '../entities/pdf-layout.enum';
import { ExportContext, EXPORT_CHUNK } from './export-context';
import { generateQrPngBuffer } from './qr.util';

/** Per-layout grid geometry (cells per page + cell rendering hints). */
interface LayoutConfig {
  cols: number;
  rows: number;
  qrSize: number;
  fontSize: number;
  border: boolean;
  title: string;
}

const LAYOUTS: Record<PdfLayout, LayoutConfig> = {
  [PdfLayout.A4_GRID]: {
    cols: 4,
    rows: 8,
    qrSize: 90,
    fontSize: 9,
    border: true,
    title: 'Attendance Codes',
  },
  [PdfLayout.LABELS]: {
    cols: 5,
    rows: 13,
    qrSize: 48,
    fontSize: 7,
    border: false,
    title: '',
  },
  [PdfLayout.CARDS]: {
    cols: 2,
    rows: 4,
    qrSize: 150,
    fontSize: 14,
    border: true,
    title: 'Attendance Cards',
  },
  [PdfLayout.QR_SHEET]: {
    cols: 3,
    rows: 4,
    qrSize: 150,
    fontSize: 12,
    border: true,
    title: 'QR Sheet',
  },
};

const PAGE_MARGIN = 28;
const HEADER_HEIGHT = 26;

/**
 * Stream matching codes into a printable PDF using the requested grid layout.
 * QR images are generated per page of cells, so memory stays bounded even for
 * large sheets. pdfkit flushes to the file stream as content is added.
 */
export async function exportPdf(
  filePath: string,
  layout: PdfLayout,
  ctx: ExportContext,
): Promise<number> {
  const cfg = LAYOUTS[layout];
  const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN });
  const stream = createWriteStream(filePath);
  doc.pipe(stream);

  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const usableWidth = pageWidth - PAGE_MARGIN * 2;
  const headerSpace = cfg.title ? HEADER_HEIGHT : 0;
  const usableHeight = pageHeight - PAGE_MARGIN * 2 - headerSpace;
  const cellWidth = usableWidth / cfg.cols;
  const cellHeight = usableHeight / cfg.rows;
  const perPage = cfg.cols * cfg.rows;

  const drawHeader = (): void => {
    if (!cfg.title) return;
    doc.fontSize(14).fillColor('#111111').text(cfg.title, PAGE_MARGIN, PAGE_MARGIN, {
      width: usableWidth,
      align: 'center',
    });
  };

  drawHeader();

  let written = 0;
  let indexOnPage = 0;

  try {
    for (let offset = 0; offset < ctx.total; offset += EXPORT_CHUNK) {
      const rows = await ctx.fetchChunk(offset, EXPORT_CHUNK);
      if (rows.length === 0) break;

      // Generate this page-chunk's QR images in parallel (bounded by chunk size).
      const qrBuffers = await Promise.all(
        rows.map((r) => generateQrPngBuffer(r.code, ctx.redeemBaseUrl)),
      );

      for (let i = 0; i < rows.length; i++) {
        if (indexOnPage === perPage) {
          doc.addPage();
          drawHeader();
          indexOnPage = 0;
        }

        const col = indexOnPage % cfg.cols;
        const rowIdx = Math.floor(indexOnPage / cfg.cols);
        const x = PAGE_MARGIN + col * cellWidth;
        const y = PAGE_MARGIN + headerSpace + rowIdx * cellHeight;

        if (cfg.border) {
          doc
            .lineWidth(0.5)
            .strokeColor('#dddddd')
            .rect(x + 2, y + 2, cellWidth - 4, cellHeight - 4)
            .stroke();
        }

        const qr = qrBuffers[i]!;
        const qrX = x + (cellWidth - cfg.qrSize) / 2;
        const qrY = y + 6;
        doc.image(qr, qrX, qrY, { width: cfg.qrSize, height: cfg.qrSize });

        doc
          .fontSize(cfg.fontSize)
          .fillColor('#000000')
          .text(rows[i]!.code, x + 2, qrY + cfg.qrSize + 3, {
            width: cellWidth - 4,
            align: 'center',
          });

        indexOnPage += 1;
        written += 1;
      }

      ctx.onProgress?.(Math.round((written / ctx.total) * 100));
    }

    doc.end();
    await once(stream, 'finish');
    return written;
  } catch (err) {
    doc.end();
    stream.destroy();
    throw err;
  }
}
