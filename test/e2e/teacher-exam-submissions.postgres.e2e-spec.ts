import { randomUUID } from 'node:crypto';

import type { DataSource } from 'typeorm';

import { Exam } from '../../src/exams/entities/exam.entity';
import { ExamAttempt } from '../../src/exams/entities/exam-attempt.entity';
import { Subject } from '../../src/subjects/entities/subject.entity';
import { SubjectStatus } from '../../src/subjects/entities/subject-status.enum';
import { User, UserRole } from '../../src/users/entities';
import { UserStatus } from '../../src/users/entities/user-status.enum';
import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  type E2EContext,
} from './fixtures';

jest.setTimeout(120_000);

/**
 * T083(c): `GET /teacher/exams/:id/submissions` selects only the mapped columns. The JSON must be
 * identical to what the unselected query returned: same fields, same order, pages through
 * skip/take, and a foreign teacher still gets 404 (never an empty page).
 */
describe('Teacher exam submissions (postgres)', () => {
  let ctx: E2EContext;

  beforeAll(async () => {
    ctx = await createE2EApp();
  });
  beforeEach(async () => resetDatabase(ctx.dataSource));
  afterAll(async () => ctx.app.close());

  const ds = (): DataSource => ctx.dataSource;
  const MIN = 60_000;
  let seq = 0;

  async function student(): Promise<User> {
    seq += 1;
    const users = ds().getRepository(User);
    return users.save(
      users.create({
        username: `tes-${String(seq)}`,
        name: `Student ${String(seq)}`,
        first_name: null,
        last_name: null,
        email: `tes-${String(seq)}@example.test`,
        phone: `0128${String(seq).padStart(7, '0')}`,
        role: UserRole.STUDENT,
        status: UserStatus.APPROVED,
        is_active: true,
        password_hash: null,
      }),
    );
  }

  async function seed() {
    const owner = await createAuthenticatedUser(ctx.app, ds(), { role: 'teacher' });
    const foreign = await createAuthenticatedUser(ctx.app, ds(), { role: 'teacher' });
    const subject = await ds()
      .getRepository(Subject)
      .save(
        ds().getRepository(Subject).create({
          name: 'TES subject',
          description: null,
          description_ar: null,
          status: SubjectStatus.APPROVED,
          created_by_teacher_id: null,
          rejection_reason: null,
          reviewed_by_admin_id: null,
          reviewed_at: null,
        }),
      );
    const exams = ds().getRepository(Exam);
    const exam = (await exams.save(
      exams.create({
        teacher_id: owner.userId,
        subject_id: subject.id,
        lesson_id: null,
        package_id: null,
        title: 'TES exam',
        title_ar: 'TES exam',
        description: null,
        description_ar: null,
        is_public: false,
        config: {},
        total_marks: 10,
        passing_marks: 5,
      } as never) as unknown as Exam,
    )) as Exam;

    const attempts = ds().getRepository(ExamAttempt);
    const base = Date.now() - 60 * MIN;
    const saved: ExamAttempt[] = [];
    for (let i = 0; i < 5; i += 1) {
      const s = await student();
      const submitted = new Date(base + i * 5 * MIN);
      saved.push(
        (await attempts.save(
          attempts.create({
            exam_id: exam.id,
            student_id: s.id,
            attempt_number: 1,
            state: i === 4 ? 'in_progress' : 'graded',
            shuffle_seed: 0,
            started_at: new Date(submitted.getTime() - 20 * MIN),
            deadline_at: new Date(submitted.getTime() + 60 * MIN),
            submitted_at: i === 4 ? null : submitted,
            auto_submitted: false,
            graded_at: i === 4 ? null : submitted,
            score_auto: i,
            score_manual: 0,
            score_total: i,
            max_score: 10,
            passed: i >= 5,
            session_token: randomUUID(),
            idempotency_key: null,
            origin: 'online',
            created_at: submitted,
            updated_at: submitted,
          } as never) as unknown as ExamAttempt,
        )) as ExamAttempt,
      );
    }
    return { owner, foreign, exam, saved };
  }

  it('returns the full mapped shape, newest first, across two pages', async () => {
    const { owner, exam, saved } = await seed();

    const first = await owner.agent
      .get(`${API_PREFIX}/teacher/exams/${exam.id}/submissions`)
      .query({ page: 1, limit: 3 })
      .expect(200);
    const second = await owner.agent
      .get(`${API_PREFIX}/teacher/exams/${exam.id}/submissions`)
      .query({ page: 2, limit: 3 })
      .expect(200);

    expect(first.body.meta).toMatchObject({ page: 1, limit: 3, total: 5, totalPages: 2 });
    expect(second.body.meta).toMatchObject({ page: 2, limit: 3, total: 5 });
    const rows = [...first.body.data, ...second.body.data] as Array<Record<string, any>>;
    expect(rows).toHaveLength(5);
    // submitted_at DESC puts the NULL (in-progress) attempt first in PostgreSQL, then newest to oldest.
    const expectedOrder = [saved[4]!, saved[3]!, saved[2]!, saved[1]!, saved[0]!].map((a) => a.id);
    expect(rows.map((row) => row['attempt_id'])).toEqual(expectedOrder);

    const sample = rows.find((row) => row['attempt_id'] === saved[3]!.id)!;
    expect(Object.keys(sample).sort()).toEqual(
      [
        'attempt_id',
        'attempt_number',
        'max_score',
        'passed',
        'score_auto',
        'score_manual',
        'score_total',
        'state',
        'student',
        'submitted_at',
      ].sort(),
    );
    const owner3 = await ds().getRepository(User).findOneByOrFail({ id: saved[3]!.student_id });
    expect(sample['student']).toEqual({ id: owner3.id, name: owner3.name, email: owner3.email });
    expect(sample).toMatchObject({
      attempt_number: 1,
      state: 'graded',
      score_total: 3,
      max_score: 10,
      passed: false,
    });
    expect(new Date(sample['submitted_at']).getTime()).toBe(saved[3]!.submitted_at!.getTime());
  });

  it('answers 404 (not an empty page) to a teacher who does not own the exam', async () => {
    const { foreign, exam } = await seed();

    await foreign.agent.get(`${API_PREFIX}/teacher/exams/${exam.id}/submissions`).expect(404);
  });
});
