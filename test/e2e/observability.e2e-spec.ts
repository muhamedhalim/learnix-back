import type { Server } from 'node:http';

import request from 'supertest';

import { API_PREFIX, createE2EApp, type E2EContext } from './fixtures';

/**
 * Observability endpoints:
 *   - the health check is reachable and reports status
 *   - the Prometheus /metrics endpoint is protected (never anonymous)
 */
describe('Observability (e2e)', () => {
  let ctx: E2EContext;
  let server: Server;

  beforeAll(async () => {
    ctx = await createE2EApp();
    server = ctx.app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('exposes a health check', async () => {
    const res = await request(server).get(`${API_PREFIX}/health`).expect(200);
    expect(res.body).toHaveProperty('status');
  });

  it('protects the /metrics endpoint from anonymous access', async () => {
    // /metrics requires a bearer token: 401 when a token is configured but not
    // supplied, or 503 when the endpoint is disabled (no METRICS_BEARER_TOKEN).
    // Either way it must never serve metrics anonymously (200).
    const res = await request(server).get('/metrics');
    expect([401, 403, 503]).toContain(res.status);
  });
});
