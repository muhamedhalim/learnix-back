import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import request from 'supertest';

import { MailService } from '../../src/mail/mail.service';
import { MarketplaceInstructorStatus } from '../../src/marketplace/common/enums';
import { MarketplaceInstructor } from '../../src/marketplace/instructors/entities/marketplace-instructor.entity';
import { User } from '../../src/users/entities/user.entity';
import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  setUserRole,
} from './fixtures';
import { TEST_IMAGE_KEY } from './helpers/images';

/**
 * Phase 1 of the marketplace remediation (MP-02): a person who applies without
 * an account is provisioned, on approval, as a user with `role = NULL` — and the
 * whole chain has to work for them. The frontend now signs such an account in
 * and sends it to the instructor workspace, which is only correct if the
 * backend really lets a null-role principal through the instructor and learner
 * routes while still refusing every role-gated route.
 *
 * Real code throughout: the public submission, the admin approval, the emailed
 * single-use setup token (captured from the mail call, not forged in the
 * database), `POST /auth/reset-password`, login and the guards.
 */
describe('marketplace — public instructor (no academic role) end to end', () => {
  let app: INestApplication;
  let server: Server;
  let dataSource: DataSource;

  const applicantEmail = `public.instructor.${randomUUID().slice(0, 8)}@example.com`;
  const applicantPhone = '01012345678';
  const newPassword = 'Str0ngPassw0rd!x';

  const publicApplication = {
    applicant_email: applicantEmail,
    applicant_phone: applicantPhone,
    display_name: 'Layla Hassan',
    photo_key: TEST_IMAGE_KEY,
    headline: 'Data Engineer',
    bio: 'Eight years building data platforms.',
    years_of_experience: 8,
    specializations: ['Data Engineering'],
    intended_category_ids: ['11111111-1111-4111-8111-111111111111'],
    professional_links: [{ kind: 'linkedin', url: 'https://www.linkedin.com/in/example' }],
  };

  beforeAll(async () => {
    ({ app, dataSource } = await createE2EApp());
    server = app.getHttpServer() as Server;
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  /** Submit publicly, approve as admin, return the setup token the email carried. */
  async function applyAndApprove(): Promise<string> {
    await request(server)
      .post(`${API_PREFIX}/marketplace/applications/public`)
      .send(publicApplication)
      .expect(201);

    const admin = await createAuthenticatedUser(app, dataSource);
    await setUserRole(dataSource, admin.userId, 'admin');

    const queue = await admin.agent.get(`${API_PREFIX}/marketplace/admin/applications`).expect(200);
    expect(queue.body.items).toHaveLength(1);
    const applicationId = queue.body.items[0].id as string;

    const sent: Array<{ to: string; personalization: { setupUrl: string } }> = [];
    jest
      .spyOn(app.get(MailService, { strict: false }), 'sendInvitationEmail')
      .mockImplementation((payload) => {
        sent.push(payload as unknown as (typeof sent)[number]);
        return Promise.resolve();
      });

    await admin.agent
      .post(`${API_PREFIX}/marketplace/admin/applications/${applicationId}/approve`)
      .send({})
      .expect(201);

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(applicantEmail);
    const token = new URL(sent[0].personalization.setupUrl).searchParams.get('token');
    expect(token).toBeTruthy();
    return token as string;
  }

  it('provisions an approved instructor with no academic role and no password yet', async () => {
    await applyAndApprove();

    const user = await dataSource.getRepository(User).findOneOrFail({ where: { email: applicantEmail } });
    expect(user.role).toBeNull();
    // `password_hash` is not a default-selected column, so read it directly.
    const [{ password_hash }] = (await dataSource.query(
      'SELECT password_hash FROM users WHERE id = $1',
      [user.id],
    )) as Array<{ password_hash: string | null }>;
    expect(password_hash).toBeNull();

    const instructor = await dataSource
      .getRepository(MarketplaceInstructor)
      .findOneOrFail({ where: { user_id: user.id } });
    expect(instructor.status).toBe(MarketplaceInstructorStatus.APPROVED);
  });

  it('lets the applicant set a password from the emailed token and sign in with role null', async () => {
    const token = await applyAndApprove();

    // Nothing can sign in before the password is set.
    await request(server)
      .post(`${API_PREFIX}/auth/login`)
      .send({ email: applicantEmail, password: newPassword })
      .expect(401);

    await request(server)
      .post(`${API_PREFIX}/auth/reset-password`)
      .send({ token, newPassword })
      .expect(200);

    // The token is single-use.
    await request(server)
      .post(`${API_PREFIX}/auth/reset-password`)
      .send({ token, newPassword: 'An0therPassw0rd!y' })
      .expect(400);

    const login = await request(server)
      .post(`${API_PREFIX}/auth/login`)
      .send({ email: applicantEmail, password: newPassword })
      .expect(200);

    expect(login.body.status).toBe('approved');
    expect(login.body.role).toBeNull();
    expect(typeof login.body.userId).toBe('string');
  });

  it('then serves the instructor workspace and learner routes, and refuses every role-gated route', async () => {
    const token = await applyAndApprove();
    await request(server)
      .post(`${API_PREFIX}/auth/reset-password`)
      .send({ token, newPassword })
      .expect(200);

    const agent = request.agent(server);
    await agent
      .post(`${API_PREFIX}/auth/login`)
      .send({ email: applicantEmail, password: newPassword })
      .expect(200);

    // Instructor capability is the marketplace_instructors row, not users.role.
    const profile = await agent.get(`${API_PREFIX}/marketplace/instructor/profile`).expect(200);
    expect(profile.body.display_name).toBe('Layla Hassan');
    await agent.get(`${API_PREFIX}/marketplace/instructor/courses`).expect(200);

    // Learner routes only need a session: an instructor can also buy courses.
    await agent.get(`${API_PREFIX}/marketplace/me/enrollments`).expect(200);
    await agent.get(`${API_PREFIX}/marketplace/me/orders`).expect(200);

    // No academic or admin capability is implied by having no role.
    await agent.get(`${API_PREFIX}/marketplace/admin/overview`).expect(403);
    await agent.get(`${API_PREFIX}/marketplace/admin/applications`).expect(403);
  });
});
