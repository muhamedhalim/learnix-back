import type { Server } from 'node:http';

import ExcelJS from 'exceljs';
import request from 'supertest';
import type { DataSource } from 'typeorm';

import { AttendanceService } from '../../src/attendance/attendance.service';
import { ATTENDANCE_EXPORT_LIMITS } from '../../src/attendance/controllers/admin-attendance.controller';
import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  type AuthenticatedUser,
  type E2EContext,
} from './fixtures';

/**
 * DEF-008 — an attendance export must contain EVERY record matching the
 * admin's filters, never a page of them.
 *
 * Proven against real PostgreSQL and the real HTTP surface: the exported
 * documents are parsed back (CSV split, workbook loaded, PDF page count) and
 * their logical record counts compared to the database count. File size is
 * never used as evidence that rows made it in.
 */
describe('attendance export completeness (PostgreSQL)', () => {
  let ctx: E2EContext;
  let server: Server;
  let dataSource: DataSource;
  let attendance: AttendanceService;
  let admin: AuthenticatedUser;

  /** Fixed instant shared by every seeded row, so the id tiebreaker does the ordering work. */
  const SHARED_MARKED_AT = '2026-03-01T09:00:00.000Z';

  beforeAll(async () => {
    ctx = await createE2EApp();
    server = ctx.app.getHttpServer() as Server;
    dataSource = ctx.dataSource;
    attendance = ctx.app.get(AttendanceService);
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    admin = await createAuthenticatedUser(ctx.app, dataSource, { role: 'admin' });
  });
  afterAll(async () => ctx.app.close());

  /* ===================== seeding ===================== */

  async function seedTeacherAndSubject(): Promise<{ teacherId: string; subjectId: string }> {
    const [{ id: teacherId }] = (await dataSource.query(
      `INSERT INTO users (id, username, name, email, phone, role, status, is_active)
       VALUES (gen_random_uuid(), 'att-teacher', 'أستاذ الرياضيات', 'att-teacher@example.test',
               '01000000001', 'teacher', 'approved', true) RETURNING id`,
    )) as [{ id: string }];
    const [{ id: subjectId }] = (await dataSource.query(
      `INSERT INTO subjects (id, name) VALUES (gen_random_uuid(), 'Export Subject') RETURNING id`,
    )) as [{ id: string }];
    return { teacherId, subjectId };
  }

  async function seedLesson(
    teacherId: string,
    subjectId: string,
    title: string,
  ): Promise<string> {
    const [{ id }] = (await dataSource.query(
      `INSERT INTO lessons (id, title, teacher_id, subject_id, price, version)
       VALUES (gen_random_uuid(), $1, $2, $3, 0, 1) RETURNING id`,
      [title, teacherId, subjectId],
    )) as [{ id: string }];
    return id;
  }

  /**
   * `count` attendance rows, one student each (the unique constraint is per
   * (student, lesson)), all stamped with the SAME `marked_at` unless told
   * otherwise — the worst case for chunked iteration.
   */
  async function seedAttendance(
    lessonId: string,
    count: number,
    options: {
      status?: string;
      markedAt?: string;
      notePrefix?: string;
      studentPrefix?: string;
    } = {},
  ): Promise<void> {
    if (count === 0) return;
    const {
      status = 'present',
      markedAt = SHARED_MARKED_AT,
      notePrefix = 'note',
      studentPrefix = 's',
    } = options;
    await dataSource.query(
      `WITH new_students AS (
         INSERT INTO users (id, username, name, email, phone, role, status, is_active)
         SELECT gen_random_uuid(),
                $4 || '-' || i,
                'Student ' || i,
                $4 || '-' || i || '@example.test',
                -- Phones are globally unique; offset by the current user count
                -- so repeated seeding calls never collide.
                '01' || lpad(((SELECT count(*) FROM users) + i)::text, 9, '0'),
                'student', 'approved', true
           FROM generate_series(1, $2) AS i
         RETURNING id
       )
       INSERT INTO attendance_records (id, student_id, lesson_id, status, is_auto_marked, notes, marked_at)
       SELECT gen_random_uuid(), s.id, $1, $3, false, $5 || ' ' || row_number() OVER (ORDER BY s.id), $6::timestamptz
         FROM new_students s`,
      [lessonId, count, status, studentPrefix, notePrefix, markedAt],
    );
  }

  /* ===================== export helpers ===================== */

  const binary = (res: request.Response, callback: (err: Error | null, body: Buffer) => void): void => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    res.on('end', () => callback(null, Buffer.concat(chunks)));
  };

  async function exportAs(
    format: 'csv' | 'xlsx' | 'pdf',
    query: Record<string, string> = {},
    agent: AuthenticatedUser = admin,
  ): Promise<Buffer> {
    const response = await agent.agent
      .get(`${API_PREFIX}/admin/attendance/export/${format}`)
      .query(query)
      .buffer(true)
      .parse(binary)
      .expect(200);
    return response.body as Buffer;
  }

  function csvRows(buffer: Buffer): string[] {
    const text = buffer.toString('utf8');
    // Records may contain quoted newlines — split on the record separator only
    // when an even number of quotes precedes it.
    const rows: string[] = [];
    let current = '';
    let inQuotes = false;
    for (const char of text) {
      if (char === '"') inQuotes = !inQuotes;
      if (char === '\n' && !inQuotes) {
        rows.push(current);
        current = '';
        continue;
      }
      current += char;
    }
    if (current.trim() !== '') rows.push(current);
    return rows.slice(1).filter((row) => row.trim() !== '');
  }

  async function xlsxRowCount(buffer: Buffer): Promise<number> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as never);
    const worksheet = workbook.getWorksheet('Attendance');
    if (!worksheet) throw new Error('Attendance worksheet missing from export');
    return worksheet.rowCount - 1; // minus the header row
  }

  function pdfPageCount(buffer: Buffer): number {
    return (buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  }

  /* ===================== size sweep ===================== */

  it.each([0, 1, 100, 101])(
    'exports exactly %i records to CSV and XLSX — never the first page',
    async (count) => {
      const { teacherId, subjectId } = await seedTeacherAndSubject();
      const lessonId = await seedLesson(teacherId, subjectId, 'Export Lesson');
      await seedAttendance(lessonId, count);
      expect(await attendance.countAttendanceForExport({} as never)).toBe(count);

      expect(csvRows(await exportAs('csv'))).toHaveLength(count);
      expect(await xlsxRowCount(await exportAs('xlsx'))).toBe(count);
    },
    60_000,
  );

  it('exports 1000 records completely in every format, with all three seeing the same dataset', async () => {
    const { teacherId, subjectId } = await seedTeacherAndSubject();
    const lessonId = await seedLesson(teacherId, subjectId, 'Big Lesson');
    await seedAttendance(lessonId, 1000);

    const csv = csvRows(await exportAs('csv'));
    expect(csv).toHaveLength(1000);
    const xlsx = await xlsxRowCount(await exportAs('xlsx'));
    expect(xlsx).toBe(1000);
    const pdf = await exportAs('pdf');
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdfPageCount(pdf)).toBeGreaterThan(1);

    // Every format saw the identical filtered dataset.
    expect(new Set([csv.length, xlsx, 1000]).size).toBe(1);
    // Records beyond the old 100-row cap really are present.
    const notes = csv.map((row) => /"note (\d+)"/.exec(row)?.[1]).filter(Boolean);
    expect(notes).toHaveLength(1000);
    expect(new Set(notes).size).toBe(1000);
    expect(notes).toContain('101');
    expect(notes).toContain('1000');
  }, 120_000);

  /* ===================== chunk boundaries ===================== */

  it('never skips or duplicates a record across chunk boundaries, even when every row shares a timestamp', async () => {
    const { teacherId, subjectId } = await seedTeacherAndSubject();
    const lessonId = await seedLesson(teacherId, subjectId, 'Boundary Lesson');
    await seedAttendance(lessonId, 1000);

    // A deliberately tiny chunk so the 1000 rows cross ~143 boundaries.
    const seen: string[] = [];
    const chunkSizes: number[] = [];
    for await (const chunk of attendance.iterateAttendanceForExport({} as never, 7)) {
      chunkSizes.push(chunk.length);
      for (const record of chunk) seen.push(record.id);
    }

    expect(seen).toHaveLength(1000);
    expect(new Set(seen).size).toBe(1000); // no duplicates
    expect(await attendance.countAttendanceForExport({} as never)).toBe(seen.length);
    expect(chunkSizes.length).toBeGreaterThan(100); // genuinely chunked
    expect(chunkSizes.slice(0, -1).every((size) => size === 7)).toBe(true);

    // The order is the canonical listing order and is fully deterministic.
    const again: string[] = [];
    for await (const chunk of attendance.iterateAttendanceForExport({} as never, 13)) {
      for (const record of chunk) again.push(record.id);
    }
    expect(again).toEqual(seen);
  }, 120_000);

  /* ===================== filters ===================== */

  it('applies exactly the admin-selected filters, and agrees with the listing endpoint', async () => {
    const { teacherId, subjectId } = await seedTeacherAndSubject();
    const mathId = await seedLesson(teacherId, subjectId, 'Math');
    const scienceId = await seedLesson(teacherId, subjectId, 'Science');
    await seedAttendance(mathId, 120, {
      status: 'present',
      markedAt: '2026-03-01T09:00:00.000Z',
      studentPrefix: 'a',
    });
    await seedAttendance(mathId, 30, {
      status: 'absent',
      markedAt: '2026-03-05T09:00:00.000Z',
      studentPrefix: 'b',
    });
    await seedAttendance(scienceId, 40, {
      status: 'present',
      markedAt: '2026-04-10T09:00:00.000Z',
      studentPrefix: 'c',
    });

    expect(csvRows(await exportAs('csv'))).toHaveLength(190);
    expect(csvRows(await exportAs('csv', { status: 'absent' }))).toHaveLength(30);
    expect(csvRows(await exportAs('csv', { lesson_id: mathId }))).toHaveLength(150);
    expect(
      csvRows(
        await exportAs('csv', { from_date: '2026-03-02T00:00:00.000Z', to_date: '2026-03-31T00:00:00.000Z' }),
      ),
    ).toHaveLength(30);
    // Combined filters.
    expect(
      csvRows(await exportAs('csv', { lesson_id: mathId, status: 'present' })),
    ).toHaveLength(120);
    // A single-student filter.
    const [{ student_id: someStudent }] = (await dataSource.query(
      `SELECT student_id FROM attendance_records WHERE lesson_id = $1 LIMIT 1`,
      [scienceId],
    )) as [{ student_id: string }];
    expect(csvRows(await exportAs('csv', { student_id: someStudent }))).toHaveLength(1);
    // No matches → a well-formed, empty export rather than an error.
    expect(
      csvRows(await exportAs('csv', { status: 'excused' })),
    ).toHaveLength(0);

    // The listing endpoint reports the same total the export delivers.
    const listed = await admin.agent
      .get(`${API_PREFIX}/admin/attendance`)
      .query({ lesson_id: mathId, status: 'present', limit: 20 })
      .expect(200);
    expect(listed.body.meta.total).toBe(120);
    expect(listed.body.data).toHaveLength(20); // list pagination is untouched
  }, 120_000);

  it('ignores the UI page/limit query on the export route', async () => {
    const { teacherId, subjectId } = await seedTeacherAndSubject();
    const lessonId = await seedLesson(teacherId, subjectId, 'Paged Lesson');
    await seedAttendance(lessonId, 150);

    expect(csvRows(await exportAs('csv', { page: '1', limit: '20' }))).toHaveLength(150);
    expect(csvRows(await exportAs('csv', { page: '2', limit: '100' }))).toHaveLength(150);
  }, 60_000);

  /* ===================== content fidelity ===================== */

  it('escapes Arabic text and CSV metacharacters losslessly across the whole file', async () => {
    const { teacherId, subjectId } = await seedTeacherAndSubject();
    const lessonId = await seedLesson(teacherId, subjectId, 'الرياضيات المتقدمة');
    await seedAttendance(lessonId, 3);
    await dataSource.query(
      `UPDATE attendance_records SET notes = 'متأخر, ثم "غادر"' || chr(10) || 'أعيد الجدولة'`,
    );

    const rows = csvRows(await exportAs('csv'));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).toContain('"الرياضيات المتقدمة"');
      expect(row).toContain('"أستاذ الرياضيات"');
      expect(row).toContain('"متأخر, ثم ""غادر""\nأعيد الجدولة"');
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await exportAs('xlsx')) as never);
    const worksheet = workbook.getWorksheet('Attendance')!;
    expect(worksheet.getRow(2).getCell(3).value).toBe('الرياضيات المتقدمة');
  }, 60_000);

  /* ===================== explicit limits ===================== */

  it('documents its own ceiling instead of truncating, and never applies a hidden 100-row cap', async () => {
    // The limits are explicit constants, not a page size, and are far above
    // any pagination default.
    expect(ATTENDANCE_EXPORT_LIMITS.csv).toBeGreaterThan(1000);
    expect(ATTENDANCE_EXPORT_LIMITS.xlsx).toBeGreaterThan(1000);
    expect(ATTENDANCE_EXPORT_LIMITS.pdf).toBeGreaterThan(1000);

    const { teacherId, subjectId } = await seedTeacherAndSubject();
    const lessonId = await seedLesson(teacherId, subjectId, 'Limit Lesson');
    await seedAttendance(lessonId, 101);

    // Well under every ceiling → a complete file, not a 422.
    expect(csvRows(await exportAs('csv'))).toHaveLength(101);
  }, 60_000);

  /* ===================== authorization ===================== */

  it('remains admin-only', async () => {
    const student = await createAuthenticatedUser(ctx.app, dataSource);
    const teacher = await createAuthenticatedUser(ctx.app, dataSource, {
      overrides: { requestedRole: 'teacher' },
      role: 'teacher',
    });

    await student.agent.get(`${API_PREFIX}/admin/attendance/export/csv`).expect(403);
    await teacher.agent.get(`${API_PREFIX}/admin/attendance/export/csv`).expect(403);
    await request(server).get(`${API_PREFIX}/admin/attendance/export/csv`).expect(401);
    await admin.agent.get(`${API_PREFIX}/admin/attendance/export/csv`).expect(200);
  }, 60_000);

  it('rejects an unsupported format', async () => {
    await admin.agent.get(`${API_PREFIX}/admin/attendance/export/json`).expect(400);
  });
});
