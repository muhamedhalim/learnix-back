import { readdirSync, rmSync, rmdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import request from 'supertest';

import { MarketplaceCategory } from '../../src/marketplace/catalog/entities';
import { MarketplaceInstructor } from '../../src/marketplace/instructors/entities/marketplace-instructor.entity';
import { buildInstructorFixture } from './factories/marketplace.factory';
import { API_PREFIX, createAuthenticatedUser, createE2EApp, resetDatabase, setUserRole } from './fixtures';

/**
 * MP-10 (D3): course covers and instructor/applicant photos are uploaded through marketplace routes,
 * stored as public images under `images/marketplace/<uploader>/`, served by the existing public-media
 * route, and accepted on a course or profile only as a key those routes issued.
 */
describe('marketplace image uploads (MP-10)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  // Local storage writes real files. Remember what was there before this spec ran and remove only what
  // it added, so a developer's own uploads in the same folder are never touched.
  const uploadRoot = join(process.cwd(), process.env['UPLOAD_DIR'] ?? 'uploads', 'images', 'marketplace');
  const listFiles = (): Set<string> => {
    try {
      return new Set(
        (readdirSync(uploadRoot, { recursive: true }) as string[]).filter((entry) =>
          statSync(join(uploadRoot, entry)).isFile(),
        ),
      );
    } catch {
      return new Set();
    }
  };
  let filesBefore: Set<string>;

  beforeAll(async () => {
    filesBefore = listFiles();
    ({ app, dataSource } = await createE2EApp());
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  afterAll(async () => {
    await app.close();
    for (const entry of listFiles()) {
      if (!filesBefore.has(entry)) rmSync(join(uploadRoot, entry), { force: true });
    }
    // Drop the per-uploader folders this spec emptied (a non-empty folder is left alone).
    try {
      for (const entry of readdirSync(uploadRoot)) {
        try {
          rmdirSync(join(uploadRoot, entry));
        } catch {
          /* not empty: someone else's uploads */
        }
      }
      rmdirSync(uploadRoot);
    } catch {
      /* already gone, or not empty */
    }
  });

  // A real 1x1 PNG.
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  const attachPng = (req: request.Test, name = 'cover.png', type = 'image/png', body: Buffer = PNG) =>
    req.attach('file', body, { filename: name, contentType: type });

  const KEY_SHAPE = /^images\/marketplace\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.png$/;

  async function seedInstructor() {
    const user = await createAuthenticatedUser(app, dataSource);
    const instructor = await dataSource
      .getRepository(MarketplaceInstructor)
      .save(buildInstructorFixture({ user_id: user.userId }));
    return { ...user, instructorId: instructor.id };
  }

  describe('instructor upload route', () => {
    const route = `${API_PREFIX}/marketplace/instructor/uploads/image`;

    it('stores a valid image and the public-media route serves it back to anyone', async () => {
      const instructor = await seedInstructor();
      const res = await attachPng(instructor.agent.post(route)).expect(201);
      expect(res.body.key).toMatch(KEY_SHAPE);
      expect(res.body.key).toContain(`/${instructor.userId}/`);
      expect(res.body.url).toBeUndefined();

      // Anonymous visitors load it through the existing public-media proxy.
      const served = await request(app.getHttpServer()).get(`${API_PREFIX}/media/public/${res.body.key}`).expect(200);
      expect(served.headers['content-type']).toContain('image/png');
      expect(Buffer.compare(served.body as Buffer, PNG)).toBe(0);
    });

    it('is closed to anyone who is not an approved instructor, signed in or not', async () => {
      const learner = await createAuthenticatedUser(app, dataSource);
      await attachPng(learner.agent.post(route)).expect(403);
      await attachPng(request(app.getHttpServer()).post(route)).expect(401);
    });

    it('refuses a missing file, a type that is not allowed, and content that is not an image', async () => {
      const instructor = await seedInstructor();
      await instructor.agent.post(route).expect(400);
      await attachPng(instructor.agent.post(route), 'a.gif', 'image/gif').expect(400);
      await attachPng(instructor.agent.post(route), 'a.pdf', 'application/pdf').expect(400);
      // Declared as a JPEG, but it is a script.
      await attachPng(instructor.agent.post(route), 'a.jpg', 'image/jpeg', Buffer.from('<script>alert(1)</script>')).expect(400);
      // The extension does not match the declared type.
      await attachPng(instructor.agent.post(route), 'a.jpg', 'image/png').expect(400);
    });

    it('refuses an image over 5 MB without storing it', async () => {
      const instructor = await seedInstructor();
      const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
      await attachPng(instructor.agent.post(route), 'big.png', 'image/png', big).expect(413);
    });
  });

  describe('applicant photo route', () => {
    it('lets any signed-in applicant upload a photo, and nobody else', async () => {
      const learner = await createAuthenticatedUser(app, dataSource);
      const res = await attachPng(learner.agent.post(`${API_PREFIX}/marketplace/applications/me/photo`), 'me.png').expect(201);
      expect(res.body.key).toMatch(KEY_SHAPE);
      await attachPng(request(app.getHttpServer()).post(`${API_PREFIX}/marketplace/applications/me/photo`)).expect(401);
    });

    it('takes the uploaded key as the application photo, and refuses a URL in its place', async () => {
      const learner = await createAuthenticatedUser(app, dataSource);
      await learner.agent.post(`${API_PREFIX}/marketplace/applications`).send({ display_name: 'Nour' }).expect(201);
      const { body } = await attachPng(learner.agent.post(`${API_PREFIX}/marketplace/applications/me/photo`), 'me.png').expect(201);

      const refused = await learner.agent
        .patch(`${API_PREFIX}/marketplace/applications/me`)
        .send({ photo_key: 'https://tracker.example/pixel.gif' })
        .expect(400);
      expect(refused.body.code).toBe('INVALID_IMAGE_REFERENCE');

      const ok = await learner.agent
        .patch(`${API_PREFIX}/marketplace/applications/me`)
        .send({ photo_key: body.key })
        .expect(200);
      expect(ok.body.photo_key).toBe(body.key);
    });
  });

  describe('keys on courses and profiles', () => {
    async function setup() {
      const instructor = await seedInstructor();
      const category = await dataSource.getRepository(MarketplaceCategory).save({
        name_en: 'Programming',
        name_ar: 'البرمجة',
        slug: `programming-${Date.now()}`,
        display_order: 1,
      });
      const body = (cover: string) => ({
        title: 'Backend Engineering 101',
        summary: 'Learn to build backend systems',
        description: 'A full description of the course content.',
        category_id: category.id,
        level: 'beginner',
        language: 'en',
        price_minor: 10_000,
        currency: 'EGP',
        cover_image_key: cover,
      });
      return { instructor, body };
    }

    it('creates a course only with an uploaded cover, never with a URL or a made-up path', async () => {
      const { instructor, body } = await setup();
      const base = `${API_PREFIX}/marketplace/instructor/courses`;
      const upload = await attachPng(instructor.agent.post(`${API_PREFIX}/marketplace/instructor/uploads/image`)).expect(201);

      for (const bad of ['https://tracker.example/pixel.gif', '//evil.example/x.png', 'covers/mine.jpg', 'images/teacher-1/x.png']) {
        const res = await instructor.agent.post(base).send(body(bad)).expect(400);
        expect(res.body.code).toBe('INVALID_IMAGE_REFERENCE');
      }
      const created = await instructor.agent.post(base).send(body(upload.body.key)).expect(201);
      expect(created.body.cover_image_key).toBe(upload.body.key);

      // Replacing it needs another uploaded key; keeping it as it is always works.
      const id = created.body.id as string;
      await instructor.agent.patch(`${base}/${id}`).send({ cover_image_key: 'https://tracker.example/pixel.gif' }).expect(400);
      await instructor.agent.patch(`${base}/${id}`).send({ cover_image_key: upload.body.key, title: 'Retitled' }).expect(200);
      const second = await attachPng(instructor.agent.post(`${API_PREFIX}/marketplace/instructor/uploads/image`)).expect(201);
      const replaced = await instructor.agent.patch(`${base}/${id}`).send({ cover_image_key: second.body.key }).expect(200);
      expect(replaced.body.cover_image_key).toBe(second.body.key);
    });

    it('queues a new profile photo for review only when it is an uploaded key', async () => {
      const { instructor } = await setup();
      const profile = `${API_PREFIX}/marketplace/instructor/profile`;
      await instructor.agent.patch(profile).send({ photo_key: 'https://tracker.example/p.gif' }).expect(400);

      const upload = await attachPng(instructor.agent.post(`${API_PREFIX}/marketplace/instructor/uploads/image`)).expect(201);
      const res = await instructor.agent.patch(profile).send({ photo_key: upload.body.key }).expect(200);
      expect(res.body.pending_profile_changes).toEqual([
        expect.objectContaining({ field: 'photo_key', proposed_value: upload.body.key }),
      ]);
      // Saving the same form again is not an error and queues nothing new.
      await instructor.agent.patch(profile).send({ photo_key: upload.body.key }).expect(200);
    });
  });

  describe('public applicants (no account, so no way to upload)', () => {
    const application = {
      applicant_email: 'public.applicant@example.com',
      applicant_phone: '01012345678',
      display_name: 'Layla Hassan',
      headline: 'Data Engineer',
      bio: 'Eight years building data platforms.',
      years_of_experience: 8,
      specializations: ['Data Engineering'],
      intended_category_ids: ['11111111-1111-4111-8111-111111111111'],
      professional_links: [{ kind: 'linkedin', url: 'https://www.linkedin.com/in/example' }],
    };

    it('may apply without a photo, which is added from the profile after approval', async () => {
      await request(app.getHttpServer()).post(`${API_PREFIX}/marketplace/applications/public`).send(application).expect(201);

      const admin = await createAuthenticatedUser(app, dataSource);
      await setUserRole(dataSource, admin.userId, 'admin');
      const queue = await admin.agent.get(`${API_PREFIX}/marketplace/admin/applications`).expect(200);
      expect(queue.body.items).toHaveLength(1);
      expect(queue.body.items[0].photo_key).toBeNull();
    });

    it('cannot use a URL as the photo either', async () => {
      const res = await request(app.getHttpServer())
        .post(`${API_PREFIX}/marketplace/applications/public`)
        .send({ ...application, photo_key: 'https://tracker.example/p.gif' })
        .expect(400);
      expect(res.body.code).toBe('INVALID_IMAGE_REFERENCE');
    });

    it('still requires the photo from a signed-in applicant (FR-011)', async () => {
      const learner = await createAuthenticatedUser(app, dataSource);
      await learner.agent.post(`${API_PREFIX}/marketplace/applications`).send({ display_name: 'Nour' }).expect(201);
      await learner.agent
        .patch(`${API_PREFIX}/marketplace/applications/me`)
        .send({
          headline: 'Engineer',
          bio: 'Bio',
          years_of_experience: 5,
          specializations: ['Backend'],
          intended_category_ids: ['11111111-1111-4111-8111-111111111111'],
          professional_links: [{ kind: 'linkedin', url: 'https://www.linkedin.com/in/example' }],
        })
        .expect(200);
      const res = await learner.agent.post(`${API_PREFIX}/marketplace/applications/me/submit`).send({}).expect(422);
      expect(res.body.details).toContain('photo_key');
    });
  });
});
