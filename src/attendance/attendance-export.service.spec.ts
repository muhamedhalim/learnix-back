import { AttendanceExportService } from './attendance-export.service';
import type { AttendanceRecord } from './entities/attendance-record.entity';

describe('AttendanceExportService', () => {
  const service = new AttendanceExportService();
  const records = [
    {
      student_id: 'student-id',
      lesson_id: 'lesson-id',
      status: 'present',
      is_auto_marked: false,
      notes: 'On time',
      marked_at: new Date('2026-01-01T10:00:00.000Z'),
      student: { name: 'Ava', email: 'ava@example.test' },
      lesson: { title: 'Math', teacher: { name: 'Teacher' } },
    } as AttendanceRecord,
  ];

  it('creates a quoted CSV containing the filtered attendance data', async () => {
    const result = await service.create(records, 'csv');

    expect(result.contentType).toBe('text/csv; charset=utf-8');
    expect(result.filename).toMatch(/^attendance-.*\.csv$/);
    expect(result.body.toString()).toContain('"Ava"');
    expect(result.body.toString()).toContain('"Math"');
  });

  it.each(['xlsx', 'pdf'] as const)('creates a non-empty %s export', async (format) => {
    const result = await service.create(records, format);

    expect(result.body.length).toBeGreaterThan(10);
    expect(result.filename).toMatch(new RegExp(`\\.${format}$`));
  });
});
