import request from 'supertest';
import type { DataSource } from 'typeorm';

import { Comment } from '../../src/comments/entities/comment.entity';
import { CommentReply } from '../../src/comments/entities/comment-reply.entity';
import { Lesson } from '../../src/lessons/entities/lesson.entity';
import { Subject } from '../../src/subjects/entities/subject.entity';
import { SubjectStatus } from '../../src/subjects/entities/subject-status.enum';
import { User, UserRole } from '../../src/users/entities';
import { UserStatus } from '../../src/users/entities/user-status.enum';
import { API_PREFIX, createE2EApp, resetDatabase, type E2EContext } from './fixtures';

jest.setTimeout(120_000);

/**
 * T082: `GET /lessons/:id/comments` selects only the mapped columns. The real query runs on Postgres, so an
 * invalid nested select key fails here, and the response must equal the pre-change shape exactly.
 */
describe('Lesson comments select (postgres)', () => {
  let ctx: E2EContext;

  beforeAll(async () => {
    ctx = await createE2EApp();
  });
  beforeEach(async () => resetDatabase(ctx.dataSource));
  afterAll(async () => ctx.app.close());

  const ds = (): DataSource => ctx.dataSource;
  let seq = 0;

  async function user(role: UserRole, name: string): Promise<User> {
    seq += 1;
    const users = ds().getRepository(User);
    return users.save(
      users.create({
        username: `lcs-${String(seq)}`,
        name,
        first_name: null,
        last_name: null,
        email: `lcs-${String(seq)}@example.test`,
        phone: `0127${String(seq).padStart(7, '0')}`,
        role,
        status: UserStatus.APPROVED,
        is_active: true,
        password_hash: null,
      }),
    );
  }

  it('returns the unchanged response shape, paginated newest first, with nested users as {id, name}', async () => {
    const teacher = await user(UserRole.TEACHER, 'Teacher T');
    const student = await user(UserRole.STUDENT, 'Student S');
    const subject = await ds()
      .getRepository(Subject)
      .save(
        ds().getRepository(Subject).create({
          name: 'LCS subject',
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
          title: 'LCS lesson',
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
    const comments = ds().getRepository(Comment);
    const older = await comments.save(
      comments.create({ lesson_id: lesson.id, student_id: student.id, comment_text: 'older' }),
    );
    const newer = await comments.save(
      comments.create({ lesson_id: lesson.id, student_id: student.id, comment_text: 'newer' }),
    );
    await ds().query("UPDATE comments SET created_at = NOW() - INTERVAL '1 day' WHERE id = $1", [
      older.id,
    ]);
    const replies = ds().getRepository(CommentReply);
    await replies.save(
      replies.create({ comment_id: newer.id, teacher_id: teacher.id, reply_text: 'answer' }),
    );

    const res = await request(ctx.app.getHttpServer())
      .get(`${API_PREFIX}/lessons/${lesson.id}/comments`)
      .expect(200);

    expect(res.body.meta).toMatchObject({ page: 1, limit: 20, total: 2 });
    const [first, second] = res.body.data as Array<Record<string, any>>;
    expect(first['comment_text']).toBe('newer');
    expect(second['comment_text']).toBe('older');
    expect(Object.keys(first!).sort()).toEqual(
      [
        'comment_text',
        'created_at',
        'id',
        'lesson_id',
        'replies',
        'student',
        'student_id',
        'updated_at',
      ].sort(),
    );
    expect(first!['student']).toEqual({ id: student.id, name: 'Student S' });
    expect(first!['replies']).toHaveLength(1);
    expect(Object.keys(first!['replies'][0]).sort()).toEqual([
      'created_at',
      'id',
      'reply_text',
      'teacher',
    ]);
    expect(first!['replies'][0].teacher).toEqual({ id: teacher.id, name: 'Teacher T' });
    expect(second!['replies']).toEqual([]);
  });

  it('answers 404 for a soft-deleted lesson (existence probe keeps the deleted_at filter)', async () => {
    const teacher = await user(UserRole.TEACHER, 'Teacher T');
    const subject = await ds()
      .getRepository(Subject)
      .save(
        ds().getRepository(Subject).create({
          name: 'LCS subject',
          description: null,
          description_ar: null,
          status: SubjectStatus.APPROVED,
          created_by_teacher_id: null,
          rejection_reason: null,
          reviewed_by_admin_id: null,
          reviewed_at: null,
        }),
      );
    const lessons = ds().getRepository(Lesson);
    const lesson = await lessons.save(
      lessons.create({
        title: 'Gone',
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
    await lessons.softDelete({ id: lesson.id });

    await request(ctx.app.getHttpServer())
      .get(`${API_PREFIX}/lessons/${lesson.id}/comments`)
      .expect(404);
  });
});
