import type { Server } from 'node:http';

import * as jwt from 'jsonwebtoken';
import { sign as signCookie } from 'cookie-signature';
import request from 'supertest';

import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  setUserRole,
  setUserStatus,
  type E2EContext,
} from './fixtures';
import { StatementCounter } from './helpers/statement-counter';

/**
 * W2-C1 / W2-C2: principal lookup is ONE statement and every revocation is
 * effective on the next request.
 *
 * Named measurement routes (handlers verified not to read `user_sessions`/`users`):
 *   - JwtAuthGuard:      GET /marketplace/me/orders        (order.service `find` by learner_id)
 *   - HybridAuthGuard:   GET /notifications/push/devices   (push-device.service `find` by user_id)
 * Never measure on /users/me/sessions.
 *
 * Counted as the baseline method defines it: statements referencing
 * `user_sessions` or `users` over the whole request, isolated by X-Request-Id.
 */
describe('Principal lookup (e2e, postgres)', () => {
  let ctx: E2EContext;
  let server: Server;
  let counter: StatementCounter;

  const JWT_ROUTE = `${API_PREFIX}/marketplace/me/orders`;
  const HYBRID_ROUTE = `${API_PREFIX}/notifications/push/devices`;

  beforeAll(async () => {
    ctx = await createE2EApp();
    server = ctx.app.getHttpServer() as Server;
    counter = new StatementCounter(ctx.dataSource);
  });
  beforeEach(async () => resetDatabase(ctx.dataSource));
  afterAll(async () => ctx.app.close());

  async function measure(
    agent: ReturnType<typeof request.agent>,
    url: string,
    id: string,
  ): Promise<number> {
    counter.start();
    await agent.get(url).set('X-Request-Id', id).expect(200);
    counter.stop();
    return (
      counter.count({ requestId: id, table: 'user_sessions' }) +
      counter.count({ requestId: id, table: 'users' }) -
      // a statement joining both tables is one statement, counted once
      counter
        .statements({ requestId: id, table: 'user_sessions' })
        .filter((s) => counter.statements({ requestId: id, table: 'users' }).includes(s)).length
    );
  }

  it('authenticates a Jwt-guarded route with exactly one user_sessions/users statement', async () => {
    const { agent } = await createAuthenticatedUser(ctx.app, ctx.dataSource);
    await agent.get(JWT_ROUTE).expect(200); // warm
    expect(await measure(agent, JWT_ROUTE, 'probe-jwt')).toBe(1);
  });

  it('authenticates a Hybrid-guarded route with exactly one user_sessions/users statement', async () => {
    const { agent } = await createAuthenticatedUser(ctx.app, ctx.dataSource);
    await agent.get(HYBRID_ROUTE).expect(200); // warm
    expect(await measure(agent, HYBRID_ROUTE, 'probe-hybrid')).toBe(1);
  });

  describe('tokens missing session claims fail closed', () => {
    function forgedCookie(claims: Record<string, unknown>): string {
      const token = jwt.sign(claims, process.env['JWT_SECRET'] as string, { expiresIn: '5m' });
      const secret = (process.env['COOKIE_SECRET'] ?? process.env['JWT_SECRET']) as string;
      return `access_token=${encodeURIComponent(`s:${signCookie(token, secret)}`)}`;
    }

    it('positive control: the same forging method with all claims is accepted (200)', async () => {
      const { userId, credentials } = await createAuthenticatedUser(ctx.app, ctx.dataSource);
      const [{ id: sid }] = (await ctx.dataSource.query(
        'SELECT id FROM user_sessions WHERE user_id = $1',
        [userId],
      )) as Array<{ id: string }>;
      const cookie = forgedCookie({ sub: userId, email: credentials.email.toLowerCase(), sid });
      await request(server).get(JWT_ROUTE).set('Cookie', cookie).expect(200);
      await request(server).get(HYBRID_ROUTE).set('Cookie', cookie).expect(200);
    });

    it.each([
      ['sid', (u: string, email: string) => ({ sub: u, email })],
      ['sub', (_u: string, email: string) => ({ email, sid: 'whatever' })],
    ])('token without %s -> 401 on both guards', async (_claim, claims) => {
      const { userId, credentials } = await createAuthenticatedUser(ctx.app, ctx.dataSource);
      const cookie = forgedCookie(claims(userId, credentials.email.toLowerCase()));
      await request(server).get(JWT_ROUTE).set('Cookie', cookie).expect(401);
      await request(server).get(HYBRID_ROUTE).set('Cookie', cookie).expect(401);
    });
  });

  describe('revocation is effective on the next request', () => {
    it('is_active=false', async () => {
      const { agent, userId } = await createAuthenticatedUser(ctx.app, ctx.dataSource);
      await agent.get(JWT_ROUTE).expect(200);
      await ctx.dataSource.query('UPDATE users SET is_active = false WHERE id = $1', [userId]);
      await agent.get(JWT_ROUTE).expect(401);
    });

    it.each(['rejected', 'pending'])('status=%s', async (status) => {
      const { agent, userId } = await createAuthenticatedUser(ctx.app, ctx.dataSource);
      await agent.get(JWT_ROUTE).expect(200);
      await setUserStatus(ctx.dataSource, userId, status);
      await agent.get(JWT_ROUTE).expect(401);
    });

    it('soft-deleted user', async () => {
      const { agent, userId } = await createAuthenticatedUser(ctx.app, ctx.dataSource);
      await agent.get(JWT_ROUTE).expect(200);
      await ctx.dataSource.query('UPDATE users SET deleted_at = now() WHERE id = $1', [userId]);
      await agent.get(JWT_ROUTE).expect(401);
    });

    it('email changed after token issue', async () => {
      const { agent, userId } = await createAuthenticatedUser(ctx.app, ctx.dataSource);
      await agent.get(JWT_ROUTE).expect(200);
      await ctx.dataSource.query('UPDATE users SET email = $1 WHERE id = $2', [
        'changed-after-issue@example.com',
        userId,
      ]);
      await agent.get(JWT_ROUTE).expect(401);
    });

    it('session expired', async () => {
      const { agent, userId } = await createAuthenticatedUser(ctx.app, ctx.dataSource);
      await agent.get(JWT_ROUTE).expect(200);
      await ctx.dataSource.query(
        `UPDATE user_sessions SET expires_at = now() - interval '1 minute' WHERE user_id = $1`,
        [userId],
      );
      await agent.get(JWT_ROUTE).expect(401);
    });

    it('session row deleted (logout elsewhere)', async () => {
      const { agent, userId } = await createAuthenticatedUser(ctx.app, ctx.dataSource);
      await agent.get(JWT_ROUTE).expect(200);
      await ctx.dataSource.query('DELETE FROM user_sessions WHERE user_id = $1', [userId]);
      await agent.get(JWT_ROUTE).expect(401);
    });

    it('role change admin -> student is reflected on an admin route', async () => {
      const { agent, userId } = await createAuthenticatedUser(ctx.app, ctx.dataSource, {
        role: 'admin',
      });
      await agent.get(`${API_PREFIX}/admin/students`).expect(200);
      await setUserRole(ctx.dataSource, userId, 'student');
      await agent.get(`${API_PREFIX}/admin/students`).expect(403);
    });
  });

  describe('finance permissions ride on the principal statement (W2-C2)', () => {
    const DASHBOARD = `${API_PREFIX}/analytics/admin/dashboard`;

    it('revoking finance permissions is effective on the next request', async () => {
      const { agent, userId } = await createAuthenticatedUser(ctx.app, ctx.dataSource, {
        role: 'admin',
      });
      const before = await agent.get(DASHBOARD).expect(200);
      expect(before.body.finance?.status ?? before.body.data?.finance?.status).not.toBe(
        'forbidden',
      );

      await ctx.dataSource.query(
        `UPDATE users SET finance_permissions = '[]'::jsonb WHERE id = $1`,
        [userId],
      );
      const after = await agent.get(DASHBOARD).expect(200);
      expect(after.body.finance?.status ?? after.body.data?.finance?.status).toBe('forbidden');
    });

    // Finance handler verified not to read `users`/`user_sessions`:
    // AdminLedgerController.list -> LedgerService.listEntriesAdmin (ledger entries only).
    const LEDGER = `${API_PREFIX}/marketplace/admin/ledger`;

    it('finance route: allowed with the permission, one principal statement, no guard read', async () => {
      const { agent } = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'admin' });
      await agent.get(LEDGER).expect(200); // warm
      counter.start();
      await agent.get(LEDGER).set('X-Request-Id', 'probe-ledger').expect(200);
      counter.stop();
      const sessions = counter.statements({ requestId: 'probe-ledger', table: 'user_sessions' });
      const users = counter.statements({ requestId: 'probe-ledger', table: 'users' });
      expect(new Set([...sessions, ...users]).size).toBe(1);
    });

    it('finance route: revoking the permission is effective on the next request', async () => {
      const { agent, userId } = await createAuthenticatedUser(ctx.app, ctx.dataSource, {
        role: 'admin',
      });
      await agent.get(LEDGER).expect(200);
      await ctx.dataSource.query(
        `UPDATE users SET finance_permissions = '[]'::jsonb WHERE id = $1`,
        [userId],
      );
      await agent.get(LEDGER).expect(403);
    });

    it('finance route: role changed away from admin is effective on the next request', async () => {
      const { agent, userId } = await createAuthenticatedUser(ctx.app, ctx.dataSource, {
        role: 'admin',
      });
      await agent.get(LEDGER).expect(200);
      await setUserRole(ctx.dataSource, userId, 'student');
      await agent.get(LEDGER).expect(403);
    });

    it('warm-cache dashboard request costs exactly one statement', async () => {
      const { agent } = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'admin' });
      await agent.get(DASHBOARD).expect(200); // cold: populates the cache entry
      counter.start();
      await agent.get(DASHBOARD).set('X-Request-Id', 'probe-dash').expect(200);
      counter.stop();
      expect(counter.count({ requestId: 'probe-dash' })).toBe(1);
    });
  });
});
