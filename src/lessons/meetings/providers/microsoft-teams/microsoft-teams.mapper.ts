import { BadRequestException } from '@nestjs/common';

import type {
  CreateMeetingInput,
  CreateMeetingResult,
  MeetingAccountIdentity,
  MeetingTokenSet,
  UpdateMeetingInput,
} from '../meeting-provider.interface';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw malformed(field);
  return value;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw malformed(field);
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function malformed(field: string): BadRequestException {
  return new BadRequestException(`Malformed Microsoft Teams response field: ${field}`);
}

/**
 * Parses the Microsoft identity platform v2.0 token endpoint response (used
 * by both exchange and refresh). Unlike Zoom, Microsoft does not guarantee a
 * new refresh token on every call — an absent one here means "unchanged",
 * the same tolerant reading as Google's mapper.
 */
export function parseMicrosoftTokenResponse(data: unknown): MeetingTokenSet {
  const body = record(data, 'token response');
  const accessToken = stringValue(body['access_token'], 'access_token');
  const refreshToken = optionalString(body['refresh_token']);
  const expiresInRaw = body['expires_in'];
  const expiresIn = typeof expiresInRaw === 'number' ? expiresInRaw : Number(expiresInRaw);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw malformed('expires_in');
  const scopeValue = optionalString(body['scope']);
  const scopes = scopeValue ? scopeValue.split(' ').filter((s) => s !== '') : [];
  return {
    accessToken,
    refreshToken,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
    scopes,
  };
}

/** Parses `GET /v1.0/me` used to identify which work/school account was connected. `mail` is absent for some tenants — falls back to `userPrincipalName`. */
export function parseMicrosoftUserInfo(data: unknown): MeetingAccountIdentity {
  const body = record(data, 'user response');
  return {
    providerAccountId: stringValue(body['id'], 'id'),
    providerAccountEmail: optionalString(body['mail']) ?? optionalString(body['userPrincipalName']),
    displayName: optionalString(body['displayName']),
  };
}

/**
 * `createOrGet` body. Start/end are UTC ISO 8601 (the `Z` suffix
 * `toISOString()` already produces) — unlike Google/Zoom, the endpoint takes
 * no separate timezone field, so `input.timezone` is not sent. `externalId` is
 * the per-request idempotency key: a repeated call returns the existing
 * meeting instead of creating a duplicate (AD-8).
 */
export function buildTeamsMeetingBody(input: CreateMeetingInput): Record<string, unknown> {
  return {
    externalId: input.idempotencyKey,
    subject: input.topic,
    startDateTime: input.startAt.toISOString(),
    endDateTime: input.endAt.toISOString(),
  };
}

export function buildTeamsUpdateBody(input: UpdateMeetingInput): Record<string, unknown> {
  return {
    subject: input.topic,
    startDateTime: input.startAt.toISOString(),
    endDateTime: input.endAt.toISOString(),
  };
}

/**
 * Teams has a single `joinWebUrl` used by both organizer and attendees (no
 * separate host URL like Zoom's `start_url`) — `hostUrl` is therefore always
 * null. `passcode` comes from `audioConferencing.conferenceId` (the phone
 * dial-in PIN) when the tenant has audio conferencing enabled.
 */
export function parseTeamsMeeting(data: unknown): CreateMeetingResult {
  const body = record(data, 'meeting');
  const joinUrl = optionalString(body['joinWebUrl']) ?? optionalString(body['joinUrl']);
  if (!joinUrl) throw malformed('joinWebUrl');
  const audio = isRecord(body['audioConferencing']) ? body['audioConferencing'] : undefined;
  return {
    externalId: stringValue(body['id'], 'id'),
    joinUrl,
    hostUrl: null,
    passcode: audio ? optionalString(audio['conferenceId']) : null,
  };
}
