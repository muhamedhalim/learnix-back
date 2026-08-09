import type { Server } from 'node:http';

import request from 'supertest';

import { Book } from '../../src/books/entities/book.entity';
import { Lesson } from '../../src/lessons/entities/lesson.entity';
import { LessonStatus } from '../../src/lessons/entities/lesson-status.enum';
import { CourseStatus } from '../../src/packages/entities/course-status.enum';
import { LessonPackage } from '../../src/packages/entities/lesson-package.entity';
import { Subject } from '../../src/subjects/entities/subject.entity';
import { TeacherProfile } from '../../src/teachers/entities/teacher-profile.entity';

import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  type E2EContext,
} from './fixtures';

/**
 * Security-focused end-to-end tests (contract-correct):
 *   - invalid/malformed/expired tokens are rejected
 *   - SQL-injection attempts in the login field fail safely
 *   - responses never leak password hashes
 *   - security headers (Helmet) are present
 */
describe('Security (e2e)', () => {
  let ctx: E2EContext;
  let server: Server;

  beforeAll(async () => {
    ctx = await createE2EApp();
    server = ctx.app.getHttpServer() as Server;
  });

  beforeEach(async () => {
    await resetDatabase(ctx.dataSource);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  describe('token handling', () => {
    it('rejects a request with no token', async () => {
      await request(server).post(`${API_PREFIX}/auth/logout`).expect(401);
    });

    it('rejects an invalid token', async () => {
      await request(server)
        .post(`${API_PREFIX}/auth/logout`)
        .set('Authorization', 'Bearer invalid.token.value')
        .expect(401);
    });

    it('rejects a malformed authorization header', async () => {
      await request(server)
        .post(`${API_PREFIX}/auth/logout`)
        .set('Authorization', 'NotBearer xyz')
        .expect(401);
    });
  });

  describe('injection & data exposure', () => {
    it("treats a SQL-injection login payload as invalid credentials", async () => {
      await request(server)
        .post(`${API_PREFIX}/auth/login`)
        .send({ email: "admin' OR '1'='1", password: "' OR '1'='1" })
        .expect(401);
    });

    it('never returns a password hash on login', async () => {
      const { agent, credentials } = await createAuthenticatedUser(
        ctx.app,
        ctx.dataSource,
      );
      const res = await agent
        .post(`${API_PREFIX}/auth/login`)
        .send({ email: credentials.email, password: credentials.password })
        .expect(200);

      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toMatch(/password_hash/);
      expect(serialized).not.toMatch(/refreshToken/);
    });
  });

  describe('strict pagination validation', () => {
    it.each([
      ['page', '0'],
      ['page', '-1'],
      ['page', '1.5'],
      ['page', 'abc'],
      ['page', "1' OR '1'='1"],
      ['limit', '0'],
      ['limit', '-1'],
      ['limit', '1.5'],
      ['limit', 'abc'],
      ['limit', '101'],
      ['limit', '999999'],
    ])('returns 400 for explicitly invalid %s=%s', async (key, value) => {
      await request(server)
        .get(`${API_PREFIX}/teachers`)
        .query({ [key]: value })
        .expect(400);
    });

    it('uses documented defaults and accepts the valid maximum', async () => {
      const defaults = await request(server).get(`${API_PREFIX}/teachers`).expect(200);
      expect(defaults.body.meta).toMatchObject({ page: 1, limit: 20 });

      const maximum = await request(server)
        .get(`${API_PREFIX}/teachers`)
        .query({ page: '1', limit: '100' })
        .expect(200);
      expect(maximum.body.meta).toMatchObject({ page: 1, limit: 100 });
    });

    it('rejects repeated pagination parameters instead of accepting an array', async () => {
      await request(server)
        .get(`${API_PREFIX}/teachers?page=1&page=2&limit=20`)
        .expect(400);
    });
  });

  describe('public teacher serialization', () => {
    it('removes account PII from list/detail while preserving authorized views', async () => {
      const teacher = await createAuthenticatedUser(ctx.app, ctx.dataSource, {
        role: 'teacher',
        overrides: { requestedRole: 'teacher' },
      });
      const profile = await ctx.dataSource.getRepository(TeacherProfile).findOneByOrFail({
        user_id: teacher.userId,
      });

      const list = await request(server).get(`${API_PREFIX}/teachers`).expect(200);
      const detail = await request(server)
        .get(`${API_PREFIX}/teachers/${profile.id}`)
        .expect(200);
      for (const body of [list.body, detail.body]) {
        expect(JSON.stringify(body)).not.toMatch(
          /email|phone|password|refresh|rejection_reason|firebase_uid/i,
        );
      }

      const self = await teacher.agent.get(`${API_PREFIX}/teacher/profile`).expect(200);
      expect(JSON.stringify(self.body)).toContain(teacher.credentials.email);

      const admin = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'admin' });
      const administrative = await admin.agent
        .get(`${API_PREFIX}/admin/teachers/${profile.id}`)
        .expect(200);
      expect(JSON.stringify(administrative.body)).toContain(teacher.credentials.email);
    });

    it('sanitizes nested teachers and private media fields in public catalogues', async () => {
      const teacher = await createAuthenticatedUser(ctx.app, ctx.dataSource, {
        role: 'teacher',
        overrides: { requestedRole: 'teacher' },
      });
      const subjectRepository = ctx.dataSource.getRepository(Subject);
      const subject = await subjectRepository.save(
        subjectRepository.create({
          name: 'Security Test Subject',
          name_ar: null,
          description: null,
          description_ar: null,
          thumbnail: null,
        }),
      );

      const lessonRepository = ctx.dataSource.getRepository(Lesson);
      await lessonRepository.save(
        lessonRepository.create({
          title: 'Public Lesson',
          title_ar: 'Public Lesson',
          description: null,
          description_ar: null,
          teacher_id: teacher.userId,
          subject_id: subject.id,
          thumbnail: 'images/lesson.jpg',
          video_url: 'https://private-provider.example/video',
          bunny_video_id: 'private-video-id',
          bunny_library_id: 'private-library-id',
          price: 10,
          duration: 60,
          status: LessonStatus.PUBLISHED,
        }),
      );

      const packageRepository = ctx.dataSource.getRepository(LessonPackage);
      await packageRepository.save(
        packageRepository.create({
          title: 'Public Package',
          title_ar: 'Public Package',
          description: null,
          description_ar: null,
          teacher_id: teacher.userId,
          subject_id: subject.id,
          price: 20,
          original_price: null,
          is_active: true,
          thumbnail: 'images/package.jpg',
          status: CourseStatus.PUBLISHED,
          published_at: new Date(),
        }),
      );

      const bookRepository = ctx.dataSource.getRepository(Book);
      await bookRepository.save(
        bookRepository.create({
          title: 'Public Book',
          title_ar: 'Public Book',
          description: null,
          description_ar: null,
          teacher_id: teacher.userId,
          subject_id: subject.id,
          cover_image: 'images/book.jpg',
          book_file: `books/${teacher.userId}/private.pdf`,
          price: 30,
        }),
      );

      for (const endpoint of ['lessons', 'packages', 'books']) {
        const response = await request(server).get(`${API_PREFIX}/${endpoint}`).expect(200);
        const serialized = JSON.stringify(response.body);
        expect(serialized).not.toMatch(
          /email|phone|password|refresh|rejection_reason|firebase_uid|book_file|video_url|bunny_library_id|r2\.cloudflarestorage\.com/i,
        );
      }
    });
  });

  describe('security headers', () => {
    it('sets Helmet hardening headers', async () => {
      const res = await request(server).get(`${API_PREFIX}/health`).expect(200);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
    });
  });
});
