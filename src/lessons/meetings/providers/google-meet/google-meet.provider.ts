import { BadRequestException, Injectable, InternalServerErrorException, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { biBody } from '../../../../i18n/error-translator.util';
import { MeetingProvider } from '../../../entities/meeting-provider.enum';
import type {
  CreateMeetingInput,
  CreateMeetingResult,
  MeetingAccountIdentity,
  MeetingProviderClient,
  MeetingProviderConfigurationStatus,
  MeetingTokenSet,
} from '../meeting-provider.interface';
import {
  buildCalendarEventBody,
  parseGoogleCalendarEvent,
  parseGoogleTokenResponse,
  parseGoogleUserInfo,
} from './google-meet.mapper';
import type { GoogleCalendarEventResponse, GoogleTokenResponse, GoogleUserInfoResponse } from './google-meet.types';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const CALENDAR_EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
];
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * First concrete `MeetingProviderClient` (Phase 4). Consumer Gmail accounts
 * work out of the box, which is why Google Meet ships before Zoom/Teams (see
 * R-1/R-2 — those need marketplace publishing / work accounts). Mirrors
 * `PaymobGateway`'s plain-`fetch` + `AbortSignal.timeout` style rather than
 * pulling in `@nestjs/axios`.
 */
@Injectable()
export class GoogleMeetProvider implements MeetingProviderClient {
  public readonly name = MeetingProvider.GOOGLE_MEET;

  private readonly logger = new Logger(GoogleMeetProvider.name);
  private readonly clientId: string;
  private readonly clientSecret: string;

  public constructor(private readonly config: ConfigService) {
    this.clientId = this.config.get<string>('GOOGLE_MEET_CLIENT_ID') ?? '';
    this.clientSecret = this.config.get<string>('GOOGLE_MEET_CLIENT_SECRET') ?? '';
  }

  public isConfigured(): boolean {
    return this.clientId !== '' && this.clientSecret !== '';
  }

  public getConfigurationStatus(): MeetingProviderConfigurationStatus {
    return {
      enabled: this.clientId !== '' || this.clientSecret !== '',
      configured: this.isConfigured(),
    };
  }

  public buildAuthorizeUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      // offline + consent guarantee a refresh token on THIS grant — Google
      // otherwise omits it on a returning user's silent re-consent, which is
      // exactly the failure this class turns into a clear reconnect error.
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      scope: SCOPES.join(' '),
      state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  public async exchangeCode(code: string, redirectUri: string): Promise<MeetingTokenSet & MeetingAccountIdentity> {
    this.assertConfigured();
    const data = await this.postToken(
      {
        code,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      },
      'token exchange',
    );
    const tokens = parseGoogleTokenResponse(data);
    if (!tokens.refreshToken) {
      throw new BadRequestException(
        biBody(
          'Google did not grant offline access — please reconnect and approve all permissions',
          'لم يمنح جوجل صلاحية الوصول دون اتصال — الرجاء إعادة الربط والموافقة على كل الأذونات',
        ),
      );
    }
    const identity = await this.fetchIdentity(tokens.accessToken);
    return { ...tokens, ...identity };
  }

  /** Google does NOT rotate the refresh token — an absent one here means "unchanged", not "revoked". */
  public async refresh(refreshToken: string): Promise<MeetingTokenSet> {
    this.assertConfigured();
    const data = await this.postToken(
      {
        refresh_token: refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'refresh_token',
      },
      'token refresh',
    );
    return parseGoogleTokenResponse(data);
  }

  public async revoke(tokens: { accessToken: string; refreshToken?: string | null }): Promise<void> {
    const token = tokens.refreshToken ?? tokens.accessToken;
    if (!token) return;
    try {
      await this.request(
        `${REVOKE_URL}?token=${encodeURIComponent(token)}`,
        { method: 'POST' },
        'token revoke',
      );
    } catch (error) {
      // Best-effort (R-18): the local disconnect must proceed regardless.
      this.logger.warn(`Google Meet token revoke failed: ${this.errorMessage(error)}`);
    }
  }

  public async createMeeting(input: CreateMeetingInput): Promise<CreateMeetingResult> {
    this.assertConfigured();
    const response = await this.request(
      `${CALENDAR_EVENTS_URL}?conferenceDataVersion=1`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.accessToken}` },
        body: JSON.stringify(buildCalendarEventBody(input)),
      },
      'meeting creation',
    );
    const data = (await response.json()) as GoogleCalendarEventResponse;
    return parseGoogleCalendarEvent(data);
  }

  public async deleteMeeting(accessToken: string, externalId: string): Promise<void> {
    try {
      await this.request(
        `${CALENDAR_EVENTS_URL}/${encodeURIComponent(externalId)}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } },
        'meeting deletion',
      );
    } catch (error) {
      // Best-effort: an already-deleted/inaccessible event must not block the
      // caller (e.g. the idempotency-loser cleanup path introduced in Phase 5).
      this.logger.warn(`Google Meet event deletion failed: ${this.errorMessage(error)}`);
    }
  }

  private async fetchIdentity(accessToken: string): Promise<MeetingAccountIdentity> {
    const response = await this.request(
      USERINFO_URL,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      'account identity lookup',
    );
    const data = (await response.json()) as GoogleUserInfoResponse;
    return parseGoogleUserInfo(data);
  }

  private async postToken(params: Record<string, string>, operation: string): Promise<GoogleTokenResponse> {
    let response: Response;
    try {
      response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw this.unavailable(`${operation} endpoint was unreachable`);
    }
    const data = (await response.json().catch(() => ({}))) as GoogleTokenResponse;
    if (!response.ok) {
      // `invalid_grant` is Google's signal that the refresh token was revoked
      // or expired at the provider — distinct from a transient failure, and
      // surfaced as a reconnect-required error so callers (getUsableAccount)
      // can mark the account `revoked` rather than merely `expired`.
      if (data.error === 'invalid_grant') {
        throw new UnauthorizedException(
          biBody('This meeting account needs to be reconnected', 'يجب إعادة ربط حساب الاجتماعات هذا'),
        );
      }
      this.logger.error(`Google Meet ${operation} failed: ${JSON.stringify(data).slice(0, 500)}`);
      throw this.unavailable(`${operation} failed`);
    }
    return data;
  }

  private async request(url: string, init: RequestInit, operation: string): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      throw this.unavailable(`${operation} endpoint was unreachable`);
    }
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      this.logger.error(`Google Meet ${operation} failed with status ${String(response.status)}: ${bodyText.slice(0, 500)}`);
      if (response.status === 401) {
        throw new UnauthorizedException(
          biBody('This meeting account needs to be reconnected', 'يجب إعادة ربط حساب الاجتماعات هذا'),
        );
      }
      throw this.unavailable(`${operation} failed`);
    }
    return response;
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) throw this.unavailable('configuration is incomplete');
  }

  private unavailable(reason: string): InternalServerErrorException {
    this.logger.error(`Google Meet provider unavailable: ${reason}`);
    return new InternalServerErrorException(
      biBody('This meeting provider is not available', 'مزود الاجتماعات هذا غير متاح'),
    );
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'unknown error';
  }
}
