import type { MeetingProvider as MeetingProviderName } from '../../entities/meeting-provider.enum';

export const MEETING_PROVIDERS = Symbol('MEETING_PROVIDERS');

export interface MeetingTokenSet {
  accessToken: string;
  /** Absent when the provider did not (re-)issue one — see AD refresh-token notes. */
  refreshToken?: string | null;
  expiresAt: Date;
  scopes: string[];
}

export interface MeetingAccountIdentity {
  providerAccountId: string;
  providerAccountEmail: string | null;
  displayName: string | null;
}

export interface CreateMeetingInput {
  accessToken: string;
  topic: string;
  startAt: Date;
  endAt: Date;
  /** IANA timezone, e.g. "Africa/Cairo" — see `app-timezone.util.ts`. */
  timezone: string;
  /** Deterministic per-session key so a retried call cannot create a duplicate meeting. */
  idempotencyKey: string;
}

export interface UpdateMeetingInput {
  topic: string;
  startAt: Date;
  endAt: Date;
  /** IANA timezone, e.g. "Africa/Cairo". */
  timezone: string;
}

export interface CreateMeetingResult {
  externalId: string;
  joinUrl: string;
  /** Teacher-only start URL (e.g. Zoom `start_url`) — never exposed to a student. */
  hostUrl?: string | null;
  passcode?: string | null;
}

export interface MeetingProviderConfigurationStatus {
  enabled: boolean;
  configured: boolean;
}

/**
 * Provider-agnostic contract for a meeting platform, mirroring
 * `PaymentGateway` (see `payment-gateway.interface.ts`). Ships in Phase 3 with
 * zero concrete implementations — each provider (Google Meet, Zoom, Microsoft
 * Teams) is added later without touching the lesson or booking domain.
 */
export interface MeetingProviderClient {
  readonly name: MeetingProviderName;
  isConfigured(): boolean;
  getConfigurationStatus(): MeetingProviderConfigurationStatus;
  buildAuthorizeUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<MeetingTokenSet & MeetingAccountIdentity>;
  /** May return a NEW refresh token (e.g. Zoom rotates on every refresh) — callers must persist it. */
  refresh(refreshToken: string): Promise<MeetingTokenSet>;
  revoke(tokens: { accessToken: string; refreshToken?: string | null }): Promise<void>;
  createMeeting(input: CreateMeetingInput): Promise<CreateMeetingResult>;
  /**
   * Reschedules an existing meeting. Unlike `deleteMeeting` this THROWS on
   * failure (`RetryableProviderError` for transient ones) so the sync job can
   * retry and the teacher can be told the provider still has the old time.
   */
  updateMeeting(accessToken: string, externalId: string, input: UpdateMeetingInput): Promise<void>;
  deleteMeeting(accessToken: string, externalId: string): Promise<void>;
}
