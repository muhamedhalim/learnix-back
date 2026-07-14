import type { Server } from 'node:http';

import request from 'supertest';

import {
  API_PREFIX,
  buildRegisterPayload,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  setUserStatus,
  type E2EContext,
} from './fixtures';

function cookiePair(cookies: string[], name: string): string {
  const cookie = cookies.find((value) => value.startsWith(`${name}=`));
  if (cookie === undefined) throw new Error(`Missing ${name} cookie`);
  return cookie.split(';')[0] ?? cookie;
}

describe('HttpOnly cookie authentication (e2e)', () => {
  let ctx: E2EContext;
  let server: Server;

  beforeAll(async () => {
    ctx = await createE2EApp();
    server = ctx.app.getHttpServer() as Server;
  });

  beforeEach(async () => resetDatabase(ctx.dataSource));
  afterAll(async () => ctx.app.close());

  it('keeps pending registration and login responses free of credentials', async () => {
    const payload = buildRegisterPayload();
    const registration = await request(server)
      .post(`${API_PREFIX}/auth/register`)
      .send(payload)
      .expect(201);
    expect(registration.body).not.toHaveProperty('accessToken');
    expect(registration.body).not.toHaveProperty('refreshToken');

    const login = await request(server)
      .post(`${API_PREFIX}/auth/login`)
      .send({ email: payload.email, password: payload.password })
      .expect(200);
    expect(login.body.status).toBe('pending');
    expect(login.body).not.toHaveProperty('token');
  });

  it('sets both credentials as HttpOnly cookies and returns no token in JSON', async () => {
    const payload = buildRegisterPayload();
    const registration = await request(server)
      .post(`${API_PREFIX}/auth/register`)
      .send(payload)
      .expect(201);
    await setUserStatus(ctx.dataSource, registration.body.userId as string, 'approved');

    const login = await request(server)
      .post(`${API_PREFIX}/auth/login`)
      .send({ email: payload.email, password: payload.password })
      .expect(200);

    expect(login.body).toMatchObject({ status: 'approved', userId: registration.body.userId });
    expect(login.body).not.toHaveProperty('token');
    expect(login.body).not.toHaveProperty('accessToken');
    expect(login.body).not.toHaveProperty('refreshToken');

    const cookies = (login.headers['set-cookie'] as unknown as string[]) ?? [];
    const access = cookies.find((value) => value.startsWith('access_token='));
    const refresh = cookies.find((value) => value.startsWith('refresh_token='));
    expect(access).toMatch(/HttpOnly/i);
    expect(access).toMatch(/Path=\/api\/v1(?:;|$)/i);
    expect(access).toMatch(/SameSite=Lax/i);
    expect(refresh).toMatch(/HttpOnly/i);
    expect(refresh).toMatch(/Path=\/api\/v1\/auth(?:;|$)/i);
    expect(refresh).toMatch(/SameSite=Lax/i);
  });

  it('authenticates protected requests using cookies without Authorization', async () => {
    const { agent } = await createAuthenticatedUser(ctx.app, ctx.dataSource);
    await agent.get(`${API_PREFIX}/users/me`).expect(200);
  });

  it('rotates both cookies and rejects reuse of the previous refresh credential', async () => {
    const authenticated = await createAuthenticatedUser(ctx.app, ctx.dataSource);
    const oldRefresh = cookiePair(authenticated.cookies, 'refresh_token');

    const refreshed = await authenticated.agent.post(`${API_PREFIX}/auth/refresh`).expect(200);
    expect(refreshed.body).not.toHaveProperty('token');
    expect(refreshed.body).not.toHaveProperty('accessToken');
    expect(refreshed.body).not.toHaveProperty('refreshToken');

    const rotatedCookies = (refreshed.headers['set-cookie'] as unknown as string[]) ?? [];
    expect(cookiePair(rotatedCookies, 'refresh_token')).not.toBe(oldRefresh);
    expect(cookiePair(rotatedCookies, 'access_token')).toContain('access_token=');

    await request(server).post(`${API_PREFIX}/auth/refresh`).set('Cookie', oldRefresh).expect(401);
  });

  it('rejects missing and malformed refresh cookies and clears credentials', async () => {
    await request(server).post(`${API_PREFIX}/auth/refresh`).expect(401);
    const malformed = await request(server)
      .post(`${API_PREFIX}/auth/refresh`)
      .set('Cookie', 'refresh_token=not-a-valid-signed-cookie')
      .expect(401);
    const cookies = (malformed.headers['set-cookie'] as unknown as string[]) ?? [];
    expect(cookies.find((cookie) => cookie.startsWith('access_token='))).toMatch(
      /Expires=Thu, 01 Jan 1970 00:00:00 GMT/i,
    );
    expect(cookies.find((cookie) => cookie.startsWith('refresh_token='))).toMatch(
      /Expires=Thu, 01 Jan 1970 00:00:00 GMT/i,
    );
  });

  it('logout revokes the session, clears both cookies, and blocks subsequent use', async () => {
    const authenticated = await createAuthenticatedUser(ctx.app, ctx.dataSource);
    const oldRefresh = cookiePair(authenticated.cookies, 'refresh_token');

    const logout = await authenticated.agent.post(`${API_PREFIX}/auth/logout`).expect(200);
    const cleared = (logout.headers['set-cookie'] as unknown as string[]) ?? [];
    expect(cleared.find((cookie) => cookie.startsWith('access_token='))).toMatch(
      /Expires=Thu, 01 Jan 1970 00:00:00 GMT/i,
    );
    expect(cleared.find((cookie) => cookie.startsWith('refresh_token='))).toMatch(
      /Expires=Thu, 01 Jan 1970 00:00:00 GMT/i,
    );

    await authenticated.agent.get(`${API_PREFIX}/users/me`).expect(401);
    await request(server).post(`${API_PREFIX}/auth/refresh`).set('Cookie', oldRefresh).expect(401);
  });

  it('rejects invalid credentials', async () => {
    const payload = buildRegisterPayload();
    const registration = await request(server)
      .post(`${API_PREFIX}/auth/register`)
      .send(payload)
      .expect(201);
    await setUserStatus(ctx.dataSource, registration.body.userId as string, 'approved');
    await request(server)
      .post(`${API_PREFIX}/auth/login`)
      .send({ email: payload.email, password: 'WrongPassword123!' })
      .expect(401);
  });
});
