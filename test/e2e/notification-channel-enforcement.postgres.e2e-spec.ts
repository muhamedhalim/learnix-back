import type { Server } from 'node:http';

import request from 'supertest';
import type { DataSource } from 'typeorm';

import { ParentEventType } from '../../src/common/events/parent-event-type.enum';
import { GuardiansService } from '../../src/guardians/guardians.service';
import {
  NotificationChannel,
  NotificationDeliveryStatus,
  NotificationType,
  PushProviderName,
} from '../../src/notifications/entities';
import type {
  PushMessage,
  PushSendResult,
} from '../../src/notifications/push/push-provider.interface';
import { NotificationChannelPolicyService } from '../../src/notifications/services/notification-channel-policy.service';
import { NotificationsService } from '../../src/notifications/services/notifications.service';
import { PushDeviceService } from '../../src/notifications/services/push-device.service';
import { PushDispatchService } from '../../src/notifications/services/push-dispatch.service';
import { SmsSenderService } from '../../src/notifications/services/sms-sender.service';
import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  type AuthenticatedUser,
  type E2EContext,
} from './fixtures';

/**
 * DEF-005 — end-to-end proof, against real PostgreSQL, that the toggles a user
 * sees govern REAL DISPATCH and not merely a stored value.
 *
 * The bar every test here is written to: flipping a switch through the public
 * API must change whether a provider is contacted. Asserting that the column
 * changed is exactly the standard the defect already passed.
 *
 * The FCM transport is the only substituted component (a recording double at
 * the `PushProvider` seam). Preference policy, device selection, delivery
 * records and invalid-token handling are the production code paths, and every
 * row assertion below reads the real database.
 */
// Booting the full AppModule and creating real accounts (bcrypt at production
// cost) is well past Jest's 5s default.
jest.setTimeout(120_000);

