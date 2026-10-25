import type { Server } from 'node:http';
import { brotliCompressSync, gzipSync } from 'node:zlib';

import type { INestApplication } from '@nestjs/common';

import request from 'supertest';

import { API_PREFIX, createE2EApp } from './fixtures';

/**
 * CVE-2026-111497 (Node.js Brotli decoder out-of-bounds write) was reachable before authentication: Express 5's
 * body parser brotli-decodes any request body sent with `Content-Encoding: br`. `rejectBrotliRequestBodies`
 * (registered in main.ts and mirrored by the app factory) refuses those bodies before parsing, on every route.
 * The patched runtime (Node.js 24.22.1) fixes the decoder itself; this spec covers the application defence.
 */
describe('brotli request bodies are refused before body parsing', () => {
  let app: INestApplication;
  let server: Server;
  const body = JSON.stringify({ email: 'nobody@example.com', password: 'not-a-real-password' });

  beforeAll(async () => {
    const ctx = await createE2EApp();
    app = ctx.app;
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => app.close());

  function postLogin(encoding: string | undefined, payload: Buffer | string) {
    const req = request(server)
      .post(`${API_PREFIX}/auth/login`)
      .set('Content-Type', 'application/json')
      .serialize((data: unknown) => data as string);
    if (encoding !== undefined) req.set('Content-Encoding', encoding);
    return req.send(payload as unknown as string);
  }

  it('an unauthenticated POST with Content-Encoding: br gets 415 and is never parsed', async () => {
    const res = await postLogin('br', brotliCompressSync(body));

    expect(res.status).toBe(415);
    expect(res.body).toMatchObject({ code: 'UNSUPPORTED_CONTENT_ENCODING' });
  });

  it('a malformed brotli stream is refused the same way', async () => {
    const res = await postLogin('br', Buffer.from([0xff, 0xff, 0xff, 0xff, 0x00, 0x13, 0x37]));

    expect(res.status).toBe(415);
  });

  it('identity and gzip bodies still reach the handler (bad credentials, not 415)', async () => {
    const identity = await postLogin(undefined, body);
    const gzip = await postLogin('gzip', gzipSync(body));

    expect(identity.status).not.toBe(415);
    expect(gzip.status).toBe(identity.status);
  });
});
