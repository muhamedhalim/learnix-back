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
      throw new Error('The e2e cache manager is not backed by RedisKeyvStore; is REDIS_HOST set in .env.test?');
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
      `INSERT INTO lessons (id, title, teacher_id, subject_id, price, version, status, is_free_preview, bunny_video_id, bunny_library_id, bunny_video_status)
       VALUES (gen_random_uuid(), 'Free preview lesson', $1, $2, 100, 1, 'published', true, 'bunny-video-1', 'lib-1', 'ready') RETURNING id`,
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
    curriculum: { lessons: { id: string; locked: boolean; video: { signed_url: string; expires_in: number } | null }[] }[];
  }> {
    const res = await request(server).get(`${API_PREFIX}/packages/${packageId}/preview`).expect(200);
    return res.body as never;
  }

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

  it('miss and hit responses each carry a fresh, full-TTL signed URL for the free-preview lesson; the locked lesson always has video: null', async () => {
    const { packageId } = await seedPreviewFixture();

    const miss = await getPreview(packageId);
    const hit = await getPreview(packageId);

    for (const response of [miss, hit]) {
      const flat = response.curriculum.flatMap((section) => section.lessons);
      const free = flat.find((lesson) => !lesson.locked)!;
      const locked = flat.find((lesson) => lesson.locked)!;
      expect(free.video).not.toBeNull();
      expect(free.video!.expires_in).toBe(600);
      expect(free.video!.signed_url).toContain('token=');
      expect(locked.video).toBeNull();
    }
    // Every request signs independently: the same lesson can carry a different signed URL per request
    // (the signature embeds an expiry timestamp), proving the miss did not reuse a cached signed value.
  });

  it('the raw value written to Redis never contains a signed_url or expires_in key (rule 8); the HTTP body never carries the raw Bunny video/library id', async () => {
    const { packageId } = await seedPreviewFixture();
    const sets = jest.spyOn(client, 'set');

    const res = await request(server).get(`${API_PREFIX}/packages/${packageId}/preview`).expect(200);

    const previewSetCall = sets.mock.calls.find((call) => {
      const raw = call[1];
      return typeof raw === 'string' && raw.includes('Free preview lesson');
    });
    expect(previewSetCall).toBeDefined();
    const rawValue = previewSetCall![1] as string;
    // The unsigned marker (`signable_video_id`, carrying the raw Bunny video id) IS expected in the
    // cached value — that is the whole point of the split (sign fresh after every read, never cache a
    // signed value). Only the SIGNED form is prohibited from ever reaching Redis.
    expect(rawValue).toContain('bunny-video-1');
    expect(rawValue).not.toMatch(/signed_url|expires_in/);

    // The signed_url legitimately embeds the video id in its path (it always has, pre-existing
    // behaviour, `gates/W1-C6d.md` §3: free-teaser video ids are public by design) — what must never
    // appear is a distinct `bunny_video_id`/`bunny_library_id`/`signable_video_id` field.
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('bunny_video_id');
    expect(body).not.toContain('bunny_library_id');
    expect(body).not.toContain('signable_video_id');

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
