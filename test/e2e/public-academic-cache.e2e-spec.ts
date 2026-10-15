import type { Server } from 'node:http';

import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { INestApplication } from '@nestjs/common';

import type { Cache } from 'cache-manager';
import request from 'supertest';
import type { DataSource } from 'typeorm';

import { ApplicationCacheService } from '../../src/common/cache/application-cache.service';
import { RedisKeyvStore } from '../../src/common/cache/redis-keyv.store';
import { API_PREFIX, createAuthenticatedUser, createE2EApp, resetDatabase } from './fixtures';
import { StatementCounter } from './helpers/statement-counter';

/**
 * Spec 004 Wave 1 (T037 a): `GET packages/:id/preview` caches only the unsigned half of the response
 * (family `public_catalog`, 60 s TTL); a per-request signed URL is generated fresh after every cache
 * read (hit or miss), so a signed value never spends its TTL sitting in Redis (rule 8).
 */
describe('public academic cache: package preview split (spec 004 T037 a)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let server: Server;
  let cacheManager: Cache;
  let client: { set(...args: unknown[]): Promise<unknown> };

  beforeAll(async () => {
    const ctx = await createE2EApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    server = app.getHttpServer() as Server;
    cacheManager = app.get<Cache>(CACHE_MANAGER);
    const store = cacheManager.stores[0]?.store as unknown;
    if (!(store instanceof RedisKeyvStore)) {
      throw new Error(
        'The e2e cache manager is not backed by RedisKeyvStore; is REDIS_HOST set in .env.test?',
      );
    }
    client = (store as unknown as { client: { set(...args: unknown[]): Promise<unknown> } }).client;
  });

  afterAll(async () => app.close());
  beforeEach(async () => resetDatabase(dataSource));

  async function seedPreviewFixture(): Promise<{
    packageId: string;
    teacher: Awaited<ReturnType<typeof createAuthenticatedUser>>;
  }> {
    const teacher = await createAuthenticatedUser(app, dataSource, { role: 'teacher' });
    const [{ id: subjectId }] = (await dataSource.query(
      `INSERT INTO subjects (id, name) VALUES (gen_random_uuid(), 'Preview Cache Subject') RETURNING id`,
    )) as [{ id: string }];
    const [{ id: freeLessonId }] = (await dataSource.query(
      `INSERT INTO lessons (id, title, teacher_id, subject_id, price, version, status, is_free_preview, video_asset_id, video_status)
       VALUES (gen_random_uuid(), 'Free preview lesson', $1, $2, 100, 1, 'published', true, gen_random_uuid(), 'ready') RETURNING id`,
      [teacher.userId, subjectId],
    )) as [{ id: string }];
    const [{ id: lockedLessonId }] = (await dataSource.query(
      `INSERT INTO lessons (id, title, teacher_id, subject_id, price, version, status, is_free_preview)
       VALUES (gen_random_uuid(), 'Locked lesson', $1, $2, 100, 1, 'published', false) RETURNING id`,
      [teacher.userId, subjectId],
    )) as [{ id: string }];
    const [{ id: packageId }] = (await dataSource.query(
      `INSERT INTO lesson_packages (id, title, title_ar, teacher_id, price, status, is_active)
       VALUES (gen_random_uuid(), 'Preview Cache Course', 'كورس', $1, 0, 'published', true) RETURNING id`,
      [teacher.userId],
    )) as [{ id: string }];
    await dataSource.query(
      `INSERT INTO lesson_package_items (id, package_id, lesson_id, order_index)
       VALUES (gen_random_uuid(), $1, $2, 0), (gen_random_uuid(), $1, $3, 1)`,
      [packageId, freeLessonId, lockedLessonId],
    );
    return { packageId, teacher };
  }

  async function getPreview(packageId: string): Promise<{
    students_count: number;
    curriculum: {
      lessons: {
        id: string;
        locked: boolean;
        video: { platform: 'aws'; lesson_id: string } | null;
      }[];
    }[];
  }> {
    const res = await request(server)
      .get(`${API_PREFIX}/packages/${packageId}/preview`)
      .expect(200);
    return res.body as never;
  }

  it('T042: the package preview (miss and hit) is private, no-store and never public/s-maxage', async () => {
    const { packageId } = await seedPreviewFixture();

    for (const _pass of ['miss', 'hit']) {
      const res = await request(server)
        .get(`${API_PREFIX}/packages/${packageId}/preview`)
        .expect(200);
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.headers['cache-control']).not.toMatch(/public|s-maxage/);
    }
  });

  it('a repeat request is a cache hit: no database statement at all', async () => {
    const { packageId } = await seedPreviewFixture();
    await getPreview(packageId); // miss: computes and caches

    const counter = new StatementCounter(dataSource);
    counter.start();
    await request(server)
      .get(`${API_PREFIX}/packages/${packageId}/preview`)
      .set('X-Request-Id', 't037a-hit')
      .expect(200);
    counter.stop();

    expect(counter.count({ requestId: 't037a-hit' })).toBe(0);
  });

  it('miss and hit responses each point the free-preview lesson at the playback route; the locked lesson always has video: null', async () => {
    const { packageId } = await seedPreviewFixture();

    const miss = await getPreview(packageId);
    const hit = await getPreview(packageId);

    for (const response of [miss, hit]) {
      const flat = response.curriculum.flatMap((section) => section.lessons);
      const free = flat.find((lesson) => !lesson.locked)!;
      const locked = flat.find((lesson) => lesson.locked)!;
      expect(free.video).toEqual({ platform: 'aws', lesson_id: free.id });
      expect(locked.video).toBeNull();
    }
    // The grant itself (HLS URL and signed cookies) is issued per request by the playback route, so the
    // cached preview never holds anything that expires.
  });

  it('the raw value written to Redis never contains a grant, cookie or expiry (rule 8); the HTTP body never carries the storage asset id', async () => {
    const { packageId } = await seedPreviewFixture();
    const sets = jest.spyOn(client, 'set');

    const res = await request(server)
      .get(`${API_PREFIX}/packages/${packageId}/preview`)
      .expect(200);

    const previewSetCall = sets.mock.calls.find((call) => {
      const raw = call[1];
      return typeof raw === 'string' && raw.includes('Free preview lesson');
    });
    expect(previewSetCall).toBeDefined();
    const rawValue = previewSetCall![1] as string;
    // The marker naming the playable free-preview lesson IS expected in the cached value — that is the
    // whole point of the split (the grant is issued after every read, never cached). Only grants,
    // cookies and expiries are prohibited from ever reaching Redis.
    expect(rawValue).toContain('aws_playback_lesson_id');
    expect(rawValue).not.toMatch(/signed_url|expires_in|playback_cookies|CloudFront-/);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain('video_asset_id');
    expect(body).not.toContain('aws_playback_lesson_id');
    expect(body).not.toMatch(/playback_cookies|CloudFront-/);

    sets.mockRestore();
  });

  it('unpublishing via the real API hides the preview on the very next request (no TTL wait: the undeclared status route bumps the global generation)', async () => {
    const { packageId, teacher } = await seedPreviewFixture();
    await getPreview(packageId); // warm the cache
    await expect(getPreview(packageId)).resolves.toMatchObject({ students_count: 0 }); // still a hit

    await teacher.agent
      .patch(`${API_PREFIX}/teacher/packages/${packageId}/status`)
      .send({ status: 'draft' })
      .expect(200);

    await request(server).get(`${API_PREFIX}/packages/${packageId}/preview`).expect(404);
  });
});

