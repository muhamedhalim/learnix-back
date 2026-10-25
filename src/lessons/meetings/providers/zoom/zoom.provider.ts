import { Injectable, InternalServerErrorException, Logger, UnauthorizedException } from '@nestjs/common';
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
  UpdateMeetingInput,
} from '../meeting-provider.interface';
import { isRetryableStatus, parseRetryAfter, RetryableProviderError } from '../provider-errors';
import {
  buildZoomMeetingBody,
  buildZoomUpdateBody,
  parseZoomMeeting,
  parseZoomTokenResponse,
  parseZoomUserInfo,
} from './zoom.mapper';
import type { ZoomMeetingResponse, ZoomTokenResponse, ZoomUserInfoResponse } from './zoom.types';

const AUTH_URL = 'https://zoom.us/oauth/authorize';
const TOKEN_URL = 'https://zoom.us/oauth/token';
const REVOKE_URL = 'https://zoom.us/oauth/revoke';
const USERINFO_URL = 'https://api.zoom.us/v2/users/me';
const MEETINGS_URL = 'https://api.zoom.us/v2/users/me/meetings';
const REQUEST_TIMEOUT_MS = 15_000;

function meetingUrl(externalId: string): string {
  return `https://api.zoom.us/v2/meetings/${encodeURIComponent(externalId)}`;
}

/**
 * Second concrete `MeetingProviderClient` (Phase 6). Only this file and its
 * mapper/types + one registry-factory line are new — the lesson and booking
 * domain is untouched (Phase 6 is provider-layer only, per the plan).
 *
 * Two Zoom-specific gotchas, both already anticipated by the provider-agnostic
 * `MeetingAccountsService.getUsableAccount` (see that file):
 * - **Refresh tokens are single-use and rotate on every refresh** — a
 *   response missing a new one is treated as malformed, not "unchanged"
 *   (contrast `GoogleMeetProvider.refresh`).
 * - Scopes (`meeting:write:meeting`, `user:read:user`) are declared on the
 *   Zoom Marketplace "General (OAuth)" app itself, not passed as an
 *   authorize-URL query param the way Google's are.
 *
 * Distribution gate (R-1): the app must be **published** on the Zoom
 * Marketplace to exceed the ~100-user development allowlist — an external
 * process outside this codebase.
 */
@Injectable()
export class ZoomProvider implements MeetingProviderClient {
  public readonly name = MeetingProvider.ZOOM;

  private readonly logger = new Logger(ZoomProvider.name);
  private readonly clientId: string;
  private readonly clientSecret: string;