describe('DEF-005 · notification channel enforcement (PostgreSQL)', () => {
  let context: E2EContext;
  let server: Server;
  let dataSource: DataSource;

  let sent: PushMessage[] = [];
  let nextResults: ((messages: PushMessage[]) => PushSendResult[]) | null = null;
  let providerConfigured = true;

  const pushProvider = {
    name: 'fcm',
    isConfigured: () => providerConfigured,
    sendEach: async (messages: PushMessage[]): Promise<PushSendResult[]> => {
      sent.push(...messages);
      return nextResults === null
        ? messages.map((m) => ({
            token: m.token,
            accepted: true,
            providerMessageId: `p-${m.token}`,
          }))
        : nextResults(messages);
    },
  };

  let notifications: NotificationsService;
  let policy: NotificationChannelPolicyService;
  let devices: PushDeviceService;
  let dispatcher: PushDispatchService;
  let guardians: GuardiansService;
  let smsSpy: jest.SpyInstance;

  beforeAll(async () => {
    context = await createE2EApp({ pushProvider });
    server = context.app.getHttpServer() as Server;
    dataSource = context.dataSource;

    notifications = context.app.get(NotificationsService);
    policy = context.app.get(NotificationChannelPolicyService);
    devices = context.app.get(PushDeviceService);
    dispatcher = context.app.get(PushDispatchService);
    guardians = context.app.get(GuardiansService);

    // Twilio is unconfigured in the E2E environment, so `sendBulkSms` would
    // short-circuit anyway; spying on it is how we observe whether the
    // dispatcher even TRIED to send, which is the thing under test.
    smsSpy = jest.spyOn(context.app.get(SmsSenderService), 'sendBulkSms');
  });

  afterAll(async () => {
    smsSpy?.mockRestore();
    await context?.app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    sent = [];
    nextResults = null;
    providerConfigured = true;
    smsSpy.mockClear();
    smsSpy.mockResolvedValue([{ success: true, messageId: 'SM1' }]);
  });

  /* ------------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------------ */

  async function student(): Promise<AuthenticatedUser> {
    return createAuthenticatedUser(context.app, dataSource, { role: 'student' });
  }

  async function setPreferences(
    user: AuthenticatedUser,
    body: Record<string, boolean>,
  ): Promise<void> {
    await user.agent.put(`${API_PREFIX}/notification-settings`).send(body).expect(200);
  }

  async function notify(userId: string, title = 'Homework graded'): Promise<string> {
    const notification = await notifications.create(
      {
        user_id: userId,
        type: NotificationType.HOMEWORK,
        title,
        message: 'Your homework has been graded.',
        send_sms: false,
      },
      false,
    );
    return notification.id;
  }

  async function deliveryRows(
    notificationId: string,
  ): Promise<Array<{ channel: string; status: string; push_device_id: string | null }>> {
    return (await dataSource.query(
      `SELECT channel, status, push_device_id FROM notification_deliveries
        WHERE notification_id = $1 ORDER BY created_at ASC`,
      [notificationId],
    )) as Array<{ channel: string; status: string; push_device_id: string | null }>;
  }

  /** A verified guardian linked to `studentId`, eligible for every event. */
  async function verifiedGuardian(studentId: string, phone: string): Promise<string> {
    const link = await guardians.linkGuardian(studentId, { phone, full_name: 'Parent' });
    await dataSource.query(
      `UPDATE guardians SET verification_status = 'verified', verified_at = now() WHERE id = $1`,
      [link.guardian_id],
    );
    return link.guardian_id;
  }

  /* ------------------------------------------------------------------ *
   * Push device registration — authorization
   * ------------------------------------------------------------------ */

  describe('push device registration requires authentication and is self-scoped', () => {
    it('rejects an unauthenticated registration', async () => {
      await request(server)
        .post(`${API_PREFIX}/notifications/push/devices`)
        .send({ token: 'a'.repeat(64), platform: 'web' })
        .expect(401);

      const rows = (await dataSource.query(
        'SELECT COUNT(*)::int AS c FROM push_devices',
      )) as Array<{
        c: number;
      }>;
      expect(rows[0]?.c).toBe(0);
    });

    it('cannot register a token against another user id', async () => {
      const [alice, bob] = [await student(), await student()];

      // There is no user_id field in the DTO, and the global ValidationPipe runs
      // with forbidNonWhitelisted — so smuggling one is a 400, not a silent
      // ownership transfer.
      await alice.agent
        .post(`${API_PREFIX}/notifications/push/devices`)
        .send({ token: 'b'.repeat(64), platform: 'web', user_id: bob.userId })
        .expect(400);

      const rows = (await dataSource.query(
        'SELECT COUNT(*)::int AS c FROM push_devices',
      )) as Array<{
        c: number;
      }>;
      expect(rows[0]?.c).toBe(0);
    });

    it('registers under the authenticated user and never returns the token', async () => {
      const alice = await student();

      const response = await alice.agent
        .post(`${API_PREFIX}/notifications/push/devices`)
        .send({ token: 'c'.repeat(64), platform: 'web', device_id: 'install-1' })
        .expect(200);

      expect(response.body.data).toMatchObject({ platform: 'web', enabled: true });
      expect(JSON.stringify(response.body)).not.toContain('c'.repeat(64));

      const rows = (await dataSource.query(
        'SELECT user_id, token, enabled FROM push_devices',
      )) as Array<{ user_id: string; token: string; enabled: boolean }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.user_id).toBe(alice.userId);
    });

    it('a user cannot revoke another user’s device', async () => {
      const [alice, bob] = [await student(), await student()];
      const created = await alice.agent
        .post(`${API_PREFIX}/notifications/push/devices`)
        .send({ token: 'd'.repeat(64), platform: 'web' })
        .expect(200);
      const deviceRowId = created.body.data.id as string;

      // By row id: scoped by user_id, so a foreign row is simply not found.
      await bob.agent.delete(`${API_PREFIX}/notifications/push/devices/${deviceRowId}`).expect(404);

      // By token: same scoping — Bob is told nothing matched, which also avoids
      // confirming that this token exists under another account.
      const byToken = await bob.agent
        .post(`${API_PREFIX}/notifications/push/devices/unregister`)
        .send({ token: 'd'.repeat(64) })
        .expect(200);
      expect(byToken.body.data.revoked).toBe(false);

      const rows = (await dataSource.query('SELECT enabled FROM push_devices WHERE id = $1', [
        deviceRowId,
      ])) as Array<{ enabled: boolean }>;
      expect(rows[0]?.enabled).toBe(true);
    });

    it('lists only the caller’s own devices', async () => {
      const [alice, bob] = [await student(), await student()];
      await alice.agent
        .post(`${API_PREFIX}/notifications/push/devices`)
        .send({ token: 'e'.repeat(64) })
        .expect(200);
      await bob.agent
        .post(`${API_PREFIX}/notifications/push/devices`)
        .send({ token: 'f'.repeat(64) })
        .expect(200);

      const aliceList = await alice.agent
        .get(`${API_PREFIX}/notifications/push/devices`)
        .expect(200);
      expect(aliceList.body.data).toHaveLength(1);
    });
  });

  /* ------------------------------------------------------------------ *
   * Device lifecycle
   * ------------------------------------------------------------------ */

  describe('token lifecycle', () => {
    it('supports multiple concurrent devices per user', async () => {
      const alice = await student();
      for (const [index, token] of ['t-1', 't-2', 't-3'].entries()) {
        await alice.agent
          .post(`${API_PREFIX}/notifications/push/devices`)
          .send({ token: token.padEnd(40, 'x'), device_id: `install-${String(index)}` })
          .expect(200);
      }

      const active = await devices.findActiveForUser(alice.userId);
      expect(active).toHaveLength(3);
    });

    it('rotates a token in place for a known device_id instead of duplicating', async () => {
      const alice = await student();
      await alice.agent
        .post(`${API_PREFIX}/notifications/push/devices`)
        .send({ token: 'old-token'.padEnd(40, 'x'), device_id: 'install-1' })
        .expect(200);
      await alice.agent
        .post(`${API_PREFIX}/notifications/push/devices`)
        .send({ token: 'new-token'.padEnd(40, 'x'), device_id: 'install-1' })
        .expect(200);

      const active = await devices.findActiveForUser(alice.userId);
      expect(active).toHaveLength(1);
      expect(active[0]?.token).toBe('new-token'.padEnd(40, 'x'));
    });

    it('re-registering the same token is idempotent and re-enables a revoked device', async () => {
      const alice = await student();
      const token = 'stable-token'.padEnd(40, 'x');

      const first = await alice.agent
        .post(`${API_PREFIX}/notifications/push/devices`)
        .send({ token })
        .expect(200);
      await alice.agent
        .post(`${API_PREFIX}/notifications/push/devices/unregister`)
        .send({ token })
        .expect(200);
      expect(await devices.findActiveForUser(alice.userId)).toHaveLength(0);

      const second = await alice.agent
        .post(`${API_PREFIX}/notifications/push/devices`)
        .send({ token })
        .expect(200);

      expect(second.body.data.id).toBe(first.body.data.id);
      expect(await devices.findActiveForUser(alice.userId)).toHaveLength(1);
    });

    it('reassigns a shared install to whoever signed in last, so the previous user stops receiving', async () => {
      const [alice, bob] = [await student(), await student()];
      const token = 'shared-browser-token'.padEnd(40, 'x');

      await alice.agent
        .post(`${API_PREFIX}/notifications/push/devices`)
        .send({ token })
        .expect(200);
      await bob.agent.post(`${API_PREFIX}/notifications/push/devices`).send({ token }).expect(200);

      expect(await devices.findActiveForUser(alice.userId)).toHaveLength(0);
      expect(await devices.findActiveForUser(bob.userId)).toHaveLength(1);
    });

    it('logout-style revoke by token stops dispatch for that device only', async () => {
      const alice = await student();
      await setPreferences(alice, { push_enabled: true });
      await alice.agent
        .post(`${API_PREFIX}/notifications/push/devices`)
        .send({ token: 'phone-token'.padEnd(40, 'x'), device_id: 'install-phone' })
        .expect(200);
      await alice.agent
        .post(`${API_PREFIX}/notifications/push/devices`)
        .send({ token: 'laptop-token'.padEnd(40, 'x'), device_id: 'install-laptop' })
        .expect(200);

      await alice.agent
        .post(`${API_PREFIX}/notifications/push/devices/unregister`)
        .send({ token: 'laptop-token'.padEnd(40, 'x') })
        .expect(200);

      await dispatcher.dispatch(await notify(alice.userId));

      expect(sent.map((m) => m.token)).toEqual(['phone-token'.padEnd(40, 'x')]);
    });
  });

  /* ------------------------------------------------------------------ *
   * Push dispatch
   * ------------------------------------------------------------------ */

  describe('push_enabled governs real FCM dispatch', () => {
    it('push_enabled = true with a registered device invokes the provider', async () => {
      const alice = await student();
      await setPreferences(alice, { push_enabled: true });
      await alice.agent
        .post(`${API_PREFIX}/notifications/push/devices`)
        .send({ token: 'live-token'.padEnd(40, 'x') })
        .expect(200);

      const notificationId = await notify(alice.userId);
      await dispatcher.dispatch(notificationId);

      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        token: 'live-token'.padEnd(40, 'x'),
        title: 'Homework graded',
        data: expect.objectContaining({ notification_id: notificationId }),
      });

      const legs = await deliveryRows(notificationId);
      expect(legs).toEqual([
        expect.objectContaining({
          channel: NotificationChannel.PUSH,
          status: NotificationDeliveryStatus.SENT,
        }),
      ]);
    });

    it('push_enabled = false does NOT invoke the provider even with a valid token', async () => {
      const alice = await student();
      await setPreferences(alice, { push_enabled: true });
      await alice.agent
        .post(`${API_PREFIX}/notifications/push/devices`)
        .send({ token: 'muted-token'.padEnd(40, 'x') })
        .expect(200);
      await setPreferences(alice, { push_enabled: false });

      const notificationId = await notify(alice.userId);
      await dispatcher.dispatch(notificationId);

      expect(sent).toHaveLength(0);
      const legs = await deliveryRows(notificationId);
      expect(legs[0]).toMatchObject({ status: NotificationDeliveryStatus.SKIPPED_PREFERENCE });
    });

    it('a preference update changes SUBSEQUENT real dispatch behaviour', async () => {
      const alice = await student();
      await alice.agent
        .post(`${API_PREFIX}/notifications/push/devices`)
        .send({ token: 'toggle-token'.padEnd(40, 'x') })
        .expect(200);

      await setPreferences(alice, { push_enabled: false });
      await dispatcher.dispatch(await notify(alice.userId, 'First'));
      expect(sent).toHaveLength(0);

      await setPreferences(alice, { push_enabled: true });
      await dispatcher.dispatch(await notify(alice.userId, 'Second'));
      expect(sent).toHaveLength(1);
      expect(sent[0]?.title).toBe('Second');
    });

    it('push_enabled = true with no device sends nothing and records no_registered_device', async () => {
      const alice = await student();
      await setPreferences(alice, { push_enabled: true });

      const notificationId = await notify(alice.userId);
      await dispatcher.dispatch(notificationId);

      expect(sent).toHaveLength(0);
      const legs = await deliveryRows(notificationId);
      expect(legs[0]).toMatchObject({ status: NotificationDeliveryStatus.NO_REGISTERED_DEVICE });
    });

    it('delivers to every eligible device of a multi-device user', async () => {
      const alice = await student();
      await setPreferences(alice, { push_enabled: true });
      for (const id of ['a', 'b', 'c']) {
        await alice.agent
          .post(`${API_PREFIX}/notifications/push/devices`)
          .send({ token: `token-${id}`.padEnd(40, 'x'), device_id: `install-${id}` })
          .expect(200);
      }

      const notificationId = await notify(alice.userId);
      await dispatcher.dispatch(notificationId);

      expect(sent).toHaveLength(3);
      expect(await deliveryRows(notificationId)).toHaveLength(3);
    });

    it('disables ONLY the invalid token and preserves the other devices’ sends', async () => {
      const alice = await student();
      await setPreferences(alice, { push_enabled: true });
      const tokens = ['good-1'.padEnd(40, 'x'), 'dead'.padEnd(40, 'x'), 'good-2'.padEnd(40, 'x')];
      for (const [index, token] of tokens.entries()) {
        await alice.agent
          .post(`${API_PREFIX}/notifications/push/devices`)
          .send({ token, device_id: `install-${String(index)}` })
          .expect(200);
      }

      nextResults = (messages) =>
        messages.map((m) =>
          m.token === tokens[1]
            ? {
                token: m.token,
                accepted: false,
                tokenInvalid: true,
                error: 'messaging/registration-token-not-registered',
              }
            : { token: m.token, accepted: true, providerMessageId: `p-${m.token}` },
        );

      const notificationId = await notify(alice.userId);
      await dispatcher.dispatch(notificationId);

      const rows = (await dataSource.query(
        `SELECT token, enabled, disabled_reason FROM push_devices WHERE user_id = $1 ORDER BY token`,
        [alice.userId],
      )) as Array<{ token: string; enabled: boolean; disabled_reason: string | null }>;

      const dead = rows.find((r) => r.token === tokens[1]);
      expect(dead).toMatchObject({ enabled: false, disabled_reason: 'invalid_token' });
      for (const survivor of rows.filter((r) => r.token !== tokens[1])) {
        expect(survivor.enabled).toBe(true);
        expect(survivor.disabled_reason).toBeNull();
      }

      const legs = await deliveryRows(notificationId);
      expect(legs.filter((l) => l.status === NotificationDeliveryStatus.SENT)).toHaveLength(2);
      expect(
        legs.filter((l) => l.status === NotificationDeliveryStatus.INVALID_TOKEN),
      ).toHaveLength(1);

      // The disabled device is out of the pool for the next notification…
      sent = [];
      nextResults = null;
      await dispatcher.dispatch(await notify(alice.userId, 'Second'));
      expect(sent.map((m) => m.token).sort()).toEqual([tokens[0], tokens[2]].sort());
    });

    it('a retry re-sends nothing that already succeeded (idempotent)', async () => {
      const alice = await student();
      await setPreferences(alice, { push_enabled: true });
      await alice.agent
        .post(`${API_PREFIX}/notifications/push/devices`)
        .send({ token: 'retry-token'.padEnd(40, 'x') })
        .expect(200);

      const notificationId = await notify(alice.userId);
      await dispatcher.dispatch(notificationId, 1);
      expect(sent).toHaveLength(1);

      // Same job, second attempt.
      await dispatcher.dispatch(notificationId, 2);
      expect(sent).toHaveLength(1);

      const legs = await deliveryRows(notificationId);
      expect(legs).toHaveLength(1);
    });

    it('records provider_unavailable — never a false success — when FCM is unconfigured', async () => {
      const alice = await student();
      await setPreferences(alice, { push_enabled: true });
      await alice.agent
        .post(`${API_PREFIX}/notifications/push/devices`)
        .send({ token: 'unconfigured'.padEnd(40, 'x') })
        .expect(200);
      providerConfigured = false;

      const notificationId = await notify(alice.userId);
      await dispatcher.dispatch(notificationId);

      expect(sent).toHaveLength(0);
      expect((await deliveryRows(notificationId))[0]).toMatchObject({
        status: NotificationDeliveryStatus.PROVIDER_UNAVAILABLE,
      });
    });
  });

  /* ------------------------------------------------------------------ *
   * Settings contract
   * ------------------------------------------------------------------ */

  describe('GET/PUT /notification-settings', () => {
    it('returns channel preferences and no legacy guardian toggles', async () => {
      const alice = await student();
      const response = await alice.agent.get(`${API_PREFIX}/notification-settings`).expect(200);

      expect(response.body.data).toMatchObject({
        sms_enabled: true,
        email_enabled: false,
        push_enabled: false,
      });
      expect(response.body.data).not.toHaveProperty('notify_parent_on_attendance');
      expect(response.body.data).not.toHaveProperty('notify_on_purchase');
    });

    it('still accepts a legacy client payload without failing validation', async () => {
      const alice = await student();

      // Backward compatibility during rollout: a frontend build deployed before
      // this backend still PUTs the four removed names, and must not 400.
      await alice.agent
        .put(`${API_PREFIX}/notification-settings`)
        .send({
          sms_enabled: false,
          email_enabled: true,
          push_enabled: false,
          notify_parent_on_attendance: false,
          notify_parent_on_exam_grade: false,
          notify_parent_on_lesson_expiry: false,
          notify_on_purchase: false,
        })
        .expect(200);

      const preferences = await policy.resolve(alice.userId);
      expect(preferences[NotificationChannel.SMS]).toBe(false);
      expect(preferences[NotificationChannel.EMAIL]).toBe(true);
    });

    it('a student cannot change another user’s channel preferences', async () => {
      const [alice, bob] = [await student(), await student()];
      await setPreferences(bob, { sms_enabled: true });

      // The endpoint has no target-user parameter at all; whatever Alice sends
      // lands on Alice.
      await setPreferences(alice, { sms_enabled: false });

      expect((await policy.resolve(bob.userId))[NotificationChannel.SMS]).toBe(true);
      expect((await policy.resolve(alice.userId))[NotificationChannel.SMS]).toBe(false);
    });
  });

  /* ------------------------------------------------------------------ *
   * SMS + guardian event preferences
   * ------------------------------------------------------------------ */

  describe('SMS channel and guardian event preferences govern real guardian dispatch', () => {
    it('sms_enabled = true with an eligible guardian runs the SMS sender', async () => {
      const alice = await student();
      await verifiedGuardian(alice.userId, '+201000000101');
      await setPreferences(alice, { sms_enabled: true });

      await notifications.create({
        user_id: alice.userId,
        type: NotificationType.ATTENDANCE,
        title: 'Attendance marked',
        message: 'Attendance was recorded.',
      });

      expect(smsSpy).toHaveBeenCalledTimes(1);
      expect(smsSpy.mock.calls[0]?.[0]).toEqual([
        expect.objectContaining({ phone: '+201000000101' }),
      ]);
    });

    it('sms_enabled = false does NOT run the SMS sender', async () => {
      const alice = await student();
      await verifiedGuardian(alice.userId, '+201000000102');
      await setPreferences(alice, { sms_enabled: false });

      await notifications.create({
        user_id: alice.userId,
        type: NotificationType.ATTENDANCE,
        title: 'Attendance marked',
        message: 'Attendance was recorded.',
      });

      expect(smsSpy).not.toHaveBeenCalled();
    });

    it('guardian event ON dispatches; the same event OFF does not', async () => {
      const alice = await student();
      const guardianId = await verifiedGuardian(alice.userId, '+201000000103');
      await setPreferences(alice, { sms_enabled: true });

      await notifications.create({
        user_id: alice.userId,
        type: NotificationType.EXAM_RESULT,
        title: 'Exam graded',
        message: 'Your exam was graded.',
      });
      expect(smsSpy).toHaveBeenCalledTimes(1);

      // Switch the canonical, per-relationship preference off.
      smsSpy.mockClear();
      await guardians.updatePreferences(alice.userId, guardianId, {
        notification_preferences: { [ParentEventType.EXAM_GRADED]: false },
      });

      await notifications.create({
        user_id: alice.userId,
        type: NotificationType.EXAM_RESULT,
        title: 'Exam graded again',
        message: 'Your exam was re-graded.',
      });
      expect(smsSpy).not.toHaveBeenCalled();
    });

    it('guardian preferences are relationship-specific, not global', async () => {
      const alice = await student();
      const motherId = await verifiedGuardian(alice.userId, '+201000000104');
      const fatherId = await verifiedGuardian(alice.userId, '+201000000105');
      await setPreferences(alice, { sms_enabled: true });

      // The mother opts out of attendance; the father does not.
      await guardians.updatePreferences(alice.userId, motherId, {
        notification_preferences: { [ParentEventType.ATTENDANCE_MARKED]: false },
      });

      const targets = await guardians.findNotificationTargets(
        alice.userId,
        ParentEventType.ATTENDANCE_MARKED,
      );
      expect(targets.map((t) => t.guardian_id)).toEqual([fatherId]);

      await notifications.create({
        user_id: alice.userId,
        type: NotificationType.ATTENDANCE,
        title: 'Attendance marked',
        message: 'Attendance was recorded.',
      });

      expect(smsSpy.mock.calls[0]?.[0]).toEqual([
        expect.objectContaining({ phone: '+201000000105' }),
      ]);
      expect(motherId).not.toBe(fatherId);
    });

    it('a disabled channel overrides an otherwise eligible guardian event', async () => {
      const alice = await student();
      const guardianId = await verifiedGuardian(alice.userId, '+201000000106');
      // Event eligibility is explicitly ON …
      await guardians.updatePreferences(alice.userId, guardianId, {
        notification_preferences: { [ParentEventType.ATTENDANCE_MARKED]: true },
      });
      // … and the channel is OFF.
      await setPreferences(alice, { sms_enabled: false });

      await notifications.create({
        user_id: alice.userId,
        type: NotificationType.ATTENDANCE,
        title: 'Attendance marked',
        message: 'Attendance was recorded.',
      });

      expect(
        await guardians.findNotificationTargets(alice.userId, ParentEventType.ATTENDANCE_MARKED),
      ).toHaveLength(1);
      expect(smsSpy).not.toHaveBeenCalled();
    });

    it('an unverified guardian is still never contacted (existing rule preserved)', async () => {
      const alice = await student();
      await guardians.linkGuardian(alice.userId, { phone: '+201000000107' });
      await setPreferences(alice, { sms_enabled: true });

      await notifications.create({
        user_id: alice.userId,
        type: NotificationType.ATTENDANCE,
        title: 'Attendance marked',
        message: 'Attendance was recorded.',
      });

      expect(smsSpy).not.toHaveBeenCalled();
    });
  });

  /* ------------------------------------------------------------------ *
   * Cross-channel independence
   * ------------------------------------------------------------------ */

  it('channels are independent: SMS off does not suppress push, and vice versa', async () => {
    const alice = await student();
    await verifiedGuardian(alice.userId, '+201000000108');
    await alice.agent
      .post(`${API_PREFIX}/notifications/push/devices`)
      .send({ token: 'independent'.padEnd(40, 'x') })
      .expect(200);

    await setPreferences(alice, { sms_enabled: false, push_enabled: true });
    const attendance = await notifications.create({
      user_id: alice.userId,
      type: NotificationType.ATTENDANCE,
      title: 'Attendance marked',
      message: 'Attendance was recorded.',
    });
    await dispatcher.dispatch(attendance.id);

    expect(smsSpy).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);

    sent = [];
    smsSpy.mockClear();
    await setPreferences(alice, { sms_enabled: true, push_enabled: false });
    const second = await notifications.create({
      user_id: alice.userId,
      type: NotificationType.ATTENDANCE,
      title: 'Attendance marked again',
      message: 'Attendance was recorded again.',
    });
    await dispatcher.dispatch(second.id);

    expect(smsSpy).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(0);
  });

  it('device rows are scoped to the FCM provider enum used by the dispatcher', async () => {
    const alice = await student();
    await alice.agent
      .post(`${API_PREFIX}/notifications/push/devices`)
      .send({ token: 'provider-check'.padEnd(40, 'x'), provider: PushProviderName.FCM })
      .expect(200);

    const active = await devices.findActiveForUser(alice.userId, PushProviderName.FCM);
    expect(active).toHaveLength(1);
  });

  describe('multi-row fan-out keeps per-recipient push enforcement (T069)', () => {
    it('createMany persists one row per recipient and push still honours each recipient push_enabled', async () => {
      const alice = await student();
      const bob = await student();
      for (const [user, token] of [
        [alice, 'alice-many-token'],
        [bob, 'bob-many-token'],
      ] as const) {
        await user.agent
          .post(`${API_PREFIX}/notifications/push/devices`)
          .send({ token: token.padEnd(40, 'x') })
          .expect(200);
      }
      await setPreferences(alice, { push_enabled: true });
      await setPreferences(bob, { push_enabled: false });

      const outcomes = await notifications.createMany(
        [alice, bob].map((user) => ({
          user_id: user.userId,
          type: NotificationType.EXAM_ASSIGNED,
          title: 'New exam',
          message: 'Midterm',
          send_sms: false,
        })),
      );

      expect(outcomes).toHaveLength(2);
      expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
      const ids = outcomes.map((outcome) => (outcome.ok ? outcome.id : ''));
      const rows = (await dataSource.query(
        `SELECT id, user_id, title, status FROM notifications WHERE id = ANY($1::uuid[])`,
        [ids],
      )) as Array<{ id: string; user_id: string; title: string; status: string }>;
      expect(rows.map((row) => row.user_id).sort()).toEqual([alice.userId, bob.userId].sort());

      // Push is dispatched through the same policy chokepoint whichever transport queued it
      // (dispatch is idempotent per notification, so this is safe if it already ran inline).
      for (const id of ids) await dispatcher.dispatch(id);

      expect(sent.map((message) => message.token)).toEqual(['alice-many-token'.padEnd(40, 'x')]);
      const [aliceLegs, bobLegs] = await Promise.all(ids.map(async (id) => deliveryRows(id)));
      expect(aliceLegs?.[0]).toMatchObject({ status: NotificationDeliveryStatus.SENT });
      expect(bobLegs?.[0]).toMatchObject({ status: NotificationDeliveryStatus.SKIPPED_PREFERENCE });
    });
  });

});