/**
 * Spec 004 Wave 1 (T038): the remaining public academic endpoints T026 proved
 * viewer-independent, all sharing the same `public_catalog` family (60 s TTL).
 * Each block: a repeat request is a cache hit (0 SQL), and a real write through
 * the app's own API is reflected on the very next request (no TTL wait —
 * every writer below is an undeclared route, so it bumps the global
 * generation per `contracts/cache-invalidation.md` rule 3).
 */
describe('public academic cache: remaining endpoints (spec 004 T038)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let server: Server;

  beforeAll(async () => {
    const ctx = await createE2EApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => app.close());
  beforeEach(async () => resetDatabase(dataSource));

  describe('subjects', () => {
    async function seedSubject(): Promise<string> {
      const [{ id }] = (await dataSource.query(
        `INSERT INTO subjects (id, name, status) VALUES (gen_random_uuid(), 'Chemistry', 'approved') RETURNING id`,
      )) as [{ id: string }];
      return id;
    }

    it('GET subjects is a cache hit on the second request: 0 SQL', async () => {
      await seedSubject();
      await request(server).get(`${API_PREFIX}/subjects`).expect(200); // miss

      const counter = new StatementCounter(dataSource);
      counter.start();
      await request(server)
        .get(`${API_PREFIX}/subjects`)
        .set('X-Request-Id', 't038-subjects-hit')
        .expect(200);
      counter.stop();

      expect(counter.count({ requestId: 't038-subjects-hit' })).toBe(0);
    });

    it('an admin rename is reflected on the very next GET subjects/:id (no TTL wait)', async () => {
      const subjectId = await seedSubject();
      const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });

      const warm = await request(server).get(`${API_PREFIX}/subjects/${subjectId}`).expect(200);
      expect((warm.body as { name: string }).name).toBe('Chemistry');

      await admin.agent
        .put(`${API_PREFIX}/admin/subjects/${subjectId}`)
        .send({ name: 'Applied Chemistry' })
        .expect(200);

      const fresh = await request(server).get(`${API_PREFIX}/subjects/${subjectId}`).expect(200);
      expect((fresh.body as { name: string }).name).toBe('Applied Chemistry');
    });
  });

  describe('teachers', () => {
    async function seedApprovedTeacher(): Promise<{
      userId: string;
      agent: ReturnType<typeof request.agent>;
    }> {
      const teacher = await createAuthenticatedUser(app, dataSource, { role: 'teacher' });
      await dataSource.query(
        `INSERT INTO teacher_profiles (id, user_id, qualifications, years_of_experience, bio)
         VALUES (gen_random_uuid(), $1, 'B.Sc Physics', 5, 'Original bio')`,
        [teacher.userId],
      );
      return teacher;
    }

    it('GET teachers is a cache hit on the second request: 0 SQL', async () => {
      await seedApprovedTeacher();
      await request(server).get(`${API_PREFIX}/teachers`).expect(200); // miss

      const counter = new StatementCounter(dataSource);
      counter.start();
      await request(server)
        .get(`${API_PREFIX}/teachers`)
        .set('X-Request-Id', 't038-teachers-hit')
        .expect(200);
      counter.stop();

      expect(counter.count({ requestId: 't038-teachers-hit' })).toBe(0);
    });

    it("the teacher's own profile edit is reflected on the very next GET teachers (no TTL wait)", async () => {
      const teacher = await seedApprovedTeacher();

      const warm = await request(server).get(`${API_PREFIX}/teachers`).expect(200);
      expect(JSON.stringify(warm.body)).toContain('Original bio');

      await teacher.agent
        .put(`${API_PREFIX}/teacher/profile`)
        .send({ bio: 'Updated bio' })
        .expect(200);

      const fresh = await request(server).get(`${API_PREFIX}/teachers`).expect(200);
      expect(JSON.stringify(fresh.body)).toContain('Updated bio');
      expect(JSON.stringify(fresh.body)).not.toContain('Original bio');
    });
  });

  describe('packages (list and detail)', () => {
    async function seedPackage(teacherId: string): Promise<string> {
      const [{ id: packageId }] = (await dataSource.query(
        `INSERT INTO lesson_packages (id, title, title_ar, teacher_id, price, status, is_active)
         VALUES (gen_random_uuid(), 'Catalog Course', 'كورس', $1, 100, 'published', true) RETURNING id`,
        [teacherId],
      )) as [{ id: string }];
      return packageId;
    }

    it('GET packages is a cache hit on the second request: 0 SQL', async () => {
      const teacher = await createAuthenticatedUser(app, dataSource, { role: 'teacher' });
      await seedPackage(teacher.userId);
      await request(server).get(`${API_PREFIX}/packages`).expect(200); // miss

      const counter = new StatementCounter(dataSource);
      counter.start();
      await request(server)
        .get(`${API_PREFIX}/packages`)
        .set('X-Request-Id', 't038-packages-hit')
        .expect(200);
      counter.stop();

      expect(counter.count({ requestId: 't038-packages-hit' })).toBe(0);
    });

    it('unpublishing via the real API hides the course from GET packages/:id on the very next request', async () => {
      const teacher = await createAuthenticatedUser(app, dataSource, { role: 'teacher' });
      const packageId = await seedPackage(teacher.userId);

      await request(server).get(`${API_PREFIX}/packages/${packageId}`).expect(200); // warm

      await teacher.agent
        .patch(`${API_PREFIX}/teacher/packages/${packageId}/status`)
        .send({ status: 'draft' })
        .expect(200);

      await request(server).get(`${API_PREFIX}/packages/${packageId}`).expect(404);
    });
  });

  describe('books', () => {
    async function seedBook(teacherId: string, subjectId: string): Promise<string> {
      const [{ id: bookId }] = (await dataSource.query(
        `INSERT INTO books (id, title, title_ar, teacher_id, subject_id, book_file, price)
         VALUES (gen_random_uuid(), 'Algebra Primer', 'الجبر', $1, $2, $3, 100) RETURNING id`,
        [teacherId, subjectId, `books/${teacherId}/algebra.pdf`],
      )) as [{ id: string }];
      return bookId;
    }

    async function seedSubjectId(): Promise<string> {
      const [{ id }] = (await dataSource.query(
        `INSERT INTO subjects (id, name) VALUES (gen_random_uuid(), 'Math for Books') RETURNING id`,
      )) as [{ id: string }];
      return id;
    }

    it('GET books is a cache hit on the second request: 0 SQL', async () => {
      const teacher = await createAuthenticatedUser(app, dataSource, { role: 'teacher' });
      const subjectId = await seedSubjectId();
      await seedBook(teacher.userId, subjectId);
      await request(server).get(`${API_PREFIX}/books`).expect(200); // miss

      const counter = new StatementCounter(dataSource);
      counter.start();
      await request(server)
        .get(`${API_PREFIX}/books`)
        .set('X-Request-Id', 't038-books-hit')
        .expect(200);
      counter.stop();

      expect(counter.count({ requestId: 't038-books-hit' })).toBe(0);
    });

    it("the teacher's own book edit is reflected on the very next GET books/:id (no TTL wait)", async () => {
      const teacher = await createAuthenticatedUser(app, dataSource, { role: 'teacher' });
      const subjectId = await seedSubjectId();
      const bookId = await seedBook(teacher.userId, subjectId);

      const warm = await request(server).get(`${API_PREFIX}/books/${bookId}`).expect(200);
      expect((warm.body as { title: string }).title).toBe('Algebra Primer');

      await teacher.agent
        .put(`${API_PREFIX}/teacher/books/${bookId}`)
        .send({ title: 'Algebra Primer, Revised' })
        .expect(200);

      const fresh = await request(server).get(`${API_PREFIX}/books/${bookId}`).expect(200);
      expect((fresh.body as { title: string }).title).toBe('Algebra Primer, Revised');
    });
  });

  describe('reviews', () => {
    async function seedLessonWithApprovedReview(): Promise<{ lessonId: string; reviewId: string }> {
      const teacher = await createAuthenticatedUser(app, dataSource, { role: 'teacher' });
      const student = await createAuthenticatedUser(app, dataSource, { role: 'student' });
      const [{ id: subjectId }] = (await dataSource.query(
        `INSERT INTO subjects (id, name) VALUES (gen_random_uuid(), 'Reviewed Subject') RETURNING id`,
      )) as [{ id: string }];
      const [{ id: lessonId }] = (await dataSource.query(
        `INSERT INTO lessons (id, title, teacher_id, subject_id, price, version, status)
         VALUES (gen_random_uuid(), 'Reviewed Lesson', $1, $2, 100, 1, 'published') RETURNING id`,
        [teacher.userId, subjectId],
      )) as [{ id: string }];
      const [{ id: reviewId }] = (await dataSource.query(
        `INSERT INTO lesson_reviews (id, lesson_id, student_id, rating, comment, status)
         VALUES (gen_random_uuid(), $1, $2, 5, 'Great lesson', 'approved') RETURNING id`,
        [lessonId, student.userId],
      )) as [{ id: string }];
      return { lessonId, reviewId };
    }

    it('GET lessons/:lessonId/reviews is a cache hit on the second request: 0 SQL', async () => {
      const { lessonId } = await seedLessonWithApprovedReview();
      await request(server).get(`${API_PREFIX}/lessons/${lessonId}/reviews`).expect(200); // miss

      const counter = new StatementCounter(dataSource);
      counter.start();
      await request(server)
        .get(`${API_PREFIX}/lessons/${lessonId}/reviews`)
        .set('X-Request-Id', 't038-reviews-hit')
        .expect(200);
      counter.stop();

      expect(counter.count({ requestId: 't038-reviews-hit' })).toBe(0);
    });

    it('an admin rejecting the review is reflected on the very next request (no TTL wait)', async () => {
      const { lessonId, reviewId } = await seedLessonWithApprovedReview();
      const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });

      const warm = await request(server)
        .get(`${API_PREFIX}/lessons/${lessonId}/reviews`)
        .expect(200);
      expect((warm.body as { meta: { total: number } }).meta.total).toBe(1);

      await admin.agent
        .patch(`${API_PREFIX}/admin/reviews/lesson/${reviewId}/status`)
        .send({ status: 'rejected' })
        .expect(200);

      const fresh = await request(server)
        .get(`${API_PREFIX}/lessons/${lessonId}/reviews`)
        .expect(200);
      expect((fresh.body as { meta: { total: number } }).meta.total).toBe(0);
    });
  });

  describe('certificates/public gallery', () => {
    async function seedPublicCertificate(): Promise<{ certificateId: string; adminId: string }> {
      const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
      const [{ id: packageId }] = (await dataSource.query(
        `INSERT INTO lesson_packages (id, title, title_ar, teacher_id, price, status, is_active)
         VALUES (gen_random_uuid(), 'Certified Course', 'دورة', $1, 0, 'published', true) RETURNING id`,
        [admin.userId],
      )) as [{ id: string }];
      const [{ id: certificateId }] = (await dataSource.query(
        `INSERT INTO certificates
           (certificate_number, verification_code, student_id, package_id, student_name, course_title, issued_at, is_public, status)
         VALUES ('CERT-T038-1', 'VERIFY-T038-1', $1, $2, 'Student One', 'Certified Course', now(), true, 'issued')
         RETURNING id`,
        [admin.userId, packageId],
      )) as [{ id: string }];
      return { certificateId, adminId: admin.userId };
    }

    it('GET certificates/public is a cache hit on the second request: 0 SQL', async () => {
      await seedPublicCertificate();
      await request(server).get(`${API_PREFIX}/certificates/public`).expect(200); // miss

      const counter = new StatementCounter(dataSource);
      counter.start();
      await request(server)
        .get(`${API_PREFIX}/certificates/public`)
        .set('X-Request-Id', 't038-certificates-hit')
        .expect(200);
      counter.stop();

      expect(counter.count({ requestId: 't038-certificates-hit' })).toBe(0);
    });

    it('an admin revoke is reflected on the very next request (no TTL wait)', async () => {
      const { certificateId } = await seedPublicCertificate();
      const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });

      const warm = await request(server).get(`${API_PREFIX}/certificates/public`).expect(200);
      expect((warm.body as { meta: { total: number } }).meta.total).toBe(1);

      await admin.agent
        .post(`${API_PREFIX}/admin/certificates/${certificateId}/revoke`)
        .send({ reason: 'test revoke' })
        .expect(201);

      const fresh = await request(server).get(`${API_PREFIX}/certificates/public`).expect(200);
      expect((fresh.body as { meta: { total: number } }).meta.total).toBe(0);
    });
  });
});