  public constructor(private readonly config: ConfigService) {
    this.clientId = this.config.get<string>('ZOOM_CLIENT_ID') ?? '';
    this.clientSecret = this.config.get<string>('ZOOM_CLIENT_SECRET') ?? '';
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
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: redirectUri,
      state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  public async exchangeCode(code: string, redirectUri: string): Promise<MeetingTokenSet & MeetingAccountIdentity> {
    this.assertConfigured();
    const data = await this.postToken(
      { grant_type: 'authorization_code', code, redirect_uri: redirectUri },
      'token exchange',
    );
    const tokens = parseZoomTokenResponse(data);
    const identity = await this.fetchIdentity(tokens.accessToken);
    return { ...tokens, ...identity };
  }

  /** Zoom always issues a NEW refresh token here — the caller must persist it or the connection is permanently bricked. */
  public async refresh(refreshToken: string): Promise<MeetingTokenSet> {
    this.assertConfigured();
    const data = await this.postToken({ grant_type: 'refresh_token', refresh_token: refreshToken }, 'token refresh');
    return parseZoomTokenResponse(data);
  }

  public async revoke(tokens: { accessToken: string; refreshToken?: string | null }): Promise<void> {
    const token = tokens.refreshToken ?? tokens.accessToken;
    if (!token) return;
    try {
      await this.request(
        REVOKE_URL,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: this.basicAuthHeader(),
          },
          body: new URLSearchParams({ token }).toString(),
        },
        'token revoke',
      );
    } catch (error) {
      // Best-effort (R-18): the local disconnect must proceed regardless.
      this.logger.warn(`Zoom token revoke failed: ${this.errorMessage(error)}`);
    }
  }

  public async createMeeting(input: CreateMeetingInput): Promise<CreateMeetingResult> {
    this.assertConfigured();
    let response: Response;
    try {
      response = await this.request(
        MEETINGS_URL,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.accessToken}` },
          body: JSON.stringify(buildZoomMeetingBody(input)),
        },
        'meeting creation',
      );
    } catch (error) {
      // Zoom has no idempotency key (R-15): after a timeout or 5xx the meeting
      // may already exist, so an automatic retry could orphan a duplicate. Only
      // a 429 (request rejected before processing) is safe to retry unattended.
      if (error instanceof RetryableProviderError && error.statusCode !== 429) {
        throw this.unavailable(`meeting creation failed (${error.message})`);
      }
      throw error;
    }
    const data = (await response.json()) as ZoomMeetingResponse;
    return parseZoomMeeting(data);
  }

  public async updateMeeting(accessToken: string, externalId: string, input: UpdateMeetingInput): Promise<void> {
    this.assertConfigured();
    await this.request(
      meetingUrl(externalId),
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(buildZoomUpdateBody(input)),
      },
      'meeting update',
    );
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
      this.logger.warn(`Zoom meeting deletion failed: ${this.errorMessage(error)}`);
    }
  }

  private async fetchIdentity(accessToken: string): Promise<MeetingAccountIdentity> {
    const response = await this.request(
      USERINFO_URL,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      'account identity lookup',
    );
    const data = (await response.json()) as ZoomUserInfoResponse;
    return parseZoomUserInfo(data);
  }

  private async postToken(params: Record<string, string>, operation: string): Promise<ZoomTokenResponse> {
    let response: Response;
    try {
      response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: this.basicAuthHeader(),
        },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new RetryableProviderError(`${operation} endpoint was unreachable`);
    }
    const data = (await response.json().catch(() => ({}))) as ZoomTokenResponse;
    if (!response.ok) {
      if (isRetryableStatus(response.status)) {
        throw new RetryableProviderError(
          `${operation} failed with status ${String(response.status)}`,
          parseRetryAfter(response.headers.get('retry-after')),
          response.status,
        );
      }
      // `invalid_grant` is Zoom's signal that the refresh token was revoked,
      // expired, or already consumed by a concurrent refresh (single-use
      // rotation) — surfaced as reconnect-required so `getUsableAccount`
      // marks the account `revoked` rather than merely `expired`.
      if (data.error === 'invalid_grant') {
        throw new UnauthorizedException(
          biBody('This meeting account needs to be reconnected', 'يجب إعادة ربط حساب الاجتماعات هذا'),
        );
      }
      this.logger.error(`Zoom ${operation} failed: ${JSON.stringify(data).slice(0, 500)}`);
      throw this.unavailable(`${operation} failed`);
    }
    return data;
  }

  private async request(url: string, init: RequestInit, operation: string): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      throw new RetryableProviderError(`${operation} endpoint was unreachable`);
    }
    if (!response.ok) {
      if (isRetryableStatus(response.status)) {
        throw new RetryableProviderError(
          `${operation} failed with status ${String(response.status)}`,
          parseRetryAfter(response.headers.get('retry-after')),
          response.status,
        );
      }
      const bodyText = await response.text().catch(() => '');
      this.logger.error(`Zoom ${operation} failed with status ${String(response.status)}: ${bodyText.slice(0, 500)}`);
      if (response.status === 401) {
        throw new UnauthorizedException(
          biBody('This meeting account needs to be reconnected', 'يجب إعادة ربط حساب الاجتماعات هذا'),
        );
      }
      throw this.unavailable(`${operation} failed`);
    }
    return response;
  }

  private basicAuthHeader(): string {
    return `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`;
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) throw this.unavailable('configuration is incomplete');
  }

  private unavailable(reason: string): InternalServerErrorException {
    this.logger.error(`Zoom provider unavailable: ${reason}`);
    return new InternalServerErrorException(
      biBody('This meeting provider is not available', 'مزود الاجتماعات هذا غير متاح'),
    );
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'unknown error';
  }
}
