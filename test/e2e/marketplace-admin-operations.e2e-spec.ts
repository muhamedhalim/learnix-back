import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import request from 'supertest';

import { MailService } from '../../src/mail/mail.service';
import { GrantAdminMarketplaceFinancePermissions2211000000000 } from '../../src/migrations/2211000000000-GrantAdminMarketplaceFinancePermissions';
import { MarketplaceInstructorStatus } from '../../src/marketplace/common/enums';
import { MarketplaceInstructor } from '../../src/marketplace/instructors/entities/marketplace-instructor.entity';
import { User } from '../../src/users/entities/user.entity';
import { buildInstructorFixture } from './factories/marketplace.factory';
import { API_PREFIX, createAuthenticatedUser, createE2EApp, resetDatabase, setUserRole } from './fixtures';
import { TEST_IMAGE_KEY } from './helpers/images';

/**
 * Phase 3 of the marketplace remediation (admin operations):
 *  - MP-06  administrators created before the marketplace hold none of its finance permissions;
 *  - MP-15  approving an application must not 500 on a failed email or a duplicate account, and a lost
 *           setup email must be recoverable;
 *  - MP-20  the applicant has to be told the decision.
 */
describe('marketplace admin operations (Phase 3)', () => {
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

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  const mail = () => app.get(MailService, { strict: false });

  async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 4000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let value = await read();
    while (!accept(value) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      value = await read();
    }
    return value;
  }

  const application = {
    display_name: 'Layla Hassan',
    headline: 'Data Engineer',
    bio: 'Eight years building data platforms.',
    years_of_experience: 8,
    specializations: ['Data Engineering'],
    intended_category_ids: ['11111111-1111-4111-8111-111111111111'],
    professional_links: [{ kind: 'linkedin', url: 'https://www.linkedin.com/in/example' }],
  };

  async function admin() {
    const user = await createAuthenticatedUser(app, dataSource);
    await setUserRole(dataSource, user.userId, 'admin');
    return user;
  }

  async function submitPublic(email: string, phone = '01012345678'): Promise<string> {
    await request(server)
      .post(`${API_PREFIX}/marketplace/applications/public`)
      .send({ ...application, applicant_email: email, applicant_phone: phone })
      .expect(201);
    const row = (await dataSource.query(
      'SELECT id FROM marketplace_instructor_applications WHERE applicant_email = $1',
      [email],
    )) as Array<{ id: string }>;
    return row[0]!.id;
  }

  describe('administrator finance permissions (MP-06)', () => {
    const MARKETPLACE_ADMIN_ROUTES = [
      `${API_PREFIX}/marketplace/admin/payouts`,
      `${API_PREFIX}/marketplace/admin/refunds`,
      `${API_PREFIX}/marketplace/admin/ledger?currency=EGP`,
    ];

    it('opens every finance-gated marketplace page to an administrator who predates them, without touching anyone else', async () => {
      // An administrator as 2058 left them: finance permissions, none of the marketplace ones.
      const old = await admin();
      await dataSource.getRepository(User).update({ id: old.userId }, { finance_permissions: ['reports.view', 'refunds.create'] as never });
      // One who has nothing, one who already has them all, and a learner.
      const empty = await admin();
      await dataSource.getRepository(User).update({ id: empty.userId }, { finance_permissions: [] });
      const learner = await createAuthenticatedUser(app, dataSource);

      for (const route of MARKETPLACE_ADMIN_ROUTES) {
        await old.agent.get(route).expect(403);
      }

      const runner = dataSource.createQueryRunner();
      try {
        await new GrantAdminMarketplaceFinancePermissions2211000000000().up(runner);
        // Idempotent: a second run changes nothing.
        await new GrantAdminMarketplaceFinancePermissions2211000000000().up(runner);
      } finally {
        await runner.release();
      }

      // The same session works at once: permissions are read from the database on each request.
      for (const route of MARKETPLACE_ADMIN_ROUTES) {
        await old.agent.get(route).expect(200);
        await empty.agent.get(route).expect(200);
      }

      const held = async (id: string): Promise<string[]> =>
        ((await dataSource.getRepository(User).findOneByOrFail({ id })).finance_permissions as string[]).slice().sort();
      const oldPermissions = await held(old.userId);
      expect(oldPermissions).toEqual(expect.arrayContaining(['reports.view', 'refunds.create', 'marketplace.payouts.pay', 'marketplace.ledger.adjust']));
      expect(oldPermissions.filter((p) => p.startsWith('marketplace.'))).toHaveLength(9);
      expect(new Set(oldPermissions).size).toBe(oldPermissions.length);

      // A learner gains nothing and still cannot reach the pages.
      expect(await held(learner.userId)).toEqual([]);
      for (const route of MARKETPLACE_ADMIN_ROUTES) {
        await learner.agent.get(route).expect(403);
      }
    });
  });

  describe('approving an application (MP-15)', () => {
    it('grants the capability and says the setup email did not go out, instead of failing with a 500', async () => {
      const email = `p3.${randomUUID().slice(0, 8)}@example.com`;
      const applicationId = await submitPublic(email);
      const boss = await admin();
      jest.spyOn(mail(), 'sendInvitationEmail').mockResolvedValue(false);

      const approved = await boss.agent
        .post(`${API_PREFIX}/marketplace/admin/applications/${applicationId}/approve`)
        .send({})
        .expect(201);

      expect(approved.body.account_setup_email).toBe('failed');
      const user = await dataSource.getRepository(User).findOneByOrFail({ email });
      const instructor = await dataSource.getRepository(MarketplaceInstructor).findOneByOrFail({ user_id: user.id });
      expect(instructor.status).toBe(MarketplaceInstructorStatus.APPROVED);
    });

    it('does not fail either when queueing the email throws', async () => {
      const applicationId = await submitPublic(`p3.${randomUUID().slice(0, 8)}@example.com`);
      const boss = await admin();
      jest.spyOn(mail(), 'sendInvitationEmail').mockRejectedValue(new Error('Email could not be queued for delivery.'));

      const approved = await boss.agent
        .post(`${API_PREFIX}/marketplace/admin/applications/${applicationId}/approve`)
        .send({})
        .expect(201);
      expect(approved.body.account_setup_email).toBe('failed');
    });

    it('answers 409, not 500, when the applicant\'s email now belongs to an account that already is an instructor', async () => {
      const email = `p3.${randomUUID().slice(0, 8)}@example.com`;
      const applicationId = await submitPublic(email);
      // They registered in the meantime, and were made an instructor through another application.
      const existing = await createAuthenticatedUser(app, dataSource, { overrides: { email } });
      await dataSource.getRepository(MarketplaceInstructor).save(buildInstructorFixture({ user_id: existing.userId }));
      const boss = await admin();

      const res = await boss.agent
        .post(`${API_PREFIX}/marketplace/admin/applications/${applicationId}/approve`)
        .send({})
        .expect(409);
      expect(res.body.message ?? res.body.detail).toEqual(expect.any(String));

      // The application is untouched and can still be rejected.
      const rows = (await dataSource.query('SELECT status FROM marketplace_instructor_applications WHERE id = $1', [applicationId])) as Array<{ status: string }>;
      expect(['submitted', 'under_review']).toContain(rows[0]!.status);
      await boss.agent
        .post(`${API_PREFIX}/marketplace/admin/applications/${applicationId}/reject`)
        .send({ reason: 'Already an instructor' })
        .expect(201);
    });

    it('lets an administrator resend the setup link, which then works once and only for an account with no password', async () => {
      const email = `p3.${randomUUID().slice(0, 8)}@example.com`;
      const applicationId = await submitPublic(email);
      const boss = await admin();
      const outbox = jest.spyOn(mail(), 'sendInvitationEmail').mockResolvedValue(false);
      await boss.agent.post(`${API_PREFIX}/marketplace/admin/applications/${applicationId}/approve`).send({}).expect(201);
      const user = await dataSource.getRepository(User).findOneByOrFail({ email });
      const instructor = await dataSource.getRepository(MarketplaceInstructor).findOneByOrFail({ user_id: user.id });
      const resend = `${API_PREFIX}/marketplace/admin/instructors/${instructor.id}/resend-setup-link`;

      // Mail still down: the administrator is told, not given a false "sent".
      await boss.agent.post(resend).send({}).expect(503);

      // Mail back: the link goes out and carries a working token.
      const links: string[] = [];
      outbox.mockImplementation((input) => {
        links.push(String((input.personalization as { setupUrl: string }).setupUrl));
        return Promise.resolve(true);
      });
      await boss.agent.post(resend).send({}).expect(201, { sent: true });
      const token = new URL(links[links.length - 1]!).searchParams.get('token');
      expect(token).toBeTruthy();
      await request(server)
        .post(`${API_PREFIX}/auth/reset-password`)
        .send({ token, newPassword: 'Str0ngPassw0rd!x' })
        .expect(200);

      // Now the account has a password, so there is nothing to resend.
      await boss.agent.post(resend).send({}).expect(409);

      const audit = (await dataSource.query("SELECT admin_id FROM audit_logs WHERE action = 'marketplace_instructor_setup_link_resent'")) as Array<{ admin_id: string }>;
      expect(audit).toHaveLength(1);
      expect(audit[0]!.admin_id).toBe(boss.userId);
    });

    it('keeps the resend route to administrators and answers 404 for an unknown instructor', async () => {
      const boss = await admin();
      const learner = await createAuthenticatedUser(app, dataSource);
      const target = `${API_PREFIX}/marketplace/admin/instructors/${randomUUID()}/resend-setup-link`;
      await learner.agent.post(target).send({}).expect(403);
      await request(server).post(target).send({}).expect(401);
      await boss.agent.post(target).send({}).expect(404);
    });
  });

  describe('telling the applicant the decision (MP-20)', () => {
    const submitSignedIn = async () => {
      const learner = await createAuthenticatedUser(app, dataSource);
      await learner.agent.post(`${API_PREFIX}/marketplace/applications`).send({ display_name: 'Nour' }).expect(201);
      await learner.agent
        .patch(`${API_PREFIX}/marketplace/applications/me`)
        .send({ ...application, photo_key: TEST_IMAGE_KEY })
        .expect(200);
      await learner.agent.post(`${API_PREFIX}/marketplace/applications/me/submit`).send({}).expect(201);
      const boss = await admin();
      const queue = await boss.agent.get(`${API_PREFIX}/marketplace/admin/applications`).expect(200);
      return { learner, boss, applicationId: queue.body.items[0].id as string };
    };

    const titles = async (userId: string): Promise<string[]> =>
      ((await dataSource.query('SELECT title FROM notifications WHERE user_id = $1', [userId])) as Array<{ title: string }>).map((r) => r.title);

    it('notifies a signed-in applicant of approval', async () => {
      const { learner, boss, applicationId } = await submitSignedIn();
      await boss.agent.post(`${API_PREFIX}/marketplace/admin/applications/${applicationId}/approve`).send({}).expect(201);

      const seen = await eventually(() => titles(learner.userId), (t) => t.length > 0);
      expect(seen).toContain('Your instructor application was approved');
    });

    it('gives a signed-in applicant the rejection reason', async () => {
      const { learner, boss, applicationId } = await submitSignedIn();
      await boss.agent
        .post(`${API_PREFIX}/marketplace/admin/applications/${applicationId}/reject`)
        .send({ reason: 'Please add a portfolio link' })
        .expect(201);

      const seen = await eventually(() => titles(learner.userId), (t) => t.length > 0);
      expect(seen).toContain('Your instructor application was not approved');
      const messages = (await dataSource.query('SELECT message FROM notifications WHERE user_id = $1', [learner.userId])) as Array<{ message: string }>;
      expect(messages.some((m) => m.message.includes('Please add a portfolio link'))).toBe(true);
    });

    it('emails a rejected public applicant, who has no account to notify', async () => {
      const email = `p3.${randomUUID().slice(0, 8)}@example.com`;
      const applicationId = await submitPublic(email);
      const boss = await admin();
      const send = jest.spyOn(mail(), 'send').mockResolvedValue(true);

      await boss.agent
        .post(`${API_PREFIX}/marketplace/admin/applications/${applicationId}/reject`)
        .send({ reason: 'Needs more detail' })
        .expect(201);

      await eventually(() => Promise.resolve(send.mock.calls.length), (n) => n > 0);
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: email, text: expect.stringContaining('Needs more detail') }));
    });
  });
});
