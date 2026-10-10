import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { maskSecret } from '../../common/utils/mask.util';
import { biBody } from '../../i18n/error-translator.util';
import { PushDevice, PushDeviceDisabledReason, PushPlatform, PushProviderName } from '../entities';
import { parseWebPushToken } from '../push/web-push.util';

export interface RegisterPushDeviceInput {
  userId: string;
  token: string;
  platform?: PushPlatform;
  provider?: PushProviderName;
  deviceId?: string;
  deviceLabel?: string;
}

/** API-safe projection. The registration token itself is never included. */
export interface PushDeviceView {
  id: string;
  provider: PushProviderName;
  platform: PushPlatform;
  device_id: string | null;
  device_label: string | null;
  enabled: boolean;
  last_seen_at: Date;
  created_at: Date;
}

/**
 * Ownership, lifecycle and hygiene for push registrations.
 *
 * Every method takes the acting `userId` from authentication — there is no
 * overload that accepts a target user id, so "register a token against someone
 * else's account" and "revoke someone else's device" are not expressible, not
 * merely rejected.
 *
 * Registration tokens are treated as secrets: possession of one is sufficient
 * to push to that handset. They are never logged in full and never leave the
 * server (see `PushDeviceView`).
 */
@Injectable()
export class PushDeviceService {
  private readonly logger = new Logger(PushDeviceService.name);

  constructor(
    @InjectRepository(PushDevice)
    private readonly devices: Repository<PushDevice>,
  ) {}

  /**
   * Register or refresh one device. Idempotent by construction.
   *
   * Three shapes of "the same device coming back" are handled, and they are
   * genuinely different situations:
   *
   *  1. **Same token, same user** — a page reload. Refresh `last_seen_at`,
   *     re-enable if a previous invalidation disabled it, clear the error trail.
   *  2. **Same token, different user** — a shared browser profile where someone
   *     else signed in. FCM hands out one token per install, so the row must
   *     move to the new owner; leaving it would keep pushing the previous
   *     user's notifications to a handset they no longer hold. This is a
   *     reassignment, not a duplicate.
   *  3. **Same (user, device_id), new token** — FCM rotated the token. Update
   *     the existing row rather than accumulate a dead one; the partial unique
   *     index on `(user_id, provider, device_id)` is what makes this findable.
   *
   * A user may hold any number of distinct devices; nothing here caps or
   * replaces them.
   */
  public async register(rawInput: RegisterPushDeviceInput): Promise<PushDevice> {
    const provider = rawInput.provider ?? PushProviderName.FCM;
    const input = { ...rawInput, token: this.normaliseToken(provider, rawInput.token) };
    const platform = input.platform ?? PushPlatform.WEB;
    const deviceId = input.deviceId ?? null;
    const now = new Date();

    const byToken = await this.devices.findOne({
      where: { provider, token: input.token },
    });

    if (byToken) {
      const reassigned = byToken.user_id !== input.userId;
      byToken.user_id = input.userId;
      byToken.platform = platform;
      byToken.device_id = deviceId ?? byToken.device_id;
      byToken.device_label = input.deviceLabel ?? byToken.device_label;
      byToken.enabled = true;
      byToken.revoked_at = null;
      byToken.disabled_reason = null;
      byToken.failure_count = 0;
      byToken.last_error = null;
      byToken.last_seen_at = now;

      // A reassigned row keeps its id but belongs to someone else now; any
      // duplicate row the new owner may already hold for the same device_id
      // must go, or the partial unique index would reject the save.
      if (reassigned && deviceId !== null) {
        await this.dropConflictingDeviceRow(input.userId, provider, deviceId, byToken.id);
      }

      const saved = await this.devices.save(byToken);
      this.logger.log(
        `Push device ${saved.id} ${reassigned ? 'reassigned to' : 'refreshed for'} ` +
          `user ${input.userId} (${maskSecret(input.token) ?? '***'})`,
      );
      return saved;
    }

    if (deviceId !== null) {
      const byDevice = await this.devices.findOne({
        where: { user_id: input.userId, provider, device_id: deviceId },
      });
      if (byDevice) {
        byDevice.token = input.token;
        byDevice.platform = platform;
        byDevice.device_label = input.deviceLabel ?? byDevice.device_label;
        byDevice.enabled = true;
        byDevice.revoked_at = null;
        byDevice.disabled_reason = null;
        byDevice.failure_count = 0;
        byDevice.last_error = null;
        byDevice.last_seen_at = now;
        const saved = await this.devices.save(byDevice);
        this.logger.log(`Push device ${saved.id} token rotated for user ${input.userId}`);
        return saved;
      }
    }

    const created = await this.devices.save(
      this.devices.create({
        user_id: input.userId,
        provider,
        token: input.token,
        platform,
        device_id: deviceId,
        device_label: input.deviceLabel ?? null,
        enabled: true,
        revoked_at: null,
        disabled_reason: null,
        last_seen_at: now,
        last_success_at: null,
        failure_count: 0,
        last_error: null,
      }),
    );
    this.logger.log(`Push device ${created.id} registered for user ${input.userId}`);
    return created;
  }

