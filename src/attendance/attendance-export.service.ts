import { Injectable, Logger } from '@nestjs/common';

import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

import type { Writable } from 'node:stream';

import type { AttendanceRecord } from './entities/attendance-record.entity';

export type AttendanceExportFormat = 'csv' | 'xlsx' | 'pdf';

/** Rows arrive from the database in bounded chunks, never as one giant array. */
export type AttendanceChunks = AsyncIterable<AttendanceRecord[]>;

export interface AttendanceExportMetadata {
  /** How many rows the filtered query matched — written into the document. */
  total: number;
  generatedAt: Date;
  filters: Record<string, string>;
}

export interface AttendanceExportDescriptor {
  contentType: string;
  filename: string;
}

/**
 * Streaming attendance exporter (DEF-008).
 *
 * Every format consumes the SAME chunked async iterable of filtered rows and
 * writes straight through to the destination stream, so the exported row count
 * is whatever the filtered query matched — never a page of it. Nothing here
 * paginates, caps, or samples: the only bound is the explicit, documented
 * per-format limit the caller enforces up front (see
 * `ATTENDANCE_EXPORT_LIMITS` in the controller), and exceeding it is a loud
 * error rather than a quiet truncation.
 */
@Injectable()
export class AttendanceExportService {
  private readonly logger = new Logger(AttendanceExportService.name);

  public describe(format: AttendanceExportFormat): AttendanceExportDescriptor {
    const date = new Date().toISOString().slice(0, 10);
    switch (format) {
      case 'xlsx':
        return {
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          filename: `attendance-${date}.xlsx`,
        };
      case 'pdf':
        return { contentType: 'application/pdf', filename: `attendance-${date}.pdf` };
      case 'csv':
      default:
        return { contentType: 'text/csv; charset=utf-8', filename: `attendance-${date}.csv` };
    }
  }

  /**
   * Write the complete filtered result set to `target`.
   *
   * Returns the number of data rows actually written, so the caller can assert
   * it against the pre-flight count instead of trusting the file's size.
   */
  public async write(
    chunks: AttendanceChunks,
    format: AttendanceExportFormat,
    target: Writable,
    metadata: AttendanceExportMetadata,
  ): Promise<number> {
    switch (format) {
      case 'xlsx':
        return this.writeExcel(chunks, target, metadata);
      case 'pdf':
        return this.writePdf(chunks, target, metadata);
      case 'csv':
      default:
        return this.writeCsv(chunks, target, metadata);
    }
  }

  /* ===================== shared shape ===================== */

  private row(record: AttendanceRecord): string[] {
    return [
      record.student?.name ?? record.student_id,
      record.student?.email ?? '',
      record.lesson?.title ?? record.lesson_id,
      record.lesson?.teacher?.name ?? '',
      record.status,
      record.is_auto_marked ? 'automatic' : 'manual',
      new Date(record.marked_at).toISOString(),
      record.notes ?? '',
    ];
  }

  private headers(): string[] {
    return ['Student', 'Email', 'Lesson', 'Teacher', 'Status', 'Source', 'Marked at', 'Notes'];
  }

  /** Human-readable provenance line: which filters produced this file, and how many rows. */
  private provenance(metadata: AttendanceExportMetadata): string {
    const filters = Object.entries(metadata.filters)
      .map(([key, value]) => `${key}=${value}`)
      .join(', ');
    return `Generated ${metadata.generatedAt.toISOString()} · ${String(metadata.total)} record(s)${
      filters ? ` · filters: ${filters}` : ' · filters: none'
    }`;
  }

  /* ===================== CSV ===================== */

  /**
   * RFC-4180 quoting: every field is quoted and embedded quotes doubled, so
   * commas, newlines and Arabic text survive verbatim. UTF-8 without a BOM,
   * unchanged from the pre-DEF-008 exporter.
   */
  private async writeCsv(
    chunks: AttendanceChunks,
    target: Writable,
    metadata: AttendanceExportMetadata,
  ): Promise<number> {
    const escape = (value: string): string => `"${value.replaceAll('"', '""')}"`;
    const line = (cells: string[]): string => cells.map(escape).join(',');

    let written = 0;
    await this.push(target, line(this.headers()));
    for await (const chunk of chunks) {
      let block = '';
      for (const record of chunk) {
        block += `\n${line(this.row(record))}`;
        written += 1;
      }
      if (block) await this.push(target, block);
    }
    this.logger.log(`Attendance CSV export wrote ${String(written)} row(s) — ${this.provenance(metadata)}`);
    await this.finish(target);
    return written;
  }

  /** Respect backpressure: a slow client must not let the buffer grow unbounded. */
  private async push(target: Writable, text: string): Promise<void> {
    if (!target.write(text)) {
      await new Promise<void>((resolve) => target.once('drain', resolve));
    }
  }

  private async finish(target: Writable): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      target.end(() => {
        resolve();
      });
      target.once('error', reject);
    });
  }

  /* ===================== XLSX ===================== */

  /**
   * `WorkbookWriter` commits each row to the output stream as it is added, so
   * the whole sheet is never held in memory at once — the reason the export
   * can carry the full result set rather than a page of it.
   */
  private async writeExcel(
    chunks: AttendanceChunks,
    target: Writable,
    metadata: AttendanceExportMetadata,
  ): Promise<number> {
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: target, useStyles: true });
    const worksheet = workbook.addWorksheet('Attendance');
    worksheet.columns = this.headers().map((header) => ({ header, width: 20 }));
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).commit();

    let written = 0;
    for await (const chunk of chunks) {
      for (const record of chunk) {
        worksheet.addRow(this.row(record)).commit();
        written += 1;
      }
    }
    worksheet.commit();
    await workbook.commit();
    this.logger.log(
      `Attendance XLSX export wrote ${String(written)} row(s) — ${this.provenance(metadata)}`,
    );
    return written;
  }

  /* ===================== PDF ===================== */

  /**
   * PDFKit paginates automatically as the cursor passes the bottom margin, so
   * rendering simply continues until the iterable is exhausted — pages are
   * added as needed and no row is dropped because the document "ran out".
   */
  private async writePdf(
    chunks: AttendanceChunks,
    target: Writable,
    metadata: AttendanceExportMetadata,
  ): Promise<number> {
    const document = new PDFDocument({ margin: 36, size: 'A4', layout: 'landscape' });
    const finished = new Promise<void>((resolve, reject) => {
      target.once('finish', resolve);
      target.once('error', reject);
      document.once('error', reject);
    });
    document.pipe(target);

    document.fontSize(16).text('Attendance export');
    document.moveDown(0.3);
    document.fontSize(8).text(this.provenance(metadata));
    document.moveDown(0.5);
    document.fontSize(8).text(this.headers().join(' | '));
    document.moveDown(0.5);

    let written = 0;
    for await (const chunk of chunks) {
      for (const record of chunk) {
        document.text(this.row(record).join(' | '), { width: 760 });
        written += 1;
      }
    }
    document.end();
    await finished;
    this.logger.log(
      `Attendance PDF export wrote ${String(written)} row(s) — ${this.provenance(metadata)}`,
    );
    return written;
  }
}
