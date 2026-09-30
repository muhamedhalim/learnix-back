import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';

import request from 'supertest';
import type { DataSource } from 'typeorm';

import { API_PREFIX, createAuthenticatedUser, createE2EApp, resetDatabase } from './fixtures';

/**
 * Spec 004 Wave 1 (T042, Step 0): app-wide `Cache-Control: private, no-store`
 * default (`DefaultNoStoreMiddleware`, registered in `AppModule`), decided by
 * T010 (Muhamed Halim, 2026-09-23: no CDN, default branch only). Every
 * response outside `marketplace/*` carries it unless the route sets its own
 * (the ~9 pre-existing handlers already using the same exact value).
 * `marketplace/*` is untouched by this default — see
 * `marketplace-catalog-cache.e2e-spec.ts` / `marketplace-file-access.e2e-spec.ts`
 * / `call-center-phase2.e2e-spec.ts` for that namespace's own, unmodified
 * header contract.
 */
describe('app-wide default Cache-Control header (spec 004 T042 Step 0)', () => {
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

  it('an authenticated academic route carries the app-wide private, no-store default', async () => {
    const student = await createAuthenticatedUser(app, dataSource, { role: 'student' });

    const res = await student.agent.get(`${API_PREFIX}/users/me`).expect(200);

    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('a public, unauthenticated academic route also carries the default (no CDN branch: nothing opts out)', async () => {
    const res = await request(server).get(`${API_PREFIX}/subjects`).expect(200);

    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('marketplace/* is untouched by the app-wide default: its own middleware still governs it', async () => {
    const res = await request(server).get(`${API_PREFIX}/marketplace/courses`).expect(200);

    // Proven in depth by `marketplace-file-access.e2e-spec.ts`; this is a
    // narrow guard that Step 0 did not silently start overriding it.
    expect(res.headers['cache-control']).not.toBe('private, no-store');
  });

  it('a finance route (GET admin/finance/orders) carries private, no-store and never a public/s-maxage directive', async () => {
    const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });

    const res = await admin.agent.get(`${API_PREFIX}/admin/finance/orders`);

    // The header is set by middleware before the guard runs, so it is asserted
    // whatever the finance permission outcome is for this fixture admin.
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['cache-control']).not.toMatch(/public|s-maxage/);
  });
});
