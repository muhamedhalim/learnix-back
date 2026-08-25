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
import { buildTeamsMeetingBody, parseMicrosoftTokenResponse, parseMicrosoftUserInfo, parseTeamsMeeting } from './microsoft-teams.mapper';
import type { MicrosoftOnlineMeetingResponse, MicrosoftTokenResponse, MicrosoftUserInfoResponse } from './microsoft-teams.types';

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';
const USERINFO_URL = `${GRAPH_BASE_URL}/me`;
const MEETINGS_URL = `${GRAPH_BASE_URL}/me/onlineMeetings`;
// `offline_access` is what actually earns a refresh token; the other two are
// the Graph permissions the meeting flow needs.
const SCOPES = [
  'https://graph.microsoft.com/OnlineMeetings.ReadWrite',
  'https://graph.microsoft.com/User.Read',
  'offline_access',
];
const REQUEST_TIMEOUT_MS = 15_000;

function meetingUrl(externalId: string): string {
  return `${MEETINGS_URL}/${encodeURIComponent(externalId)}`;
}

/**
 * Third and final concrete `MeetingProviderClient` (Phase 7). Only this file
 * and its mapper/types + one registry-factory line are new — the lesson and
 * booking domain is untouched, per the plan's provider-layer-only phases.
 *
 * **Work/school accounts only (R-2).** Graph `POST /me/onlineMeetings`
 * rejects personal Microsoft accounts, and the signed-in user needs a Teams
 * licence. If Learnix's teacher population is mostly independent tutors on
 * personal accounts, this provider may be unusable for them in practice —
 * confirmed out of this codebase's control.
 *
 * Endpoints are tenant-scoped (`MS_TEAMS_TENANT`), unlike Google/Zoom's
 * fixed hosts — `isConfigured()` requires all three env vars.
 *
 * Microsoft exposes no public single-token revoke endpoint for this grant
 * type (unlike Google's `/revoke` or Zoom's `/oauth/revoke`) — `revoke()` is
 * a deliberate no-op; `MeetingAccountsService.disconnect()` already deletes
 * the locally stored tokens regardless (R-18).
 */
@Injectable()
export class MicrosoftTeamsProvider implements MeetingProviderClient {
  public readonly name = MeetingProvider.MICROSOFT_TEAMS;

  private readonly logger = new Logger(MicrosoftTeamsProvider.name);
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly tenant: string;

  public constructor(private readonly config: ConfigService) {
    this.clientId = this.config.get<string>('MS_TEAMS_CLIENT_ID') ?? '';
    this.clientSecret = this.config.get<string>('MS_TEAMS_CLIENT_SECRET') ?? '';
    this.tenant = this.config.get<string>('MS_TEAMS_TENANT') ?? '';
  }

  public isConfigured(): boolean {
    return this.clientId !== '' && this.clientSecret !== '' && this.tenant !== '';
  }

  public getConfigurationStatus(): MeetingProviderConfigurationStatus {
    return {
      enabled: this.clientId !== '' || this.clientSecret !== '' || this.tenant !== '',
      configured: this.isConfigured(),
    };
  }

  public buildAuthorizeUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      response_type: 'code',
      response_mode: 'query',
      client_id: this.clientId,
      redirect_uri: redirectUri,
      scope: SCOPES.join(' '),
      state,
    });
    return `${this.authorizeUrl()}?${params.toString()}`;
  }

  public async exchangeCode(code: string, redirectUri: string): Promise<MeetingTokenSet & MeetingAccountIdentity> {
    this.assertConfigured();
    const data = await this.postToken(
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        scope: SCOPES.join(' '),
      },
      'token exchange',
    );
    const tokens = parseMicrosoftTokenResponse(data);
    if (!tokens.refreshToken) {
      throw new BadRequestException(
        biBody(
          'Microsoft did not grant offline access — please reconnect and approve all permissions',
          'لم يمنح مايكروسوفت صلاحية الوصول دون اتصال — الرجاء إعادة الربط والموافقة على كل الأذونات',
        ),
      );
    }
    const identity = await this.fetchIdentity(tokens.accessToken);
    return { ...tokens, ...identity };
  }

  /** Microsoft does NOT guarantee refresh-token rotation — an absent one here means "unchanged", not "revoked". */
  public async refresh(refreshToken: string): Promise<MeetingTokenSet> {
    this.assertConfigured();
    const data = await this.postToken(
      {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        scope: SCOPES.join(' '),
      },
      'token refresh',
    );
    return parseMicrosoftTokenResponse(data);
  }

  /** No-op — see class doc comment. */
  public revoke(): Promise<void> {
    this.logger.debug('Microsoft Teams has no per-grant revoke endpoint — relying on local token deletion only.');
    return Promise.resolve();
  }

  public async createMeeting(input: CreateMeetingInput): Promise<CreateMeetingResult> {
    this.assertConfigured();
    const response = await this.request(
      MEETINGS_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.accessToken}` },
        body: JSON.stringify(buildTeamsMeetingBody(input)),
      },
      'meeting creation',
    );
    const data = (await response.json()) as MicrosoftOnlineMeetingResponse;
    return parseTeamsMeeting(data);
  }

  public async deleteMeeting(accessToken: string, externalId: string): Promise<void> {
    try {
      await this.request(
        meetingUrl(externalId),
        { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } },
        'meeting deletion',
      );
    } catch (error) {
      // Best-effort: an already-deleted/inaccessible meeting must not block
      // the caller (e.g. the idempotency-loser cleanup path from Phase 5).
      this.logger.warn(`Microsoft Teams meeting deletion failed: ${this.errorMessage(error)}`);
    }
  }

  private async fetchIdentity(accessToken: string): Promise<MeetingAccountIdentity> {
    const response = await this.request(
      USERINFO_URL,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      'account identity lookup',
    );
    const data = (await response.json()) as MicrosoftUserInfoResponse;
    return parseMicrosoftUserInfo(data);
  }

  private authorizeUrl(): string {
    return `https://login.microsoftonline.com/${encodeURIComponent(this.tenant)}/oauth2/v2.0/authorize`;
  }

  private tokenUrl(): string {
    return `https://login.microsoftonline.com/${encodeURIComponent(this.tenant)}/oauth2/v2.0/token`;
  }

  private async postToken(params: Record<string, string>, operation: string): Promise<MicrosoftTokenResponse> {
    let response: Response;
    try {
      response = await fetch(this.tokenUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw this.unavailable(`${operation} endpoint was unreachable`);
    }
    const data = (await response.json().catch(() => ({}))) as MicrosoftTokenResponse;
    if (!response.ok) {
      // `invalid_grant` (AADSTS70008/AADSTS700082) signals the refresh token
      // was revoked, expired, or already consumed — surfaced as
      // reconnect-required so `getUsableAccount` marks the account `revoked`
      // rather than merely `expired`.
      if (data.error === 'invalid_grant') {
        throw new UnauthorizedException(
          biBody('This meeting account needs to be reconnected', 'يجب إعادة ربط حساب الاجتماعات هذا'),
        );
      }
      this.logger.error(`Microsoft Teams ${operation} failed: ${JSON.stringify(data).slice(0, 500)}`);
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
      this.logger.error(
        `Microsoft Teams ${operation} failed with status ${String(response.status)}: ${bodyText.slice(0, 500)}`,
      );
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
    this.logger.error(`Microsoft Teams provider unavailable: ${reason}`);
    return new InternalServerErrorException(
      biBody('This meeting provider is not available', 'مزود الاجتماعات هذا غير متاح'),
    );
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'unknown error';
  }
}
