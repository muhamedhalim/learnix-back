import type { Server } from 'node:http';

import request from 'supertest';

import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  type E2EContext,
} from './fixtures';

/**
 * Regression coverage for the student lesson-progress routes' registration
 * order. `GET /student/lessons/my/progress` is a static path that must be
 * matched before the dynamic `GET /student/lessons/:lessonId/progress` route
 * — otherwise NestJS/Express treat "my" as `:lessonId` and `ParseUUIDPipe`
 * rejects it with 400 before the controller method ever runs.
 */
describe('Student lesson progress routing (e2e)', () => {
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

  it('GET /student/lessons/my/progress does not get captured by the :lessonId route', async () => {
    const { agent } = await createAuthenticatedUser(ctx.app, ctx.dataSource, {
      role: 'student',
    });

    const res = await agent.get(`${API_PREFIX}/student/lessons/my/progress`).expect(200);

    expect(res.body).toEqual({ data: [] });
  });

  it('GET /student/lessons/:lessonId/progress still validates the id as a UUID', async () => {
    const { agent } = await createAuthenticatedUser(ctx.app, ctx.dataSource, {
      role: 'student',
    });

    await agent.get(`${API_PREFIX}/student/lessons/not-a-uuid/progress`).expect(400);
  });
});
