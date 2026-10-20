import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { Comment, CommentReply } from '../../src/comments/entities';
import { Lesson } from '../../src/lessons/entities/lesson.entity';
import { LessonReview, TeacherReview } from '../../src/reviews/entities';
import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  type AuthenticatedUser,
} from './fixtures';
import { createEnrolledStudent } from './helpers/enrolled-student';

/**
 * FIA-001 regression coverage at the HTTP boundary (spec 005).
 *
 * The student comment, teacher comment-reply and teacher review controllers read
 * `req.user.id`, but every authentication path publishes `JwtPayload`, which carries
 * `userId` and no `id`. Every teacher reply therefore answered 403, the teacher review
 * inbox was always empty, and no student comment could be created. The service specs
 * passed throughout because they call the services with explicit ids; only a request
 * through the real guards exposes the principal shape, so that is what this spec does.
 */
describe('Lesson comments and teacher review replies (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  let student: AuthenticatedUser;
  let lesson: Lesson;
  let teacher: AuthenticatedUser;
  let otherTeacher: AuthenticatedUser;

  beforeAll(async () => {
    ({ app, dataSource } = await createE2EApp());
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    ({ student, lesson } = await createEnrolledStudent(app, dataSource));
    teacher = await createAuthenticatedUser(app, dataSource, { role: 'teacher' });
    otherTeacher = await createAuthenticatedUser(app, dataSource, { role: 'teacher' });
    // The purchased lesson belongs to the logged-in teacher.
    await dataSource
      .getRepository(Lesson)
      .update({ id: lesson.id }, { teacher_id: teacher.userId });
  });

  afterAll(async () => {
    await app.close();
  });

  async function seedComment(): Promise<Comment> {
    const comments = dataSource.getRepository(Comment);
    return comments.save(
      comments.create({
        lesson_id: lesson.id,
        student_id: student.userId,
        comment_text: 'Fixture comment',
      }),
    );
  }

  async function seedLessonReview(): Promise<LessonReview> {
    const reviews = dataSource.getRepository(LessonReview);
    return reviews.save(
      reviews.create({
        lesson_id: lesson.id,
        student_id: student.userId,
        rating: 5,
        comment: 'Clear lesson',
      }),
    );
  }

  async function seedProfileReview(): Promise<TeacherReview> {
    const reviews = dataSource.getRepository(TeacherReview);
    return reviews.save(
      reviews.create({
        teacher_id: teacher.userId,
        student_id: student.userId,
        rating: 4,
        comment: 'Helpful',
      }),
    );
  }

  describe('POST /student/lessons/:lessonId/comments', () => {
    it('creates the comment owned by the purchasing student', async () => {
      const res = await student.agent
        .post(`${API_PREFIX}/student/lessons/${lesson.id}/comments`)
        .send({ comment_text: 'When is the next session?' })
        .expect(201);

      expect(res.body).toMatchObject({ lesson_id: lesson.id, student_id: student.userId });
      const stored = await dataSource.getRepository(Comment).findBy({ lesson_id: lesson.id });
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        student_id: student.userId,
        comment_text: 'When is the next session?',
      });
    });

    it('refuses a student without a purchase, even when another student owns one', async () => {
      const outsider = await createAuthenticatedUser(app, dataSource);

      await outsider.agent
        .post(`${API_PREFIX}/student/lessons/${lesson.id}/comments`)
        .send({ comment_text: 'Not mine to ask' })
        .expect(403);

      expect(await dataSource.getRepository(Comment).countBy({ lesson_id: lesson.id })).toBe(0);
    });
  });

  describe('POST /teacher/comments/:commentId/reply', () => {
    it('lets the lesson owner reply', async () => {
      const comment = await seedComment();

      await teacher.agent
        .post(`${API_PREFIX}/teacher/comments/${comment.id}/reply`)
        .send({ reply_text: 'Thursday at 6' })
        .expect(201);

      const replies = await dataSource
        .getRepository(CommentReply)
        .findBy({ comment_id: comment.id });
      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatchObject({ teacher_id: teacher.userId, reply_text: 'Thursday at 6' });
    });

    it('refuses a teacher who does not own the lesson', async () => {
      const comment = await seedComment();

      await otherTeacher.agent
        .post(`${API_PREFIX}/teacher/comments/${comment.id}/reply`)
        .send({ reply_text: 'Not my lesson' })
        .expect(403);

      expect(await dataSource.getRepository(CommentReply).countBy({ comment_id: comment.id })).toBe(
        0,
      );
    });
  });

  describe('GET /teacher/reviews', () => {
    it("lists the teacher's lesson and profile reviews, and only theirs", async () => {
      const lessonReview = await seedLessonReview();
      const profileReview = await seedProfileReview();

      const res = await teacher.agent.get(`${API_PREFIX}/teacher/reviews`).expect(200);
      const body = res.body as
        | { data?: Array<{ id: string; review_type: string }> }
        | Array<{ id: string; review_type: string }>;
      const rows = Array.isArray(body) ? body : (body.data ?? []);
      expect(rows.map((r) => [r.id, r.review_type]).sort()).toEqual(
        [
          [lessonReview.id, 'lesson'],
          [profileReview.id, 'teacher'],
        ].sort(),
      );

      const other = await otherTeacher.agent.get(`${API_PREFIX}/teacher/reviews`).expect(200);
      const otherBody = other.body as { data?: unknown[] } | unknown[];
      expect(Array.isArray(otherBody) ? otherBody : (otherBody.data ?? [])).toHaveLength(0);
    });
  });

  describe('POST /teacher/reviews/:reviewId/reply', () => {
    it('stores the reply from the lesson owner', async () => {
      const review = await seedLessonReview();

      await teacher.agent
        .post(`${API_PREFIX}/teacher/reviews/${review.id}/reply`)
        .send({ reply: 'Thank you' })
        .expect(201);

      const stored = await dataSource
        .getRepository(LessonReview)
        .findOneByOrFail({ id: review.id });
      expect(stored.teacher_reply).toBe('Thank you');
      expect(stored.teacher_reply_at).not.toBeNull();
    });

    it('refuses a teacher who does not own the lesson', async () => {
      const review = await seedLessonReview();

      await otherTeacher.agent
        .post(`${API_PREFIX}/teacher/reviews/${review.id}/reply`)
        .send({ reply: 'Not mine' })
        .expect(403);

      const stored = await dataSource
        .getRepository(LessonReview)
        .findOneByOrFail({ id: review.id });
      expect(stored.teacher_reply).toBeNull();
    });
  });

  describe('POST /teacher/reviews/profile/:reviewId/reply', () => {
    it('stores the reply from the reviewed teacher', async () => {
      const review = await seedProfileReview();

      await teacher.agent
        .post(`${API_PREFIX}/teacher/reviews/profile/${review.id}/reply`)
        .send({ reply: 'Glad it helped' })
        .expect(201);

      const stored = await dataSource
        .getRepository(TeacherReview)
        .findOneByOrFail({ id: review.id });
      expect(stored.teacher_reply).toBe('Glad it helped');
    });

    it('refuses another teacher', async () => {
      const review = await seedProfileReview();

      await otherTeacher.agent
        .post(`${API_PREFIX}/teacher/reviews/profile/${review.id}/reply`)
        .send({ reply: 'Not mine' })
        .expect(403);

      const stored = await dataSource
        .getRepository(TeacherReview)
        .findOneByOrFail({ id: review.id });
      expect(stored.teacher_reply).toBeNull();
    });
  });
});
