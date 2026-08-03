import { Injectable } from '@nestjs/common';

import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

import type { AttendanceRecord } from './entities/attendance-record.entity';

export type AttendanceExportFormat = 'csv' | 'xlsx' | 'pdf';

@Injectable()
export class AttendanceExportService {
  public async create(
    records: AttendanceRecord[],
    format: AttendanceExportFormat,
  ): Promise<{ body: Buffer; contentType: string; filename: string }> {
    const date = new Date().toISOString().slice(0, 10);

    switch (format) {
      case 'xlsx':
        return {
          body: await this.toExcel(records),
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          filename: `attendance-${date}.xlsx`,
        };
      case 'pdf':
        return {
          body: await this.toPdf(records),
          contentType: 'application/pdf',
          filename: `attendance-${date}.pdf`,
        };
      case 'csv':
      default:
        return {
          body: Buffer.from(this.toCsv(records), 'utf8'),
          contentType: 'text/csv; charset=utf-8',
          filename: `attendance-${date}.csv`,
        };
    }
  }

  private rows(records: AttendanceRecord[]): string[][] {
    return records.map((record) => [
      record.student?.name ?? record.student_id,
      record.student?.email ?? '',
      record.lesson?.title ?? record.lesson_id,
      record.lesson?.teacher?.name ?? '',
      record.status,
      record.is_auto_marked ? 'automatic' : 'manual',
      record.marked_at.toISOString(),
      record.notes ?? '',
    ]);
  }

  private headers(): string[] {
    return ['Student', 'Email', 'Lesson', 'Teacher', 'Status', 'Source', 'Marked at', 'Notes'];
  }

  private toCsv(records: AttendanceRecord[]): string {
    const escape = (value: string): string => `"${value.replaceAll('"', '""')}"`;
    return [this.headers(), ...this.rows(records)]
      .map((row) => row.map(escape).join(','))
      .join('\n');
  }

  private async toExcel(records: AttendanceRecord[]): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Attendance');
    worksheet.addRow(this.headers());
    for (const row of this.rows(records)) worksheet.addRow(row);
    worksheet.getRow(1).font = { bold: true };
    worksheet.columns.forEach((column) => {
      column.width = 20;
    });
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  private async toPdf(records: AttendanceRecord[]): Promise<Buffer> {
    return await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const document = new PDFDocument({ margin: 36, size: 'A4', layout: 'landscape' });
      document.on('data', (chunk: Buffer) => chunks.push(chunk));
      document.on('end', () => resolve(Buffer.concat(chunks)));
      document.on('error', reject);
      document.fontSize(16).text('Attendance export');
      document.moveDown();
      document.fontSize(8).text(this.headers().join(' | '));
      document.moveDown(0.5);
      for (const row of this.rows(records)) {
        document.text(row.join(' | '), { width: 760 });
      }
      document.end();
    });
  }
}
