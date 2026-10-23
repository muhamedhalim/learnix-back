import { Readable } from 'node:stream';

import request from 'supertest';

import { StorageObjectNotFoundError } from '../../src/storage/storage.interface';
import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  type E2EContext,
} from './fixtures';

jest.setTimeout(120_000);

/** 1x1 transparent PNG: real magic bytes, so the signature check passes. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

interface Stored {
  buffer: Buffer;
  contentType: string;
  visibility: string;
}

/**
 * Uploads and the public media proxy over HTTP (Phase 4; was 0% e2e reach).
 * TC-UPL-01 type/signature validation, TC-UPL-05 path traversal, and the round trip that
 * proves a freshly uploaded image URL actually serves (the per-teacher key layout from F-03).
 */
describe('teacher uploads and public media (e2e)', () => {
  let ctx: E2EContext;
  const objects = new Map<string, Stored>();

  beforeAll(async () => {
    ctx = await createE2EApp({
      storageService: {
        upload: jest.fn(
          (input: { buffer: Buffer; path: string; contentType: string; visibility: string }) => {
            objects.set(input.path, {
              buffer: input.buffer,
              contentType: input.contentType,
              visibility: input.visibility,
            });
            return Promise.resolve({ path: input.path, size: input.buffer.length });
          },
        ),
        getObject: jest.fn((key: string) => {
          const stored = objects.get(key);
          if (!stored) return Promise.reject(new StorageObjectNotFoundError(key));
          return Promise.resolve({
            stream: Readable.from(stored.buffer),
            contentType: stored.contentType,
            contentLength: stored.buffer.length,
          });
        }),
      } as never,
    });
  });
  beforeEach(async () => {
    objects.clear();
    await resetDatabase(ctx.dataSource);
  });
  afterAll(async () => ctx.app.close());

  it('stores an image under the uploader folder and serves it back through its public URL', async () => {
    const teacher = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'teacher' });
    const res = await teacher.agent
      .post(`${API_PREFIX}/teacher/uploads/image`)
      .attach('file', PNG, { filename: 'cover.png', contentType: 'image/png' })
      .expect(201);

    const { url, key } = res.body as { url: string; key: string };
    expect(key.startsWith(`images/${teacher.userId}/`)).toBe(true);
    expect(objects.get(key)?.visibility).toBe('public');

    const served = await request(ctx.app.getHttpServer()).get(new URL(url).pathname);
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toContain('image/png');
    expect(Buffer.compare(served.body as Buffer, PNG)).toBe(0);
  });

  it('rejects an SVG, an HTML file renamed to .png, and a missing file', async () => {
    const teacher = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'teacher' });
    const upload = () => teacher.agent.post(`${API_PREFIX}/teacher/uploads/image`);

    await upload()
      .attach('file', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), {
        filename: 'x.svg',
        contentType: 'image/svg+xml',
      })
      .expect(400);
    await upload()
      .attach('file', Buffer.from('<html><script>alert(1)</script></html>'), {
        filename: 'evil.png',
        contentType: 'image/png',
      })
      .expect(400);
    await upload().expect(400);
    expect(objects.size).toBe(0);
  });

  it('keeps lesson resources private and returns an opaque reference, not a URL', async () => {
    const teacher = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'teacher' });
    const res = await teacher.agent
      .post(`${API_PREFIX}/teacher/uploads/file`)
      .attach('file', Buffer.from('%PDF-1.4\n%test\n'), {
        filename: 'notes.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);
    const body = res.body as { upload_ref: string; type: string };
    expect(body.upload_ref.startsWith(`lesson-resources/${teacher.userId}/`)).toBe(true);
    expect(body).not.toHaveProperty('url');
    expect(objects.get(body.upload_ref)?.visibility).toBe('private');

    // Private folders are not reachable through the public proxy, whatever the key.
    await request(ctx.app.getHttpServer())
      .get(`${API_PREFIX}/media/public/lesson-resources/${teacher.userId}/x.pdf`)
      .expect(404);
  });

  it('refuses uploads from students and anonymous callers', async () => {
    const student = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'student' });
    await student.agent
      .post(`${API_PREFIX}/teacher/uploads/image`)
      .attach('file', PNG, { filename: 'a.png', contentType: 'image/png' })
      .expect(403);
    await request(ctx.app.getHttpServer())
      .post(`${API_PREFIX}/teacher/uploads/image`)
      .attach('file', PNG, { filename: 'a.png', contentType: 'image/png' })
      .expect(401);
  });

  it.each([
    'images/..%2f..%2fetc%2fpasswd',
    'images/%2e%2e/secret',
    'images/a%5cb.png',
    'books/anything.pdf',
    'images/nested/%2e%2e/%2e%2e/books/x.pdf',
  ])('does not serve %s through the public media proxy', async (path) => {
    objects.set('books/anything.pdf', { buffer: PNG, contentType: 'application/pdf', visibility: 'private' });
    const res = await request(ctx.app.getHttpServer()).get(`${API_PREFIX}/media/public/${path}`);
    expect([400, 404]).toContain(res.status);
  });
});
