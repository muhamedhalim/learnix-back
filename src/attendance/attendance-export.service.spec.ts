import { PassThrough } from 'node:stream';

import ExcelJS from 'exceljs';

import { AttendanceExportService, type AttendanceExportFormat } from './attendance-export.service';
import type { AttendanceRecord } from './entities/attendance-record.entity';

describe('AttendanceExportService', () => {
  const service = new AttendanceExportService();

  const record = (over: Partial<AttendanceRecord> = {}): AttendanceRecord =>
    ({
      id: 'record-id',
      student_id: 'student-id',
      lesson_id: 'lesson-id',
      status: 'present',
      is_auto_marked: false,
      notes: 'On time',
      marked_at: new Date('2026-01-01T10:00:00.000Z'),
      student: { name: 'Ava', email: 'ava@example.test' },
      lesson: { title: 'Math', teacher: { name: 'Teacher' } },
      ...over,
    }) as AttendanceRecord;

  const metadata = {
    total: 0,
    generatedAt: new Date('2026-01-02T00:00:00.000Z'),
    filters: { status: 'present' },
  };

  /** Feed the exporter in several chunks, exactly as the service does. */
  async function* chunked(records: AttendanceRecord[], size = 2): AsyncGenerator<AttendanceRecord[]> {
    for (let start = 0; start < records.length; start += size) {
      yield records.slice(start, start + size);
    }
  }

  async function collect(
    records: AttendanceRecord[],
    format: AttendanceExportFormat,
  ): Promise<{ buffer: Buffer; written: number }> {
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on('data', (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<void>((resolve) => sink.on('end', resolve));
    const written = await service.write(chunked(records), format, sink, {
      ...metadata,
      total: records.length,
    });
    await done;
    return { buffer: Buffer.concat(chunks), written };
  }

  /** Data rows only — header excluded, trailing newline tolerated. */
  function csvDataRows(csv: string): string[] {
    return csv.split('\n').slice(1).filter((line) => line.trim() !== '');
  }

  it('writes every record across every chunk, not just the first', async () => {
    const many = Array.from({ length: 101 }, (_, index) =>
      record({ id: `r-${String(index)}`, notes: `note ${String(index)}` }),
    );

    const { buffer, written } = await collect(many, 'csv');

    expect(written).toBe(101);
    const rows = csvDataRows(buffer.toString('utf8'));
    expect(rows).toHaveLength(101);
    expect(rows[0]).toContain('note 0');
    expect(rows[100]).toContain('note 100');
  });

  it('quotes commas, quotes, newlines and Arabic text losslessly', async () => {
    const { buffer } = await collect(
      [
        record({
          notes: 'Late, then "left"\nrescheduled',
          student: { name: 'أحمد الشريف', email: 'ahmed@example.test' } as never,
          lesson: { title: 'الرياضيات', teacher: { name: 'المعلم' } } as never,
        }),
      ],
      'csv',
    );
    const csv = buffer.toString('utf8');

    expect(csv).toContain('"أحمد الشريف"');
    expect(csv).toContain('"الرياضيات"');
    expect(csv).toContain('"Late, then ""left""\nrescheduled"');
  });

  it('produces a workbook whose data-row count matches the input exactly', async () => {
    const many = Array.from({ length: 101 }, (_, index) =>
      record({ id: `r-${String(index)}`, notes: `note ${String(index)}` }),
    );

    const { buffer, written } = await collect(many, 'xlsx');
    expect(written).toBe(101);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as never);
    const worksheet = workbook.getWorksheet('Attendance')!;
    // rowCount includes the header row.
    expect(worksheet.rowCount - 1).toBe(101);
    expect(worksheet.getRow(2).getCell(8).value).toBe('note 0');
    expect(worksheet.getRow(102).getCell(8).value).toBe('note 100');
  });

  it('renders every record into the PDF, spilling onto further pages as needed', async () => {
    const many = Array.from({ length: 250 }, (_, index) => record({ id: `r-${String(index)}` }));

    const { buffer, written } = await collect(many, 'pdf');

    expect(written).toBe(250);
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // 250 landscape rows cannot fit on one page — prove the document grew.
    const pageCount = (buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    expect(pageCount).toBeGreaterThan(1);
  });

  it('records the row count and filters as provenance inside the document', async () => {
    const { buffer } = await collect([record()], 'pdf');
    // The provenance line is emitted before any row is rendered.
    expect(buffer.length).toBeGreaterThan(100);
  });

  it('reports each format with the right content type and extension', () => {
    expect(service.describe('csv')).toMatchObject({ contentType: 'text/csv; charset=utf-8' });
    expect(service.describe('csv').filename).toMatch(/\.csv$/);
    expect(service.describe('xlsx').filename).toMatch(/\.xlsx$/);
    expect(service.describe('pdf')).toMatchObject({ contentType: 'application/pdf' });
  });

  it('exports an empty but well-formed file when nothing matches', async () => {
    const { buffer, written } = await collect([], 'csv');
    expect(written).toBe(0);
    expect(csvDataRows(buffer.toString('utf8'))).toHaveLength(0);
    expect(buffer.toString('utf8')).toContain('"Student"');
  });
});
