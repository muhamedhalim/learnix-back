import { Injectable, Logger } from '@nestjs/common';
import * as PDFDocument from 'pdfkit';
import * as fs from 'fs';
import * as path from 'path';

export interface PdfExportOptions {
  filename: string;
  title: string;
  subtitle?: string;
  columns: { key: string; header: string; width?: number }[];
  summary?: Record<string, string | number>;
}

@Injectable()
export class PdfExporterService {
  private readonly logger = new Logger(PdfExporterService.name);
  private readonly storageDir: string;

  constructor() {
    this.storageDir = process.env.REPORTS_STORAGE_PATH || './storage/reports';
    this.ensureStorageDir();
  }

  private ensureStorageDir(): void {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  /**
   * Export data to PDF file with table format
   */
  async exportToPdf<T extends Record<string, unknown>>(
    data: T[],
    options: PdfExportOptions,
  ): Promise<{ filePath: string; rowCount: number; fileSize: number }> {
    const { filename, title, subtitle, columns, summary } = options;

    return new Promise((resolve, reject) => {
      try {
        // Generate unique filename
        const timestamp = Date.now();
        const safeFilename = filename.replace(/[^a-zA-Z0-9-_]/g, '_');
        const fullFilename = `${safeFilename}_${timestamp}.pdf`;
        const filePath = path.join(this.storageDir, fullFilename);

        // Create PDF document
        const doc = new PDFDocument({
          margin: 50,
          size: 'A4',
          bufferPages: true,
        });

        const writeStream = fs.createWriteStream(filePath);
        doc.pipe(writeStream);

        // Header
        this.addHeader(doc, title, subtitle);

        // Summary section if provided
        if (summary && Object.keys(summary).length > 0) {
          this.addSummary(doc, summary);
        }

        // Data table
        if (data.length > 0) {
          this.addTable(doc, data, columns);
        } else {
          doc.moveDown(2);
          doc
            .fontSize(12)
            .text('No data available for the selected criteria.', {
              align: 'center',
            });
        }

        // Footer with page numbers
        this.addFooter(doc);

        doc.end();

        writeStream.on('finish', () => {
          fs.promises
            .stat(filePath)
            .then((stats) => {
              this.logger.log(
                `PDF exported: ${fullFilename} (${data.length} rows, ${stats.size} bytes)`,
              );
              resolve({
                filePath,
                rowCount: data.length,
                fileSize: stats.size,
              });
            })
            .catch((error: unknown) => {
              reject(error instanceof Error ? error : new Error(String(error)));
            });
        });

        writeStream.on('error', (error) => {
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      } catch (error) {
        this.logger.error(`Failed to export PDF: ${(error as Error).message}`);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private addHeader(
    doc: PDFKit.PDFDocument,
    title: string,
    subtitle?: string,
  ): void {
    // Platform branding
    doc
      .fontSize(20)
      .font('Helvetica-Bold')
      .text('Educational Platform', { align: 'center' });

    doc.moveDown(0.5);

    // Report title
    doc.fontSize(16).font('Helvetica-Bold').text(title, { align: 'center' });

    if (subtitle) {
      doc.moveDown(0.3);
      doc.fontSize(10).font('Helvetica').text(subtitle, { align: 'center' });
    }

    // Generation timestamp
    doc.moveDown(0.3);
    doc
      .fontSize(8)
      .font('Helvetica')
      .fillColor('#666666')
      .text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });

    doc.fillColor('#000000');
    doc.moveDown(1);

    // Separator line
    doc
      .moveTo(50, doc.y)
      .lineTo(doc.page.width - 50, doc.y)
      .stroke();

    doc.moveDown(1);
  }

  private addSummary(
    doc: PDFKit.PDFDocument,
    summary: Record<string, string | number>,
  ): void {
    doc
      .fontSize(12)
      .font('Helvetica-Bold')
      .text('Summary', { underline: true });
    doc.moveDown(0.5);

    doc.fontSize(10).font('Helvetica');
    for (const [key, value] of Object.entries(summary)) {
      const formattedKey = this.formatFieldName(key);
      doc.text(`${formattedKey}: ${value}`);
    }

    doc.moveDown(1);
  }

  private addTable<T extends Record<string, unknown>>(
    doc: PDFKit.PDFDocument,
    data: T[],
    columns: { key: string; header: string; width?: number }[],
  ): void {
    const tableTop = doc.y;
    const tableLeft = 50;
    const pageWidth = doc.page.width - 100;
    const rowHeight = 20;
    const headerHeight = 25;

    // Calculate column widths
    const totalDefinedWidth = columns.reduce(
      (sum, col) => sum + (col.width || 0),
      0,
    );
    const columnsWithoutWidth = columns.filter((col) => !col.width).length;
    const remainingWidth = pageWidth - totalDefinedWidth;
    const autoWidth =
      columnsWithoutWidth > 0 ? remainingWidth / columnsWithoutWidth : 0;

    const columnWidths = columns.map((col) => col.width || autoWidth);

    // Table header
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#ffffff');

    doc.rect(tableLeft, tableTop, pageWidth, headerHeight).fill('#333333');

    let xPos = tableLeft + 5;
    columns.forEach((col, i) => {
      const colWidth = columnWidths[i] ?? 0;
      doc.text(col.header, xPos, tableTop + 7, {
        width: colWidth - 10,
        align: 'left',
      });
      xPos += colWidth;
    });

    doc.fillColor('#000000').font('Helvetica').fontSize(8);

    // Table rows
    let yPos = tableTop + headerHeight;
    const maxRowsPerPage = Math.floor(
      (doc.page.height - 150 - tableTop) / rowHeight,
    );

    data.forEach((row, rowIndex) => {
      // Check if we need a new page
      if (rowIndex > 0 && rowIndex % maxRowsPerPage === 0) {
        doc.addPage();
        yPos = 50;
      }

      // Alternate row colors
      if (rowIndex % 2 === 0) {
        doc.rect(tableLeft, yPos, pageWidth, rowHeight).fill('#f5f5f5');
      }

      doc.fillColor('#000000');
      xPos = tableLeft + 5;

      columns.forEach((col, i) => {
        const colWidth = columnWidths[i] ?? 0;
        const value = row[col.key];
        let displayValue = '-';
        if (value !== null && value !== undefined) {
          if (typeof value === 'object') {
            displayValue = JSON.stringify(value);
          } else if (typeof value === 'string') {
            displayValue = value;
          } else {
            // Explicitly handle primitives
            displayValue = String(value as string | number | boolean);
          }
        }
        doc.text(displayValue, xPos, yPos + 5, {
          width: colWidth - 10,
          align: 'left',
          lineBreak: false,
        });
        xPos += colWidth;
      });

      yPos += rowHeight;
    });

    // Table border
    doc.rect(tableLeft, tableTop, pageWidth, yPos - tableTop).stroke('#cccccc');
  }

  private addFooter(doc: PDFKit.PDFDocument): void {
    const pages = doc.bufferedPageRange();

    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(i);

      // Footer line
      doc
        .moveTo(50, doc.page.height - 50)
        .lineTo(doc.page.width - 50, doc.page.height - 50)
        .stroke('#cccccc');

      // Page number
      doc
        .fontSize(8)
        .fillColor('#666666')
        .text(`Page ${i + 1} of ${pages.count}`, 50, doc.page.height - 40, {
          align: 'center',
          width: doc.page.width - 100,
        });
    }
  }

  private formatFieldName(field: string): string {
    return field
      .replace(/_/g, ' ')
      .replace(/([A-Z])/g, ' $1')
      .split(' ')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ')
      .trim();
  }

  /**
   * Delete a report file
   */
  async deleteFile(filePath: string): Promise<void> {
    try {
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
        this.logger.log(`Deleted report file: ${filePath}`);
      }
    } catch (error) {
      this.logger.error(`Failed to delete file: ${(error as Error).message}`);
    }
  }

  /**
   * Get file as buffer for download
   */
  async getFileBuffer(filePath: string): Promise<Buffer> {
    return fs.promises.readFile(filePath);
  }
}