  /**
   * A Web Push token is a JSON subscription whose key order is up to the client; canonicalise it so
   * the same subscription can never be stored twice. Anything that is not a safe subscription
   * (including an endpoint on a non-push-service host, which would be an SSRF vector) is refused.
   */
  private normaliseToken(provider: PushProviderName, token: string): string {
    if (provider !== PushProviderName.WEBPUSH) return token;
    const subscription = parseWebPushToken(token);
    if (subscription === null) {
      throw new BadRequestException(
        biBody('Invalid push subscription', 'اشتراك الإشعارات غير صالح'),
      );
    }
    return JSON.stringify({
      endpoint: subscription.endpoint,
      keys: { auth: subscription.keys.auth, p256dh: subscription.keys.p256dh },
    });
  }

  /** Every device eligible to receive a push for this user. */
  public async findActiveForUser(
    userId: string,
    provider: PushProviderName = PushProviderName.FCM,
  ): Promise<PushDevice[]> {
    return await this.devices.find({
      where: { user_id: userId, provider, enabled: true },
      order: { last_seen_at: 'DESC', id: 'ASC' },
      // A person does not legitimately hold hundreds of handsets; the bound
      // stops a compromised or looping client from turning one notification
      // into an unbounded provider fan-out.
      take: 25,
    });
  }

  public async listForUser(userId: string): Promise<PushDeviceView[]> {
    const rows = await this.devices.find({
      where: { user_id: userId },
      order: { last_seen_at: 'DESC', id: 'ASC' },
      take: 50,
    });
    return rows.map((row) => PushDeviceService.toView(row));
  }

  /**
   * User-initiated revocation by row id. Scoped by `user_id` in the WHERE
   * clause, so another user's id simply does not match — the caller gets a 404,
   * and no cross-account probe is possible.
   */
  public async revokeById(userId: string, deviceRowId: string): Promise<void> {
    const device = await this.devices.findOne({ where: { id: deviceRowId, user_id: userId } });
    if (!device) {
      throw new NotFoundException(biBody('Push device not found', 'جهاز الإشعارات غير موجود'));
    }
    await this.disable(device.id, PushDeviceDisabledReason.USER_REVOKED);
  }

  /**
   * Revocation by token — the shape logout needs, where the client holds the
   * token but not the row id. Also scoped to the acting user.
   *
   * Returns whether anything was revoked so the client can distinguish "done"
   * from "there was nothing registered", without leaking whether that token
   * exists under a different account.
   */
  public async revokeByToken(
    userId: string,
    token: string,
    provider: PushProviderName = PushProviderName.FCM,
  ): Promise<boolean> {
    const device = await this.devices.findOne({ where: { provider, token, user_id: userId } });
    if (!device) return false;
    await this.disable(device.id, PushDeviceDisabledReason.USER_REVOKED);
    return true;
  }

  /**
   * Provider said this token is dead.
   *
   * Scoped to a single row id, which is the whole point: a multi-device user
   * losing one handset must not lose the others. Never called for a transient
   * failure — see `PERMANENT_TOKEN_ERRORS` in `FirebasePushProvider`.
   */
  public async invalidate(deviceRowId: string, reason: string): Promise<void> {
    await this.devices.update(deviceRowId, {
      enabled: false,
      revoked_at: new Date(),
      disabled_reason: PushDeviceDisabledReason.INVALID_TOKEN,
      last_error: reason.slice(0, 1000),
    });
    this.logger.log(`Push device ${deviceRowId} disabled: provider reported an invalid token`);
  }

  public async recordSuccess(deviceRowId: string): Promise<void> {
    await this.devices.update(deviceRowId, {
      last_success_at: new Date(),
      failure_count: 0,
      last_error: null,
    });
  }

  /** Transient failure: keep the device, remember why. */
  public async recordFailure(deviceRowId: string, reason: string): Promise<void> {
    await this.devices.increment({ id: deviceRowId }, 'failure_count', 1);
    await this.devices.update(deviceRowId, { last_error: reason.slice(0, 1000) });
  }

  public static toView(device: PushDevice): PushDeviceView {
    return {
      id: device.id,
      provider: device.provider,
      platform: device.platform,
      device_id: device.device_id,
      device_label: device.device_label,
      enabled: device.enabled,
      last_seen_at: device.last_seen_at,
      created_at: device.created_at,
    };
  }

  private async disable(deviceRowId: string, reason: PushDeviceDisabledReason): Promise<void> {
    await this.devices.update(deviceRowId, {
      enabled: false,
      revoked_at: new Date(),
      disabled_reason: reason,
    });
  }

  /**
   * Remove a stale row that would collide with a reassigned device on
   * `UQ_push_devices_user_device`. Only ever deletes a row already belonging to
   * the *new* owner — never one belonging to anybody else.
   */
  private async dropConflictingDeviceRow(
    userId: string,
    provider: PushProviderName,
    deviceId: string,
    keepRowId: string,
  ): Promise<void> {
    await this.devices
      .createQueryBuilder()
      .delete()
      .from(PushDevice)
      .where('user_id = :userId', { userId })
      .andWhere('provider = :provider', { provider })
      .andWhere('device_id = :deviceId', { deviceId })
      .andWhere('id != :keepRowId', { keepRowId })
      .execute();
  }
}
