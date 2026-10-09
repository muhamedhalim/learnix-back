import { randomUUID } from 'node:crypto';

import type { DataSource } from 'typeorm';

import { AdminDashboardService } from '../../src/analytics/admin-dashboard.service';
import { Lesson } from '../../src/lessons/entities/lesson.entity';
import { Subject } from '../../src/subjects/entities/subject.entity';
import { SubjectStatus } from '../../src/subjects/entities/subject-status.enum';
import { User, UserRole } from '../../src/users/entities';
import { UserStatus } from '../../src/users/entities/user-status.enum';
import { createE2EApp, resetDatabase, type E2EContext } from './fixtures';

jest.setTimeout(120_000);

/**
 * T079(a): `loadPlatform` scans `lesson_sessions` once. The four values must equal what the previous four
 * separate subqueries returned, string formatting included, with sessions inside and outside the window and
 * with none (the `'0'` and NULLIF paths).
 */
describe('Admin dashboard platform row (postgres)', () => {
  let ctx: E2EContext;
  let service: AdminDashboardService;

  beforeAll(async () => {
    ctx = await createE2EApp();
    service = ctx.app.get(AdminDashboardService);
  });
  beforeEach(async () => resetDatabase(ctx.dataSource));
  afterAll(async () => ctx.app.close());

  const ds = (): DataSource => ctx.dataSource;
  const DAY = 86_400_000;
  let seq = 0;

  /** The four values exactly as the pre-T079 SQL computed them (oracle). */
  async function oldValues(start: Date, end: Date): Promise<Record<string, string>> {
    const rows = (await ds().query(
      `SELECT
        (SELECT COUNT(DISTINCT student_id) FROM lesson_sessions WHERE entered_at >= $1 AND entered_at < $2)::text AS active_learners,
        (SELECT COUNT(*) FROM lesson_sessions WHERE entered_at >= $1 AND entered_at < $2)::text AS lesson_views,
        (SELECT COALESCE(ROUND(AVG(duration_seconds)), 0) FROM lesson_sessions WHERE entered_at >= $1 AND entered_at < $2)::text AS average_session_duration_seconds,
        (SELECT COALESCE(ROUND(COUNT(*) FILTER (WHERE video_progress_percent >= 90)::numeric * 100 / NULLIF(COUNT(*), 0), 1), 0) FROM lesson_sessions WHERE entered_at >= $1 AND entered_at < $2)::text AS lesson_completion_rate`,
      [start, end],
    )) as Record<string, string>[];
    return rows[0]!;
  }

  async function newValues(start: Date, end: Date): Promise<Record<string, string>> {
    const row = await (
      service as unknown as { loadPlatform(s: Date, e: Date): Promise<Record<string, string>> }
    ).loadPlatform(start, end);
    return {
      active_learners: row['active_learners']!,
      lesson_views: row['lesson_views']!,
      average_session_duration_seconds: row['average_session_duration_seconds']!,
      lesson_completion_rate: row['lesson_completion_rate']!,
    };
  }

  async function person(role: UserRole): Promise<User> {
    seq += 1;
    const users = ds().getRepository(User);
    return users.save(
      users.create({
        username: `adp-${String(seq)}`,
        name: `Adp ${String(seq)}`,
        first_name: null,
        last_name: null,
        email: `adp-${String(seq)}@example.test`,
        phone: `0123${String(seq).padStart(7, '0')}`,
        role,
        status: UserStatus.APPROVED,
        is_active: true,
        password_hash: null,
      }),
    );
  }

  it('equals the four-subquery output with no sessions at all', async () => {
    const start = new Date(Date.now() - 30 * DAY);
    const end = new Date();
    const next = await newValues(start, end);
    expect(next).toEqual(await oldValues(start, end));
    expect(next).toEqual({
      active_learners: '0',
      lesson_views: '0',
      average_session_duration_seconds: '0',
      lesson_completion_rate: '0',
    });
  });

  it('equals the old output with sessions inside and outside the window', async () => {
    const teacher = await person(UserRole.TEACHER);
    const subject = await ds()
      .getRepository(Subject)
      .save(
        ds().getRepository(Subject).create({
          name: 'ADP subject',
          description: null,
          description_ar: null,
          status: SubjectStatus.APPROVED,
          created_by_teacher_id: null,
          rejection_reason: null,
          reviewed_by_admin_id: null,
          reviewed_at: null,
        }),
      );
    const lesson = await ds()
      .getRepository(Lesson)
      .save(
        ds().getRepository(Lesson).create({
          title: 'ADP lesson',
          description: null,
          teacher_id: teacher.id,
          subject_id: subject.id,
          thumbnail: null,
          price: 0,
          duration: 600,
          is_group: true,
          available_for_days: 30,
          students_count: 0,
          is_free_preview: false,
        }),
      );
    const a = await person(UserRole.STUDENT);
    const b = await person(UserRole.STUDENT);
    const insert = async (
      student: User,
      daysAgo: number,
      duration: number,
      progress: number,
    ): Promise<void> => {
      await ds().query(
        `INSERT INTO lesson_sessions (id, student_id, lesson_id, entered_at, duration_seconds, video_progress_percent)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          randomUUID(),
          student.id,
          lesson.id,
          new Date(Date.now() - daysAgo * DAY),
          duration,
          progress,
        ],
      );
    };
    // Inside the 30-day window: 2 learners, 4 views, one at exactly 90, one below, durations 60/125/200/45.
    await insert(a, 1, 60, 100);
    await insert(a, 2, 125, 90);
    await insert(b, 3, 200, 89);
    await insert(b, 4, 45, 10);
    // Outside the window: must not count.
    await insert(a, 45, 999, 100);

    const start = new Date(Date.now() - 30 * DAY);
    const end = new Date();
    const next = await newValues(start, end);
    expect(next).toEqual(await oldValues(start, end));
    expect(next['active_learners']).toBe('2');
    expect(next['lesson_views']).toBe('4');
    expect(next['lesson_completion_rate']).toBe('50.0');

    // A window containing only the outside session, and one containing nothing.
    const old = new Date(Date.now() - 50 * DAY);
    const oldEnd = new Date(Date.now() - 40 * DAY);
    expect(await newValues(old, oldEnd)).toEqual(await oldValues(old, oldEnd));
    const future = new Date(Date.now() + DAY);
    expect(await newValues(future, new Date(Date.now() + 2 * DAY))).toEqual(
      await oldValues(future, new Date(Date.now() + 2 * DAY)),
    );
  });

  it('scans lesson_sessions exactly once in the statement', () => {
    const source = (
      service as unknown as { loadPlatform: { toString(): string } }
    ).loadPlatform.toString();
    expect(source.match(/FROM lesson_sessions/g)).toHaveLength(1);
  });
});
