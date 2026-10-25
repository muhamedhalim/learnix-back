import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import { CACHE_MANAGER } from '@nestjs/cache-manager';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';

import type { Cache } from 'cache-manager';
import { MoreThan, Repository } from 'typeorm';

import { biBody } from '../../i18n/error-translator.util';
import {
  buildAbsoluteUrl,
  getConfiguredPublicOrigin,
  parsePublicOrigin,
} from '../../config/public-url.util';
import { isMeetingEncryptionKeyUsable } from '../../common/utils/secret-box.util';
import { MeetingCreationStatus } from '../entities/meeting-creation-status.enum';
import { MeetingProvider } from '../entities/meeting-provider.enum';
import { ScheduledLessonSession } from '../entities/scheduled-lesson-session.entity';
import { TeacherMeetingAccount } from '../entities/teacher-meeting-account.entity';
import { TeacherMeetingAccountStatus } from '../entities/teacher-meeting-account-status.enum';
import { MeetingProviderRegistry } from './meeting-provider-registry.service';
import { RetryableProviderError } from './providers/provider-errors';

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

const STATE_TTL_MS = 10 * 60 * 1000;
const OAUTH_STATE_CACHE_PREFIX = 'meeting-oauth-state:';

interface OAuthStatePayload {
  teacherId: string;
  provider: MeetingProvider;
  nonce: string;
  exp: number;
  /** UI locale of the teacher who started the flow, so the callback lands them back in it. */
  locale?: string;
}

export interface MeetingAccountSummary {
  provider: MeetingProvider;
  connected: boolean;
  status: TeacherMeetingAccountStatus | null;
  accountEmail: string | null;
  displayName: string | null;
  lastVerifiedAt: Date | null;
}

/**
 * Per-teacher OAuth connections. `MANUAL` never appears here — it is the
 * pre-existing hand-typed URL path (AD-10), not a connectable account.
 */
@Injectable()
export class MeetingAccountsService {
  public constructor(
    @InjectRepository(TeacherMeetingAccount)
    private readonly accounts: Repository<TeacherMeetingAccount>,
    private readonly registry: MeetingProviderRegistry,
    private readonly configService: ConfigService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  private stateSecret(): string {
    // Reuses JWT_SECRET rather than introducing a second signing key — this
    // token authorizes nothing beyond "resume this specific OAuth handshake".
    const secret = this.configService.get<string>('JWT_SECRET');
    if (!secret) {
      throw new Error('JWT_SECRET is not configured — cannot sign an OAuth state token.');
    }
    return secret;
  }

  private signState(payload: OAuthStatePayload): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', this.stateSecret()).update(body).digest('base64url');
    return `${body}.${signature}`;
  }

