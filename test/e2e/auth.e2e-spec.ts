import type { Server } from 'node:http';

import request from 'supertest';

import {
  API_PREFIX,
  buildRegisterPayload,
  createAuthenticatedUser,
  createE2EApp,
  getUserIdByEmail,
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
      .expect(202);
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
    await request(server).post(`${API_PREFIX}/auth/register`).send(payload).expect(202);
    const userId = await getUserIdByEmail(ctx.dataSource, payload.email);
    await setUserStatus(ctx.dataSource, userId, 'approved');

    const login = await request(server)
      .post(`${API_PREFIX}/auth/login`)
      .send({ email: payload.email, password: payload.password })
      .expect(200);

    expect(login.body).toMatchObject({ status: 'approved', userId });
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

  it('two concurrent refreshes with the same cookie: exactly one 200, one rotated refresh_token_id', async () => {
    const authenticated = await createAuthenticatedUser(ctx.app, ctx.dataSource);
    const cookie = cookiePair(authenticated.cookies, 'refresh_token');
    const idBefore = (
      (await ctx.dataSource.query('SELECT refresh_token_id FROM user_sessions WHERE user_id = $1', [
        authenticated.userId,
      ])) as Array<{ refresh_token_id: string }>
    )[0]?.refresh_token_id;

    const results = await Promise.all([
      request(server).post(`${API_PREFIX}/auth/refresh`).set('Cookie', cookie),
      request(server).post(`${API_PREFIX}/auth/refresh`).set('Cookie', cookie),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    const rows = (await ctx.dataSource.query(
      'SELECT refresh_token_id FROM user_sessions WHERE user_id = $1',
      [authenticated.userId],
    )) as Array<{ refresh_token_id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.refresh_token_id).not.toBe(idBefore);
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

  it('revoked session: a session deleted from another device is rejected on its next request', async () => {
    const first = await createAuthenticatedUser(ctx.app, ctx.dataSource);
    const secondAgent = request.agent(server);
    await secondAgent
      .post(`${API_PREFIX}/auth/login`)
      .send({ email: first.credentials.email, password: first.credentials.password })
      .expect(200);
    await first.agent.get(`${API_PREFIX}/users/me`).expect(200);

    const sessions = (await secondAgent.get(`${API_PREFIX}/users/me/sessions`).expect(200)).body
      .data as Array<{ id: string; is_current?: boolean; isCurrent?: boolean }>;
    expect(sessions.length).toBe(2);
    const firstSessionId = (
      (await ctx.dataSource.query(
        'SELECT id FROM user_sessions WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1',
        [first.userId],
      )) as Array<{ id: string }>
    )[0]?.id;
    await secondAgent.delete(`${API_PREFIX}/users/me/sessions/${firstSessionId}`).expect(200);

    await first.agent.get(`${API_PREFIX}/users/me`).expect(401);
    await secondAgent.get(`${API_PREFIX}/users/me`).expect(200);
  });

  it('expired session row is rejected even though the access cookie is still unexpired', async () => {
    const { agent, userId } = await createAuthenticatedUser(ctx.app, ctx.dataSource);
    await agent.get(`${API_PREFIX}/users/me`).expect(200);
    await ctx.dataSource.query(
      `UPDATE user_sessions SET expires_at = now() - interval '1 minute' WHERE user_id = $1`,
      [userId],
    );
    await agent.get(`${API_PREFIX}/users/me`).expect(401);
  });

  it('rejects invalid credentials', async () => {
    const payload = buildRegisterPayload();
    await request(server).post(`${API_PREFIX}/auth/register`).send(payload).expect(202);
    await setUserStatus(
      ctx.dataSource,
      await getUserIdByEmail(ctx.dataSource, payload.email),
      'approved',
    );
    await request(server)
      .post(`${API_PREFIX}/auth/login`)
      .send({ email: payload.email, password: 'WrongPassword123!' })
      .expect(401);
  });

  /**
   * End-to-end proof of the anti-enumeration contract, against a real database
   * and the full middleware stack. `register` used to answer a known email with
   * `409` and a new one with `201 { userId }`; an unauthenticated caller could
   * therefore test any address or phone number against the entire user table.
   */
  describe('registration does not leak whether an account exists', () => {
    it('answers an existing email, an existing phone, and a new identity identically', async () => {
      const sharedGuardian = '01011111111';
      const existing = buildRegisterPayload({ parentPhone: sharedGuardian });
      await request(server).post(`${API_PREFIX}/auth/register`).send(existing).expect(202);

      const fresh = await request(server)
        .post(`${API_PREFIX}/auth/register`)
        .send(buildRegisterPayload());
      const duplicateEmail = await request(server)
        .post(`${API_PREFIX}/auth/register`)
        .send(buildRegisterPayload({ email: existing.email }));
      const duplicatePhone = await request(server)
        .post(`${API_PREFIX}/auth/register`)
        .send(buildRegisterPayload({ phone: existing.phone }));
      const sharedParentPhone = await request(server)
        .post(`${API_PREFIX}/auth/register`)
        // An already-known guardian number is reused, never a conflict — this
        // asserts it stays indistinguishable from a first-time one.
        .send(buildRegisterPayload({ parentPhone: sharedGuardian }));
      const repeatedPending = await request(server)
        .post(`${API_PREFIX}/auth/register`)
        .send(existing);

      for (const response of [duplicateEmail, duplicatePhone, sharedParentPhone, repeatedPending]) {
        expect(response.status).toBe(202);
        expect(response.status).toBe(fresh.status);
        expect(response.body).toEqual(fresh.body);
        expect(Object.keys(response.body).sort()).toEqual(Object.keys(fresh.body).sort());
        expect(response.body).not.toHaveProperty('userId');
        expect(response.text).not.toContain('userId');
      }
      expect(fresh.body).toEqual({ message: 'Registration request received. Pending approval' });
    });

    it('does not create a duplicate account for an identifier that already exists', async () => {
      const existing = buildRegisterPayload();
      await request(server).post(`${API_PREFIX}/auth/register`).send(existing).expect(202);

      await request(server).post(`${API_PREFIX}/auth/register`).send(existing).expect(202);
      await request(server)
        .post(`${API_PREFIX}/auth/register`)
        .send(buildRegisterPayload({ email: existing.email }))
        .expect(202);

      const rows = (await ctx.dataSource.query('SELECT COUNT(*)::int AS count FROM users')) as {
        count: number;
      }[];
      expect(rows[0]?.count).toBe(1);
    });

    it('keeps a malformed payload a 400 — only existence conflicts are hidden', async () => {
      await request(server)
        .post(`${API_PREFIX}/auth/register`)
        .send(buildRegisterPayload({ email: 'not-an-email' }))
        .expect(400);
      await request(server)
        .post(`${API_PREFIX}/auth/register`)
        .send(buildRegisterPayload({ parentPhone: '01,12345678' }))
        .expect(400);
    });

    it('answers simultaneous requests for the same identity with the same 202', async () => {
      const payload = buildRegisterPayload();

      // Fired together so both pass the pre-insert existence check and one is
      // forced onto the database unique constraint.
      const responses = await Promise.all(
        Array.from({ length: 3 }, async () =>
          request(server).post(`${API_PREFIX}/auth/register`).send(payload),
        ),
      );

      for (const response of responses) {
        expect(response.status).toBe(202);
        expect(response.body).toEqual({
          message: 'Registration request received. Pending approval',
        });
      }

      const rows = (await ctx.dataSource.query('SELECT COUNT(*)::int AS count FROM users')) as {
        count: number;
      }[];
      expect(rows[0]?.count).toBe(1);
    });
  });
});
