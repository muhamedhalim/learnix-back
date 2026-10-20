import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import request from 'supertest';

import { UploadedFile } from '../../src/uploads/entities/uploaded-file.entity';
import { User } from '../../src/users/entities';
import { API_PREFIX, createAuthenticatedUser, createE2EApp, resetDatabase } from './fixtures';

/**
 * API audit regression — file listing / usage SQL must run against the migrated schema.
 *
 * `FILE_USAGE_SELECT` (file-management.service.ts) is one correlated SQL projection
 * shared by `GET /uploads/teacher/files`, `GET /uploads/admin/files`,
 * `GET /uploads/files/:id/usage` and the in-use check of `DELETE /uploads/files/:id`.
 * It still selected `lessons.video_url` after RetireBunnyVideo dropped that column, so
 * every one of those routes answered 500 ("column lesson.video_url does not exist")
 * on any migrated database, regardless of data. Unit tests never saw it because they
 * mock the repository.
 */
describe('uploaded-file usage projection (API audit)', () => {
  let app: INestApplication;
  let server: Server;
  let dataSource: DataSource;

  beforeAll(async () => {
    ({ app, dataSource } = await createE2EApp());
    server = app.getHttpServer() as Server;
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  async function seedFile(uploaderId: string, filename: string) {
    return dataSource.getRepository(UploadedFile).save(
      dataSource.getRepository(UploadedFile).create({
        filename,
        original_filename: 'avatar-original.png',
        folder: 'profiles',
        mime_type: 'image/png',
        size: 1234,
        uploader_id: uploaderId,
      }),
    );
  }

  it('lists the uploader\'s files with their real usage, and an unused file has no references', async () => {
    const teacher = await createAuthenticatedUser(app, dataSource, { role: 'teacher' });
    const used = await seedFile(teacher.userId, 'used-avatar-aaaa.png');
    const unused = await seedFile(teacher.userId, 'unused-bbbb.png');
    await dataSource
      .getRepository(User)
      .update({ id: teacher.userId }, { profile_picture_url: `/api/v1/media/public/profiles/${used.filename}` });

    const res = await teacher.agent.get(`${API_PREFIX}/uploads/teacher/files`).expect(200);

    expect(res.body.meta.total).toBe(2);
    const byName = new Map<string, { usedIn: Array<{ entityType: string; entityId: string; field: string }> }>(
      res.body.data.map((f: { filename: string; usedIn: never[] }) => [f.filename, f]),
    );
    expect(byName.get(unused.filename)?.usedIn).toEqual([]);
    expect(byName.get(used.filename)?.usedIn).toEqual([
      expect.objectContaining({ entityType: 'user', entityId: teacher.userId, field: 'profile_picture_url' }),
    ]);
  });

  it('serves the single-file usage route to the uploader and hides it from other users', async () => {
    const owner = await createAuthenticatedUser(app, dataSource, { role: 'teacher' });
    const other = await createAuthenticatedUser(app, dataSource, { role: 'teacher' });
    const file = await seedFile(owner.userId, 'owned-cccc.png');

    const mine = await owner.agent.get(`${API_PREFIX}/uploads/files/${file.id}/usage`).expect(200);
    expect(mine.body.data.id).toBe(file.id);
    expect(mine.body.data.usedIn).toEqual([]);

    await other.agent.get(`${API_PREFIX}/uploads/files/${file.id}/usage`).expect(404);
    await request(server).get(`${API_PREFIX}/uploads/files/${file.id}/usage`).expect(401);
  });
});