  private verifyState(token: string): OAuthStatePayload {
    const [body, signature] = token.split('.');
    if (!body || !signature) {
      throw new BadRequestException(
        biBody('Invalid connection request', 'طلب ربط الحساب غير صالح'),
      );
    }
    const expectedSignature = createHmac('sha256', this.stateSecret())
      .update(body)
      .digest('base64url');
    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);
    if (
      signatureBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(signatureBuffer, expectedBuffer)
    ) {
      throw new BadRequestException(
        biBody('Invalid connection request', 'طلب ربط الحساب غير صالح'),
      );
    }
    let payload: OAuthStatePayload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OAuthStatePayload;
    } catch {
      throw new BadRequestException(
        biBody('Invalid connection request', 'طلب ربط الحساب غير صالح'),
      );
    }
    if (payload.exp < Date.now()) {
      throw new BadRequestException(
        biBody(
          'This connection request has expired — please try again',
          'انتهت صلاحية طلب الربط — حاول مرة أخرى',
        ),
      );
    }
    return payload;
  }

  /**
   * Config only, never a request parameter (R-9 SSRF hardening — mirrors
   * `validateEasyKashBaseUrl`/`public-url.util.ts`). `MEETING_OAUTH_REDIRECT_BASE_URL`
   * is optional but, when set, is validated exactly like every other public
   * origin (`parsePublicOrigin`) rather than concatenated raw, so a malformed
   * value fails at the OAuth handshake instead of quietly producing a broken
   * or unsafe callback URL. Falling back to `BACKEND_URL` reuses a value
   * `validateProductionPublicOrigins` already guarantees is a valid public
   * HTTPS origin in production.
   */
  private redirectUri(): string {
    const production = this.configService.get<string>('NODE_ENV') === 'production';
    const override = this.configService.get<string>('MEETING_OAUTH_REDIRECT_BASE_URL');
    const base =
      override && override.trim() !== ''
        ? parsePublicOrigin(override, 'MEETING_OAUTH_REDIRECT_BASE_URL', production)
        : getConfiguredPublicOrigin(
            (key) => this.configService.get<string>(key),
            'BACKEND_URL',
            'http://localhost:3001',
          );
    return buildAbsoluteUrl(base, 'api/v1/teacher/meeting-accounts/callback');
  }

  /**
   * Returns the authorize URL the teacher's browser should be sent to, plus the
   * handshake `nonce`. The caller MUST bind the nonce to the initiating browser
   * (a signed HttpOnly cookie) and hand it back to `completeConnect`: `state`
   * alone only proves which teacher started the flow, not which browser is
   * finishing it, so a captured authorize URL opened by a victim would
   * otherwise link the VICTIM's provider account to the attacker's teacher.
   */
  public startConnect(
    teacherId: string,
    provider: MeetingProvider,
    locale?: string,
  ): { authorizeUrl: string; nonce: string } {
    const client = this.registry.find(provider);
    if (!client || !client.isConfigured() || !isMeetingEncryptionKeyUsable()) {
      throw new NotFoundException(
        biBody('This meeting provider is not available', 'مزود الاجتماعات هذا غير متاح'),
      );
    }
    const nonce = randomUUID();
    const state = this.signState({
      teacherId,
      provider,
      nonce,
      exp: Date.now() + STATE_TTL_MS,
      ...(locale ? { locale } : {}),
    });
    return { authorizeUrl: client.buildAuthorizeUrl(state, this.redirectUri()), nonce };
  }

  /**
   * The locale signed into `state`, for building the post-callback redirect.
   * Read-only (does not consume the nonce); undefined for a forged/expired state.
   */
  public localeFromState(state: string): string | undefined {
    try {
      return this.verifyState(state).locale;
    } catch {
      return undefined;
    }
  }

  /** Completes the OAuth handshake and persists (or refreshes) the connection. */
  public async completeConnect(
    state: string,
    code: string,
    browserNonce: string | undefined,
  ): Promise<MeetingAccountSummary> {
    const payload = this.verifyState(state);
    // Browser binding: the nonce cookie set when THIS browser called connect
    // must match the one signed into `state`. Checked before the single-use
    // nonce is consumed so a foreign browser cannot burn the owner's handshake.
    if (!browserNonce || !safeEqual(browserNonce, payload.nonce)) {
      throw new BadRequestException({
        ...biBody('Invalid connection request', 'طلب ربط الحساب غير صالح'),
        code: 'MEETING_OAUTH_BINDING',
      });
    }
    const nonceKey = `${OAUTH_STATE_CACHE_PREFIX}${payload.nonce}`;
    const alreadyUsed = await this.cache.get(nonceKey);
    if (alreadyUsed) {
      throw new ConflictException(
        biBody('This connection request was already used', 'تم استخدام طلب الربط هذا بالفعل'),
      );
    }
    await this.cache.set(nonceKey, true, Math.max(1000, payload.exp - Date.now()));

    const client = this.registry.find(payload.provider);
    if (!client || !client.isConfigured()) {
      throw new NotFoundException(
        biBody('This meeting provider is not available', 'مزود الاجتماعات هذا غير متاح'),
      );
    }
    const tokens = await client.exchangeCode(code, this.redirectUri());

    const existing = await this.accounts.findOne({
      where: { teacher_id: payload.teacherId, provider: payload.provider },
    });
    // Reconnecting a DIFFERENT provider account would strand every live meeting
    // on the old one (later deletes/updates would run with the new token and
    // fail). Make the teacher remove those meetings first.
    if (
      existing?.provider_account_id &&
      existing.provider_account_id !== tokens.providerAccountId &&
      (await this.hasLiveMeetings(payload.teacherId, payload.provider))
    ) {
      throw new ConflictException({
        ...biBody(
          'Remove your upcoming meetings from the previous account before connecting a different one',
          'أزل اجتماعاتك القادمة من الحساب السابق قبل ربط حساب مختلف',
        ),
        code: 'MEETING_ACCOUNT_MISMATCH',
      });
    }
    const record =
      existing ??
      this.accounts.create({ teacher_id: payload.teacherId, provider: payload.provider });
    record.provider_account_id = tokens.providerAccountId;
    record.provider_account_email = tokens.providerAccountEmail;
    record.display_name = tokens.displayName;
    record.access_token_encrypted = tokens.accessToken;
    record.refresh_token_encrypted = tokens.refreshToken ?? record.refresh_token_encrypted ?? null;
    record.token_expires_at = tokens.expiresAt;
    record.scopes = tokens.scopes;
    record.status = TeacherMeetingAccountStatus.CONNECTED;
    record.last_verified_at = new Date();
    record.last_error = null;
    const saved = await this.accounts.save(record);
    return this.toSummary(saved);
  }

  /** The teacher's CONNECTED account for a provider, or null — used to resolve precondition 5 of meeting generation. */
  public async findConnectedAccount(
    teacherId: string,
    provider: MeetingProvider,
  ): Promise<TeacherMeetingAccount | null> {
    return await this.accounts.findOne({
      where: { teacher_id: teacherId, provider, status: TeacherMeetingAccountStatus.CONNECTED },
    });
  }

  public async list(teacherId: string): Promise<MeetingAccountSummary[]> {
    const accounts = await this.accounts.find({ where: { teacher_id: teacherId } });
    const byProvider = new Map(accounts.map((account) => [account.provider, account]));
    return this.registry.list().map((entry) => {
      const account = byProvider.get(entry.provider);
      return account
        ? this.toSummary(account)
        : {
            provider: entry.provider,
            connected: false,
            status: null,
            accountEmail: null,
            displayName: null,
            lastVerifiedAt: null,
          };
    });
  }

  public async disconnect(teacherId: string, provider: MeetingProvider): Promise<void> {
    const account = await this.accounts.findOne({ where: { teacher_id: teacherId, provider } });
    if (!account) {
      throw new NotFoundException(
        biBody('No connected account for this provider', 'لا يوجد حساب مرتبط لهذا المزود'),
      );
    }
    const client = this.registry.find(provider);
    if (client && account.access_token_encrypted) {
      try {
        await client.revoke({
          accessToken: account.access_token_encrypted,
          refreshToken: account.refresh_token_encrypted,
        });
      } catch {
        // Best-effort: the provider-side revoke failing must not block the
        // teacher from disconnecting locally (R-18 — future meetings for
        // already-`ready` slots are preserved regardless of this call).
      }
    }
    // Future `ready` meetings are preserved (R-18) — only the connection
    // itself, and the ability to generate NEW meetings, is removed.
    account.status = TeacherMeetingAccountStatus.DISCONNECTED;
    account.access_token_encrypted = null;
    account.refresh_token_encrypted = null;
    await this.accounts.save(account);
  }

  /** Returns a usable access token for provisioning, proactively refreshing an expiring one. */
  public async getUsableAccount(
    teacherId: string,
    provider: MeetingProvider,
  ): Promise<TeacherMeetingAccount | null> {
    const account = await this.accounts.findOne({ where: { teacher_id: teacherId, provider } });
    if (!account || account.status !== TeacherMeetingAccountStatus.CONNECTED) return null;
    if (!this.isExpiringSoon(account)) return account;
    return await this.refreshUnderLock(teacherId, provider);
  }

  private isExpiringSoon(account: TeacherMeetingAccount): boolean {
    return !!account.token_expires_at && account.token_expires_at.getTime() - Date.now() < 60_000;
  }

  /**
   * Refreshes under a row lock. Zoom's refresh tokens are single-use: two
   * concurrent refreshes (worker concurrency, the clear path, a sweep) would
   * make the loser fail with `invalid_grant` and wrongly mark a healthy
   * account REVOKED. The second caller blocks on the lock, re-reads the row,
   * and finds the token already refreshed.
   */
  private async refreshUnderLock(
    teacherId: string,
    provider: MeetingProvider,
  ): Promise<TeacherMeetingAccount | null> {
    return await this.accounts.manager.transaction(async (manager) => {
      const account = await manager.findOne(TeacherMeetingAccount, {
        where: { teacher_id: teacherId, provider },
        lock: { mode: 'pessimistic_write' },
      });
      if (!account || account.status !== TeacherMeetingAccountStatus.CONNECTED) return null;
      if (!this.isExpiringSoon(account)) return account;

      const client = this.registry.find(provider);
      if (!client || !account.refresh_token_encrypted) {
        account.status = TeacherMeetingAccountStatus.EXPIRED;
        await manager.save(account);
        return null;
      }
      try {
        const refreshed = await client.refresh(account.refresh_token_encrypted);
        account.access_token_encrypted = refreshed.accessToken;
        // Some providers (e.g. Zoom) rotate the refresh token on every use — the
        // new one MUST be persisted here or the connection is permanently bricked.
        if (refreshed.refreshToken) account.refresh_token_encrypted = refreshed.refreshToken;
        account.token_expires_at = refreshed.expiresAt;
        account.last_verified_at = new Date();
        account.last_error = null;
        return await manager.save(account);
      } catch (error) {
        // A transient provider failure (timeout, 429, 5xx) says nothing about the
        // grant: leave the account CONNECTED and let the caller retry later.
        if (error instanceof RetryableProviderError) throw error;
        // A provider signalling "reconnect required" (e.g. Google's
        // invalid_grant) means the teacher revoked access at the provider —
        // distinct from a merely-expired token, which is an ordinary retry
        // candidate. Any other failure is treated as expired, not revoked.
        account.status =
          error instanceof UnauthorizedException
            ? TeacherMeetingAccountStatus.REVOKED
            : TeacherMeetingAccountStatus.EXPIRED;
        account.last_error = error instanceof Error ? error.message : 'Token refresh failed';
        await manager.save(account);
        return null;
      }
    });
  }

  private async hasLiveMeetings(teacherId: string, provider: MeetingProvider): Promise<boolean> {
    const live = await this.accounts.manager.count(ScheduledLessonSession, {
      where: {
        teacher_id: teacherId,
        meeting_provider: provider,
        meeting_status: MeetingCreationStatus.READY,
        start_at: MoreThan(new Date()),
      },
    });
    return live > 0;
  }

  /**
   * The provider told us (webhook) the teacher removed the app on their side.
   * Idempotent: unknown accounts and repeated events are no-ops.
   */
  public async markRevokedByProviderAccount(
    provider: MeetingProvider,
    providerAccountId: string,
  ): Promise<number> {
    const rows = await this.accounts.find({
      where: { provider, provider_account_id: providerAccountId },
    });
    for (const row of rows) {
      row.status = TeacherMeetingAccountStatus.REVOKED;
      row.access_token_encrypted = null;
      row.refresh_token_encrypted = null;
      row.last_error = 'Access was removed at the provider';
      await this.accounts.save(row);
    }
    return rows.length;
  }

  private toSummary(account: TeacherMeetingAccount): MeetingAccountSummary {
    return {
      provider: account.provider,
      connected: account.status === TeacherMeetingAccountStatus.CONNECTED,
      status: account.status,
      accountEmail: account.provider_account_email,
      displayName: account.display_name,
      lastVerifiedAt: account.last_verified_at,
    };
  }
}
